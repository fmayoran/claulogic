-- Categorías, almacenes, histórico de movimientos, ajustes por diferencia y costos con historial.
--
-- Se aplicó con la base vacía (0 productos, 0 ubicaciones), por eso las columnas nuevas pueden
-- entrar NOT NULL sin default. Si esto se corriera sobre datos, falla ruidosamente en vez de
-- dejar productos sin categoría o ubicaciones sin almacén.

-- ── Inmutabilidad genérica ───────────────────────────────────────────────────────────────────
-- Mismo criterio que el libro mayor, para los otros registros históricos de esta migración.
CREATE OR REPLACE FUNCTION logic.inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es un registro histórico: no se edita, no se borra ni se vacía.', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

-- ── Categorías ───────────────────────────────────────────────────────────────────────────────
-- Tabla y no texto libre: con texto libre "Lácteos", "lacteos" y "Lacteos " son tres categorías
-- y ningún listado por categoría vuelve a cerrar.
CREATE TABLE logic.categoria (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     text NOT NULL CHECK (btrim(nombre) <> ''),
  activa     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categoria_nombre_ux ON logic.categoria (lower(btrim(nombre)));

ALTER TABLE logic.producto DROP COLUMN categoria;
ALTER TABLE logic.producto ADD COLUMN categoria_id uuid NOT NULL REFERENCES logic.categoria(id);
CREATE INDEX producto_categoria_ix ON logic.producto (categoria_id);

-- La unidad base no se cambia una vez que el producto tiene historia: "500" en g pasaría a ser
-- 500 kg en todos los movimientos y recetas de un saque, sin que ningún número cambie.
CREATE OR REPLACE FUNCTION logic.unidad_base_fija() RETURNS trigger AS $$
BEGIN
  IF NEW.unidad_base IS DISTINCT FROM OLD.unidad_base AND (
       EXISTS (SELECT 1 FROM logic.movimiento  WHERE producto_id = OLD.id) OR
       EXISTS (SELECT 1 FROM logic.receta_item WHERE producto_id = OLD.id) OR
       EXISTS (SELECT 1 FROM logic.receta      WHERE producto_id = OLD.id)) THEN
    RAISE EXCEPTION 'El producto ya tiene movimientos o recetas: cambiar la unidad base '
                    'reinterpretaría todas sus cantidades.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER producto_unidad_base_fija BEFORE UPDATE OF unidad_base ON logic.producto
  FOR EACH ROW EXECUTE FUNCTION logic.unidad_base_fija();

-- ── Almacenes ────────────────────────────────────────────────────────────────────────────────
-- El almacén es el lugar físico (depósito central, cocina de la sucursal); la ubicación es lo que
-- hay adentro (heladera 2, cámara, estantería de secos). El stock se mueve entre ubicaciones y se
-- suma por almacén.
CREATE TABLE logic.almacen (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     text NOT NULL CHECK (btrim(nombre) <> ''),
  direccion  text,
  notas      text,
  activo     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX almacen_nombre_ux ON logic.almacen (lower(btrim(nombre)));

ALTER TABLE logic.ubicacion ADD COLUMN almacen_id uuid NOT NULL REFERENCES logic.almacen(id);
-- "Heladera 1" puede existir en dos almacenes: el nombre es único dentro del almacén.
ALTER TABLE logic.ubicacion DROP CONSTRAINT ubicacion_nombre_key;
ALTER TABLE logic.ubicacion ADD CONSTRAINT ubicacion_almacen_nombre_key UNIQUE (almacen_id, nombre);

CREATE VIEW logic.stock_almacen AS
SELECT u.almacen_id, s.producto_id, SUM(s.cantidad) AS cantidad
  FROM logic.stock s
  JOIN logic.ubicacion u ON u.id = s.ubicacion_id
 GROUP BY u.almacen_id, s.producto_id
HAVING SUM(s.cantidad) <> 0;

-- ── Histórico de movimientos ─────────────────────────────────────────────────────────────────
-- Un movimiento se anula una sola vez: dos anulaciones del mismo revierten el doble.
CREATE UNIQUE INDEX movimiento_anula_ux ON logic.movimiento (anula_a) WHERE anula_a IS NOT NULL;

-- El libro mayor leído por una persona: nombres en vez de ids, y el sentido explícito.
CREATE VIEW logic.historial_movimiento AS
SELECT m.id, m.ocurrido_en, m.tipo,
       CASE WHEN m.origen_id  IS NULL THEN 'entrada'
            WHEN m.destino_id IS NULL THEN 'salida'
            ELSE 'traslado' END                      AS sentido,
       m.producto_id, p.codigo AS producto_codigo, p.nombre AS producto,
       c.nombre AS categoria, p.unidad_base,
       m.lote_id, l.codigo AS lote, l.vencimiento,
       m.cantidad_base,
       m.origen_id,  uo.nombre AS origen,  ao.nombre AS origen_almacen,
       m.destino_id, ud.nombre AS destino, ad.nombre AS destino_almacen,
       m.motivo, m.referencia, m.registrado_por, m.anula_a,
       an.id AS anulado_por
  FROM logic.movimiento m
  JOIN logic.producto   p  ON p.id  = m.producto_id
  JOIN logic.categoria  c  ON c.id  = p.categoria_id
  LEFT JOIN logic.lote      l  ON l.id  = m.lote_id
  LEFT JOIN logic.ubicacion uo ON uo.id = m.origen_id
  LEFT JOIN logic.almacen   ao ON ao.id = uo.almacen_id
  LEFT JOIN logic.ubicacion ud ON ud.id = m.destino_id
  LEFT JOIN logic.almacen   ad ON ad.id = ud.almacen_id
  LEFT JOIN logic.movimiento an ON an.anula_a = m.id;

-- ── Ajustes por diferencia ───────────────────────────────────────────────────────────────────
-- Se cuenta lo que hay y la base asienta la DIFERENCIA con lo que dice el sistema. Nadie escribe
-- "el stock es 12": se escribe "conté 12", y el movimiento por +2 o -3 sale solo.
-- El conteo queda registrado aunque la diferencia sea cero: "contamos y cerraba" también es un dato.
CREATE TABLE logic.ajuste (
  id                bigserial PRIMARY KEY,
  ocurrido_en       timestamptz NOT NULL DEFAULT now(),
  producto_id       uuid NOT NULL REFERENCES logic.producto(id),
  lote_id           uuid REFERENCES logic.lote(id),
  ubicacion_id      uuid NOT NULL REFERENCES logic.ubicacion(id),
  cantidad_sistema  numeric(16,4) NOT NULL,
  cantidad_contada  numeric(16,4) NOT NULL CHECK (cantidad_contada >= 0),
  diferencia        numeric(16,4) GENERATED ALWAYS AS (cantidad_contada - cantidad_sistema) STORED,
  movimiento_id     bigint REFERENCES logic.movimiento(id),   -- NULL cuando la diferencia es cero
  motivo            text NOT NULL CHECK (btrim(motivo) <> ''),
  registrado_por    text
);
CREATE INDEX ajuste_producto_ix ON logic.ajuste (producto_id, ocurrido_en DESC);
CREATE TRIGGER ajuste_sin_update BEFORE UPDATE OR DELETE ON logic.ajuste
  FOR EACH ROW EXECUTE FUNCTION logic.inmutable();
CREATE TRIGGER ajuste_sin_truncate BEFORE TRUNCATE ON logic.ajuste
  FOR EACH STATEMENT EXECUTE FUNCTION logic.inmutable();

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

  -- Dos conteos simultáneos del mismo producto calcularían la diferencia contra el mismo stock y
  -- la asentarían dos veces. El lock los pone en fila hasta el fin de la transacción.
  PERFORM pg_advisory_xact_lock(hashtext('logic.ajuste:' || p_producto::text));

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

-- ── Costos ───────────────────────────────────────────────────────────────────────────────────
-- Costo VIGENTE por unidad base. A diferencia del stock, éste sí se guarda: no se deriva de las
-- compras porque actualizarlo es una DECISIÓN (una compra de oferta no tiene por qué mover el
-- costo de las recetas). Lo que no se pierde es la historia: cada cambio queda asentado.
ALTER TABLE logic.producto ADD COLUMN costo_base numeric(16,6) CHECK (costo_base IS NULL OR costo_base >= 0);

CREATE TABLE logic.costo_historial (
  id              bigserial PRIMARY KEY,
  producto_id     uuid NOT NULL REFERENCES logic.producto(id),
  cambiado_en     timestamptz NOT NULL DEFAULT now(),
  costo_anterior  numeric(16,6),
  costo_nuevo     numeric(16,6),
  origen          text NOT NULL CHECK (origen IN ('alta','manual','compra')),
  compra_item_id  uuid REFERENCES logic.compra_item(id),
  registrado_por  text,
  CHECK (origen <> 'compra' OR compra_item_id IS NOT NULL)
);
CREATE INDEX costo_historial_ix ON logic.costo_historial (producto_id, cambiado_en DESC);
CREATE TRIGGER costo_historial_sin_update BEFORE UPDATE OR DELETE ON logic.costo_historial
  FOR EACH ROW EXECUTE FUNCTION logic.inmutable();
CREATE TRIGGER costo_historial_sin_truncate BEFORE TRUNCATE ON logic.costo_historial
  FOR EACH STATEMENT EXECUTE FUNCTION logic.inmutable();

-- El historial lo escribe un trigger y no la aplicación: un UPDATE desde pgadmin también queda
-- asentado. Quien cambia el costo puede dejar contexto con set_config (local a la transacción):
--   logic.costo_origen = 'compra' | 'manual',  logic.compra_item = <uuid>,  logic.usuario = <quién>
CREATE OR REPLACE FUNCTION logic.registrar_costo() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.costo_base IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.costo_base IS NOT DISTINCT FROM OLD.costo_base THEN RETURN NEW; END IF;
  INSERT INTO logic.costo_historial (producto_id, costo_anterior, costo_nuevo, origen,
                                     compra_item_id, registrado_por)
  VALUES (NEW.id,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.costo_base END,
          NEW.costo_base,
          CASE WHEN TG_OP = 'INSERT' THEN 'alta'
               ELSE COALESCE(NULLIF(current_setting('logic.costo_origen', true), ''), 'manual') END,
          NULLIF(current_setting('logic.compra_item', true), '')::uuid,
          NULLIF(current_setting('logic.usuario', true), ''));
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER producto_costo AFTER INSERT OR UPDATE OF costo_base ON logic.producto
  FOR EACH ROW EXECUTE FUNCTION logic.registrar_costo();

-- Cada renglón de compra trae su costo por unidad base, que es contra lo que se compara el
-- vigente al recibir. La decisión queda escrita: 'actualizado' o 'mantenido', nunca implícita.
ALTER TABLE logic.compra_item
  ADD COLUMN costo_base numeric(16,6) GENERATED ALWAYS AS (precio_total / cantidad_base) STORED,
  ADD COLUMN costo_decision text CHECK (costo_decision IN ('actualizado','mantenido'));
