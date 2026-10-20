-- Unidades configurables, recepción de compras, producción y lotes disponibles (FEFO).

-- ── Unidades configurables ───────────────────────────────────────────────────────────────────
-- La unidad de REFERENCIA es la que se usa para mostrar costos ("$1.200 el kg"). Se marca a mano
-- y no se deduce como "la más grande": si alguien da de alta "bolsa 25 kg", los costos de todos
-- los productos en gramos pasarían a mostrarse por bolsa.
ALTER TABLE logic.unidad ADD COLUMN es_referencia boolean NOT NULL DEFAULT false;
UPDATE logic.unidad SET es_referencia = true WHERE codigo IN ('kg', 'l', 'u');
CREATE UNIQUE INDEX unidad_referencia_ux ON logic.unidad (magnitud) WHERE es_referencia;

-- Una unidad en uso no cambia de magnitud ni de factor: las cantidades guardadas en ella pasarían
-- a significar otra cosa respecto de las demás. Las cinco del sistema (g, kg, ml, l, u) no se
-- tocan nunca: son el ancla de cada magnitud y contra ellas se definen todas las demás.
CREATE OR REPLACE FUNCTION logic.unidad_fija() RETURNS trigger AS $$
BEGIN
  IF (NEW.magnitud IS DISTINCT FROM OLD.magnitud OR NEW.factor_si IS DISTINCT FROM OLD.factor_si) THEN
    IF OLD.codigo IN ('g', 'kg', 'ml', 'l', 'u') THEN
      RAISE EXCEPTION 'La unidad % es del sistema: no se le cambia magnitud ni equivalencia.', OLD.codigo;
    END IF;
    IF EXISTS (SELECT 1 FROM logic.producto WHERE unidad_base = OLD.codigo) THEN
      RAISE EXCEPTION 'La unidad % es la base de algún producto: no se le cambia magnitud ni factor.', OLD.codigo;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER unidad_fija BEFORE UPDATE ON logic.unidad
  FOR EACH ROW EXECUTE FUNCTION logic.unidad_fija();

-- ── Lote perecedero con vencimiento ──────────────────────────────────────────────────────────
-- El núcleo lo anunciaba ("lo exige un CHECK en logic.lote") pero el CHECK nunca se escribió: un
-- CHECK no puede mirar otra tabla. Lo hace este trigger. Sin vencimiento, el lote de un
-- perecedero no sirve para FEFO ni para contestar qué se vence esta semana.
CREATE OR REPLACE FUNCTION logic.lote_con_vencimiento() RETURNS trigger AS $$
BEGIN
  IF NEW.vencimiento IS NULL AND (SELECT perecedero FROM logic.producto WHERE id = NEW.producto_id) THEN
    RAISE EXCEPTION 'El producto es perecedero: el lote necesita fecha de vencimiento.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lote_con_vencimiento BEFORE INSERT OR UPDATE OF vencimiento ON logic.lote
  FOR EACH ROW EXECUTE FUNCTION logic.lote_con_vencimiento();

-- ── Vínculo de cada movimiento con su documento ──────────────────────────────────────────────
-- `referencia` es texto libre para el remito; estos vínculos son los que permiten preguntar con
-- certeza "este elaborado, ¿con qué partidas se hizo?" o "esta compra, ¿a dónde fue?".
-- (Agregar columnas no reescribe el pasado: las filas existentes quedan con NULL.)
ALTER TABLE logic.movimiento
  ADD COLUMN compra_item_id uuid REFERENCES logic.compra_item(id),
  ADD COLUMN produccion_id  uuid REFERENCES logic.produccion(id);
CREATE INDEX movimiento_compra_item_ix ON logic.movimiento (compra_item_id) WHERE compra_item_id IS NOT NULL;
CREATE INDEX movimiento_produccion_ix  ON logic.movimiento (produccion_id)  WHERE produccion_id  IS NOT NULL;

-- ── Compras: una compra recibida no se edita ─────────────────────────────────────────────────
ALTER TABLE logic.compra ADD COLUMN recibida_en timestamptz;

CREATE OR REPLACE FUNCTION logic.compra_cerrada() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.estado = 'recibida' THEN
    RAISE EXCEPTION 'Una compra recibida no se borra: ya generó movimientos de stock.';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.estado IN ('recibida', 'anulada') AND NEW.estado <> OLD.estado THEN
    RAISE EXCEPTION 'La compra está %: no cambia de estado.', OLD.estado;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER compra_cerrada BEFORE UPDATE OR DELETE ON logic.compra
  FOR EACH ROW EXECUTE FUNCTION logic.compra_cerrada();

-- Los renglones de una compra recibida o anulada quedan como están: son el respaldo de los
-- movimientos que generaron y de la decisión de costo que se tomó.
CREATE OR REPLACE FUNCTION logic.compra_item_cerrado() RETURNS trigger AS $$
DECLARE est text;
BEGIN
  SELECT estado INTO est FROM logic.compra
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.compra_id ELSE NEW.compra_id END;
  IF est IN ('recibida', 'anulada') THEN
    RAISE EXCEPTION 'La compra está %: sus renglones no se modifican.', est;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER compra_item_cerrado BEFORE INSERT OR UPDATE OR DELETE ON logic.compra_item
  FOR EACH ROW EXECUTE FUNCTION logic.compra_item_cerrado();

-- ── Producción ───────────────────────────────────────────────────────────────────────────────
-- De qué almacén se consumieron los ingredientes, y el costo que resultó (va también al lote).
ALTER TABLE logic.produccion
  ADD COLUMN almacen_id uuid REFERENCES logic.almacen(id),
  ADD COLUMN costo_total numeric(16,2) CHECK (costo_total IS NULL OR costo_total >= 0);

-- ── Lock de stock por producto ───────────────────────────────────────────────────────────────
-- Toda operación que DECIDE en base al stock actual (un ajuste calcula la diferencia, una
-- producción elige lotes) toma este lock, para que dos de ellas no decidan sobre el mismo número.
-- Se libera solo al terminar la transacción.
CREATE OR REPLACE FUNCTION logic.bloquear_stock(p_producto uuid) RETURNS void AS $$
  SELECT pg_advisory_xact_lock(hashtext('logic.stock:' || p_producto::text));
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION logic.ajustar_stock(
  p_producto uuid, p_ubicacion uuid, p_contada numeric, p_motivo text,
  p_lote uuid DEFAULT NULL, p_usuario text DEFAULT NULL
) RETURNS bigint AS $$
DECLARE
  v_contada numeric(16,4) := p_contada;
  v_sistema numeric(16,4);
  v_dif     numeric(16,4);
  v_mov     bigint;
  v_ajuste  bigint;
BEGIN
  IF v_contada IS NULL OR v_contada < 0 THEN
    RAISE EXCEPTION 'La cantidad contada tiene que ser cero o más.';
  END IF;
  IF p_lote IS NULL AND (SELECT perecedero FROM logic.producto WHERE id = p_producto) THEN
    RAISE EXCEPTION 'El producto es perecedero: el ajuste se hace por lote.';
  END IF;

  PERFORM logic.bloquear_stock(p_producto);

  SELECT COALESCE(SUM(cantidad), 0) INTO v_sistema
    FROM logic.stock
   WHERE producto_id = p_producto AND ubicacion_id = p_ubicacion
     AND lote_id IS NOT DISTINCT FROM p_lote;

  v_dif := v_contada - v_sistema;
  IF v_dif > 0 THEN
    INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, destino_id, motivo, registrado_por)
    VALUES ('ajuste', p_producto, p_lote, v_dif, p_ubicacion, p_motivo, p_usuario)
    RETURNING id INTO v_mov;
  ELSIF v_dif < 0 THEN
    INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, origen_id, motivo, registrado_por)
    VALUES ('ajuste', p_producto, p_lote, -v_dif, p_ubicacion, p_motivo, p_usuario)
    RETURNING id INTO v_mov;
  END IF;

  INSERT INTO logic.ajuste (producto_id, lote_id, ubicacion_id, cantidad_sistema, cantidad_contada,
                            movimiento_id, motivo, registrado_por)
  VALUES (p_producto, p_lote, p_ubicacion, v_sistema, v_contada, v_mov, p_motivo, p_usuario)
  RETURNING id INTO v_ajuste;
  RETURN v_ajuste;
END $$ LANGUAGE plpgsql;

-- ── Lo que hay para usar, en orden FEFO ──────────────────────────────────────────────────────
-- Stock positivo por lote y ubicación, con lo necesario para elegir: sale primero lo que vence
-- primero (los lotes sin vencimiento, al final).
CREATE VIEW logic.lote_disponible AS
SELECT s.producto_id, s.lote_id, l.codigo AS lote, l.vencimiento, l.costo_base AS costo_lote,
       s.ubicacion_id, u.nombre AS ubicacion, u.almacen_id, s.cantidad
  FROM logic.stock s
  JOIN logic.ubicacion u ON u.id = s.ubicacion_id
  LEFT JOIN logic.lote l ON l.id = s.lote_id
 WHERE s.cantidad > 0;
