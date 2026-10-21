-- Fase 2: comprobantes de proveedor (facturas, notas de crédito y de débito) y cuenta corriente.
--
-- Esquema `fin`, aparte de `logic`: un dump o un permiso sobre la plata no tiene por qué arrastrar
-- el stock, ni al revés.
--
-- LA MISMA DECISIÓN QUE EL STOCK: LA DEUDA NO SE GUARDA, SE DERIVA. No hay una columna "saldo" en
-- el proveedor. El saldo sale de sumar `fin.movimiento_cc`, un libro mayor inmutable: registrar un
-- comprobante asienta un movimiento, anularlo asienta el inverso, y la fase 3 sumará los pagos.
-- Cuando el proveedor diga "me deben X", cada peso de la diferencia tiene su comprobante.
--
-- La razón social es responsable inscripta (decisión de Fer): recibe facturas A con IVA
-- discriminado, que es crédito fiscal; B y C vienen sin discriminar.
CREATE SCHEMA fin;

-- ── Proveedor: datos fiscales ────────────────────────────────────────────────────────────────
-- El proveedor sigue en `logic` (lo usan los lotes y las compras); acá se le agregan los datos que
-- necesita la administración.
ALTER TABLE logic.proveedor
  ADD COLUMN condicion_iva text CHECK (condicion_iva IN ('responsable_inscripto','monotributo','exento','no_categorizado')),
  ADD COLUMN plazo_pago_dias int CHECK (plazo_pago_dias IS NULL OR plazo_pago_dias BETWEEN 0 AND 365);

-- CUIT: 11 dígitos con dígito verificador módulo 11. Un CUIT mal tipeado en una factura A es un
-- crédito fiscal que el contador no va a poder computar.
CREATE OR REPLACE FUNCTION fin.cuit_valido(c text) RETURNS boolean AS $$
DECLARE
  pesos int[] := ARRAY[5,4,3,2,7,6,5,4,3,2];
  s int := 0; dv int;
BEGIN
  IF c !~ '^\d{11}$' THEN RETURN false; END IF;
  FOR i IN 1..10 LOOP s := s + substr(c, i, 1)::int * pesos[i]; END LOOP;
  dv := 11 - (s % 11);
  IF dv = 11 THEN dv := 0; ELSIF dv = 10 THEN dv := 9; END IF;
  RETURN dv = substr(c, 11, 1)::int;
END $$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- Se guarda sin guiones: "30-12345678-9" y "30123456789" son el mismo CUIT y tienen que chocar
-- en el índice único.
CREATE OR REPLACE FUNCTION logic.proveedor_cuit() RETURNS trigger AS $$
BEGIN
  IF NEW.cuit IS NOT NULL THEN
    NEW.cuit := regexp_replace(NEW.cuit, '\D', '', 'g');
    IF NEW.cuit = '' THEN NEW.cuit := NULL;
    ELSIF NOT fin.cuit_valido(NEW.cuit) THEN
      RAISE EXCEPTION 'El CUIT % no es válido (revisá los dígitos).', NEW.cuit;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER proveedor_cuit BEFORE INSERT OR UPDATE OF cuit ON logic.proveedor
  FOR EACH ROW EXECUTE FUNCTION logic.proveedor_cuit();
CREATE UNIQUE INDEX proveedor_cuit_ux ON logic.proveedor (cuit) WHERE cuit IS NOT NULL;

-- Alícuota de IVA habitual del producto, para proponerla al cargar la factura. En gastronomía
-- conviven 21 y 10,5 (carnes, frutas, verduras, harinas): equivocarse cambia el crédito fiscal.
ALTER TABLE logic.producto ADD COLUMN alicuota_iva numeric(5,2) DEFAULT 21
  CHECK (alicuota_iva IS NULL OR alicuota_iva IN (0, 2.5, 5, 10.5, 21, 27));

-- ── Permiso de finanzas ──────────────────────────────────────────────────────────────────────
-- Global, como el de administrador: la deuda con los proveedores es de la administración central,
-- no de una sede. Un operador de cocina no la ve.
ALTER TABLE org.usuario ADD COLUMN finanzas boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION org.exigir_finanzas() RETURNS void AS $$
DECLARE v_usuario text := org.usuario_actual();
BEGIN
  IF v_usuario IS NULL THEN
    IF current_setting('logic.origen', true) = 'app' THEN
      RAISE EXCEPTION 'No hay usuario identificado: volvé a iniciar sesión.';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM org.usuario WHERE usuario = v_usuario AND activo AND (es_admin OR finanzas)) THEN
    RAISE EXCEPTION 'Hace falta permiso de finanzas para esto.';
  END IF;
END $$ LANGUAGE plpgsql STABLE;

-- ── Comprobantes ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE fin.comprobante (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id      uuid NOT NULL REFERENCES logic.proveedor(id),
  tipo              text NOT NULL CHECK (tipo IN ('factura','nota_debito','nota_credito')),
  letra             text NOT NULL CHECK (letra IN ('A','B','C','M')),
  punto_venta       int NOT NULL CHECK (punto_venta BETWEEN 1 AND 99999),
  numero            bigint NOT NULL CHECK (numero BETWEEN 1 AND 99999999),
  fecha             date NOT NULL,
  vencimiento       date,
  cae               text CHECK (cae IS NULL OR cae ~ '^\d{14}$'),
  asociado_id       uuid REFERENCES fin.comprobante(id),   -- la factura que corrige una nota
  notas             text,
  estado            text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador','registrado','anulado')),
  -- Al registrar se fijan el total impreso y la diferencia de redondeo contra lo calculado.
  total             numeric(16,2) CHECK (total IS NULL OR total >= 0),
  ajuste_redondeo   numeric(16,2) NOT NULL DEFAULT 0 CHECK (abs(ajuste_redondeo) <= 1),
  creado_por        text DEFAULT org.usuario_actual(),
  creado_en         timestamptz NOT NULL DEFAULT now(),
  registrado_por    text,
  registrado_en     timestamptz,
  anulado_por       text,
  anulado_en        timestamptz,
  motivo_anulacion  text,
  CHECK (vencimiento IS NULL OR vencimiento >= fecha),
  CHECK (estado <> 'registrado' OR total IS NOT NULL),
  CHECK (estado <> 'anulado' OR motivo_anulacion IS NOT NULL)
);
-- El mismo comprobante no se carga dos veces. Un anulado no cuenta: se puede volver a cargar bien.
CREATE UNIQUE INDEX comprobante_numero_ux ON fin.comprobante (proveedor_id, tipo, letra, punto_venta, numero)
  WHERE estado <> 'anulado';
CREATE INDEX comprobante_fecha_ix ON fin.comprobante (fecha DESC);

CREATE TABLE fin.comprobante_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comprobante_id   uuid NOT NULL REFERENCES fin.comprobante(id) ON DELETE CASCADE,
  orden            int NOT NULL DEFAULT 0,
  producto_id      uuid REFERENCES logic.producto(id),           -- NULL: flete, servicio, otro
  compra_item_id   uuid REFERENCES logic.compra_item(id),
  descripcion      text NOT NULL CHECK (btrim(descripcion) <> ''),
  unidad           text,                                          -- como figura: "bolsa 25 kg", "kg"
  cantidad         numeric(16,4) NOT NULL CHECK (cantidad > 0),
  precio_unitario  numeric(16,4) NOT NULL CHECK (precio_unitario >= 0),   -- neto de IVA en A y M
  descuento_pct    numeric(5,2) NOT NULL DEFAULT 0 CHECK (descuento_pct >= 0 AND descuento_pct < 100),
  -- NULL = exento o no gravado. En B y C siempre NULL: el IVA viene incluido y no se discrimina.
  alicuota         numeric(5,2) CHECK (alicuota IS NULL OR alicuota IN (0, 2.5, 5, 10.5, 21, 27)),
  importe          numeric(16,2) GENERATED ALWAYS AS (round(cantidad * precio_unitario * (1 - descuento_pct / 100), 2)) STORED
);
CREATE INDEX comprobante_item_ix ON fin.comprobante_item (comprobante_id, orden);

-- Percepciones e impuestos del pie de la factura.
CREATE TABLE fin.comprobante_tributo (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comprobante_id  uuid NOT NULL REFERENCES fin.comprobante(id) ON DELETE CASCADE,
  tipo            text NOT NULL CHECK (tipo IN ('percepcion_iva','percepcion_iibb','percepcion_ganancias','impuesto_interno','otro')),
  jurisdiccion    text,            -- para IIBB: CABA, Buenos Aires…
  descripcion     text,
  importe         numeric(16,2) NOT NULL CHECK (importe > 0)
);

-- Vínculo con las compras recibidas: referencia, sin control de importes (decisión de Fer).
CREATE TABLE fin.comprobante_compra (
  comprobante_id  uuid NOT NULL REFERENCES fin.comprobante(id) ON DELETE CASCADE,
  compra_id       uuid NOT NULL REFERENCES logic.compra(id),
  PRIMARY KEY (comprobante_id, compra_id)
);

-- ── Totales ──────────────────────────────────────────────────────────────────────────────────
-- El IVA se calcula por alícuota sobre el neto sumado, una sola vez, que es como lo calcula la
-- factura; redondear renglón por renglón se aleja unos centavos del impreso.
CREATE VIEW fin.comprobante_iva AS
SELECT comprobante_id, alicuota, SUM(importe) AS neto, round(SUM(importe) * alicuota / 100, 2) AS iva
  FROM fin.comprobante_item WHERE alicuota IS NOT NULL
 GROUP BY comprobante_id, alicuota;

CREATE VIEW fin.comprobante_totales AS
SELECT c.id AS comprobante_id,
       COALESCE((SELECT SUM(neto) FROM fin.comprobante_iva v WHERE v.comprobante_id = c.id), 0)    AS neto_gravado,
       COALESCE((SELECT SUM(iva)  FROM fin.comprobante_iva v WHERE v.comprobante_id = c.id), 0)    AS iva,
       COALESCE((SELECT SUM(importe) FROM fin.comprobante_item i
                  WHERE i.comprobante_id = c.id AND i.alicuota IS NULL), 0)                         AS no_gravado,
       COALESCE((SELECT SUM(importe) FROM fin.comprobante_tributo t WHERE t.comprobante_id = c.id), 0) AS tributos
  FROM fin.comprobante c;

-- ── Reglas de los comprobantes ───────────────────────────────────────────────────────────────
-- Renglones y tributos se editan sólo en borrador. En B y C no hay alícuota: el IVA no se discrimina.
CREATE OR REPLACE FUNCTION fin.comprobante_detalle_cerrado() RETURNS trigger AS $$
DECLARE c record;
BEGIN
  SELECT estado, letra INTO c FROM fin.comprobante
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.comprobante_id ELSE NEW.comprobante_id END;
  IF c.estado IS NULL THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;  -- cascada del borrado
  IF c.estado <> 'borrador' THEN
    RAISE EXCEPTION 'El comprobante está %: no se modifica. Anulalo y cargalo de nuevo, o hacé una nota de crédito.', c.estado;
  END IF;
  -- Anidado a propósito: PL/pgSQL no corta la evaluación, y NEW.alicuota no existe en los tributos.
  IF TG_TABLE_NAME = 'comprobante_item' AND TG_OP <> 'DELETE' AND c.letra IN ('B','C') THEN
    IF NEW.alicuota IS NOT NULL THEN
      RAISE EXCEPTION 'Un comprobante % no discrimina IVA: sus renglones van sin alícuota.', c.letra;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER comprobante_item_cerrado BEFORE INSERT OR UPDATE OR DELETE ON fin.comprobante_item
  FOR EACH ROW EXECUTE FUNCTION fin.comprobante_detalle_cerrado();
CREATE TRIGGER comprobante_tributo_cerrado BEFORE INSERT OR UPDATE OR DELETE ON fin.comprobante_tributo
  FOR EACH ROW EXECUTE FUNCTION fin.comprobante_detalle_cerrado();
CREATE TRIGGER comprobante_compra_cerrado BEFORE INSERT OR UPDATE OR DELETE ON fin.comprobante_compra
  FOR EACH ROW EXECUTE FUNCTION fin.comprobante_detalle_cerrado();

-- Un registrado sólo pasa a anulado; un anulado no cambia más. Sólo se borra un borrador.
CREATE OR REPLACE FUNCTION fin.comprobante_cerrado() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.estado <> 'borrador' THEN RAISE EXCEPTION 'Sólo se borra un comprobante en borrador; uno registrado se anula.'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.estado = 'anulado' THEN RAISE EXCEPTION 'El comprobante está anulado: no cambia más.'; END IF;
  IF OLD.estado = 'registrado' AND (NEW.estado <> 'anulado' OR
       (NEW.proveedor_id, NEW.tipo, NEW.letra, NEW.punto_venta, NEW.numero, NEW.fecha, NEW.vencimiento, NEW.total, NEW.ajuste_redondeo)
       IS DISTINCT FROM
       (OLD.proveedor_id, OLD.tipo, OLD.letra, OLD.punto_venta, OLD.numero, OLD.fecha, OLD.vencimiento, OLD.total, OLD.ajuste_redondeo)) THEN
    RAISE EXCEPTION 'El comprobante está registrado: no se modifica. Anulalo y cargalo de nuevo, o hacé una nota de crédito.';
  END IF;
  -- Cambiar la letra a B o C con renglones que tienen alícuota dejaría IVA discriminado donde no va.
  IF NEW.letra IN ('B','C') AND EXISTS (SELECT 1 FROM fin.comprobante_item WHERE comprobante_id = NEW.id AND alicuota IS NOT NULL) THEN
    RAISE EXCEPTION 'Un comprobante % no discrimina IVA: quitá las alícuotas de los renglones.', NEW.letra;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER comprobante_cerrado BEFORE UPDATE OR DELETE ON fin.comprobante
  FOR EACH ROW EXECUTE FUNCTION fin.comprobante_cerrado();

-- ── Cuenta corriente: libro mayor ────────────────────────────────────────────────────────────
-- `haber` aumenta lo que se le debe al proveedor (factura, nota de débito); `debe` lo disminuye
-- (nota de crédito, y en la fase 3, pagos). Un solo lado por movimiento.
CREATE TABLE fin.movimiento_cc (
  id              bigserial PRIMARY KEY,
  ocurrido_en     timestamptz NOT NULL DEFAULT now(),
  fecha           date NOT NULL,                        -- la del comprobante, para ordenar la historia
  proveedor_id    uuid NOT NULL REFERENCES logic.proveedor(id),
  tipo            text NOT NULL CHECK (tipo IN ('factura','nota_debito','nota_credito','pago','anulacion')),
  comprobante_id  uuid REFERENCES fin.comprobante(id),
  debe            numeric(16,2) NOT NULL DEFAULT 0 CHECK (debe >= 0),
  haber           numeric(16,2) NOT NULL DEFAULT 0 CHECK (haber >= 0),
  detalle         text,
  anula_a         bigint REFERENCES fin.movimiento_cc(id),
  registrado_por  text DEFAULT org.usuario_actual(),
  CHECK ((debe > 0) <> (haber > 0) OR (debe = 0 AND haber = 0 AND tipo = 'anulacion'))
);
CREATE INDEX movimiento_cc_proveedor_ix ON fin.movimiento_cc (proveedor_id, fecha, id);
CREATE UNIQUE INDEX movimiento_cc_anula_ux ON fin.movimiento_cc (anula_a) WHERE anula_a IS NOT NULL;
CREATE TRIGGER movimiento_cc_sin_update BEFORE UPDATE OR DELETE ON fin.movimiento_cc
  FOR EACH ROW EXECUTE FUNCTION logic.inmutable();
CREATE TRIGGER movimiento_cc_sin_truncate BEFORE TRUNCATE ON fin.movimiento_cc
  FOR EACH STATEMENT EXECUTE FUNCTION logic.inmutable();

CREATE VIEW fin.saldo_proveedor AS
SELECT proveedor_id, SUM(haber - debe) AS saldo, MAX(fecha) AS ultimo_movimiento
  FROM fin.movimiento_cc GROUP BY proveedor_id;

-- ── Registrar y anular ───────────────────────────────────────────────────────────────────────
-- Las dos cosas que mueven la cuenta corriente pasan por acá, en la base: validan, fijan el total
-- y asientan el movimiento en la misma transacción. Así no hay comprobante registrado sin
-- movimiento, ni movimiento sin comprobante.
CREATE OR REPLACE FUNCTION fin.registrar_comprobante(p_id uuid, p_total_impreso numeric) RETURNS void AS $$
DECLARE
  c record; t record; p record;
  calculado numeric(16,2); dif numeric(16,2);
BEGIN
  PERFORM org.exigir_finanzas();
  SELECT * INTO c FROM fin.comprobante WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No existe ese comprobante.'; END IF;
  IF c.estado <> 'borrador' THEN RAISE EXCEPTION 'El comprobante ya está %.', c.estado; END IF;
  IF NOT EXISTS (SELECT 1 FROM fin.comprobante_item WHERE comprobante_id = p_id) THEN
    RAISE EXCEPTION 'El comprobante no tiene renglones.';
  END IF;
  SELECT cuit, condicion_iva, nombre INTO p FROM logic.proveedor WHERE id = c.proveedor_id;
  IF c.letra IN ('A','M') THEN
    IF p.cuit IS NULL THEN RAISE EXCEPTION 'Una factura % necesita el CUIT de %: cargalo en Proveedores.', c.letra, p.nombre; END IF;
    IF p.condicion_iva IS DISTINCT FROM 'responsable_inscripto' AND p.condicion_iva IS NOT NULL THEN
      RAISE EXCEPTION '% no es responsable inscripto: no emite comprobantes %.', p.nombre, c.letra;
    END IF;
  END IF;
  IF c.tipo <> 'factura' AND c.asociado_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM fin.comprobante WHERE id = c.asociado_id AND proveedor_id = c.proveedor_id AND estado = 'registrado') THEN
    RAISE EXCEPTION 'El comprobante asociado no es una factura registrada de este proveedor.';
  END IF;
  SELECT * INTO t FROM fin.comprobante_totales WHERE comprobante_id = p_id;
  calculado := t.neto_gravado + t.iva + t.no_gravado + t.tributos;
  dif := p_total_impreso - calculado;
  IF abs(dif) > 1 THEN
    RAISE EXCEPTION 'El total impreso (%) no coincide con el calculado (%): revisá cantidades, precios y alícuotas.',
      p_total_impreso, calculado;
  END IF;
  UPDATE fin.comprobante SET estado = 'registrado', total = p_total_impreso, ajuste_redondeo = dif,
         registrado_en = now(), registrado_por = org.usuario_actual()
   WHERE id = p_id;
  INSERT INTO fin.movimiento_cc (fecha, proveedor_id, tipo, comprobante_id, debe, haber, detalle)
  VALUES (c.fecha, c.proveedor_id, c.tipo, p_id,
          CASE WHEN c.tipo = 'nota_credito' THEN p_total_impreso ELSE 0 END,
          CASE WHEN c.tipo = 'nota_credito' THEN 0 ELSE p_total_impreso END,
          CASE c.tipo WHEN 'factura' THEN 'Factura' WHEN 'nota_credito' THEN 'Nota de crédito' ELSE 'Nota de débito' END
            || ' ' || c.letra || ' ' || lpad(c.punto_venta::text, 5, '0') || '-' || lpad(c.numero::text, 8, '0'));
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fin.anular_comprobante(p_id uuid, p_motivo text) RETURNS void AS $$
DECLARE c record; m record;
BEGIN
  PERFORM org.exigir_finanzas();
  IF coalesce(btrim(p_motivo), '') = '' THEN RAISE EXCEPTION 'Falta el motivo de la anulación.'; END IF;
  SELECT * INTO c FROM fin.comprobante WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No existe ese comprobante.'; END IF;
  IF c.estado = 'anulado' THEN RAISE EXCEPTION 'El comprobante ya está anulado.'; END IF;
  IF c.estado = 'registrado' THEN
    IF EXISTS (SELECT 1 FROM fin.comprobante WHERE asociado_id = p_id AND estado = 'registrado') THEN
      RAISE EXCEPTION 'Hay notas registradas asociadas a este comprobante: anulalas primero.';
    END IF;
    SELECT * INTO m FROM fin.movimiento_cc WHERE comprobante_id = p_id AND anula_a IS NULL AND tipo <> 'anulacion'
     ORDER BY id LIMIT 1;
    INSERT INTO fin.movimiento_cc (fecha, proveedor_id, tipo, comprobante_id, debe, haber, detalle, anula_a)
    VALUES (current_date, m.proveedor_id, 'anulacion', p_id, m.haber, m.debe, 'Anula: ' || m.detalle || ' — ' || p_motivo, m.id);
  END IF;
  UPDATE fin.comprobante SET estado = 'anulado', anulado_en = now(), anulado_por = org.usuario_actual(), motivo_anulacion = p_motivo
   WHERE id = p_id;
END $$ LANGUAGE plpgsql;

-- ── Vencimientos ─────────────────────────────────────────────────────────────────────────────
-- Lo pendiente por comprobante. Hasta la fase 3 (pagos aplicados a facturas), pendiente = total;
-- las notas de crédito asociadas descuentan de su factura.
CREATE VIEW fin.comprobante_pendiente AS
SELECT c.id AS comprobante_id, c.proveedor_id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha,
       COALESCE(c.vencimiento, c.fecha) AS vencimiento,
       c.total - COALESCE((SELECT SUM(n.total) FROM fin.comprobante n
                            WHERE n.asociado_id = c.id AND n.tipo = 'nota_credito' AND n.estado = 'registrado'), 0) AS pendiente
  FROM fin.comprobante c
 WHERE c.estado = 'registrado' AND c.tipo IN ('factura','nota_debito');
