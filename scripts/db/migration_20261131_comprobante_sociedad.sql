-- Facturas de compra y pagos por sociedad (organización del 07/11/2026: las cuentas y la deuda son de cada sociedad).
--   · Un comprobante de proveedor es de una sociedad (la que figura como receptora): define su libro IVA y su deuda.
--   · Una orden de pago es de una sociedad: aplica sólo comprobantes de esa sociedad y paga desde cuentas de esa sociedad o del
--     grupo (la caja mayor, que es plata del grupo: decisión de Fer).
--   · La cuenta corriente (fin.movimiento_cc) lleva la sociedad de su comprobante o de su orden de pago.
-- Todavía no hay comprobantes ni órdenes de pago cargados: las columnas nacen obligatorias.

ALTER TABLE fin.comprobante ADD COLUMN sociedad_id uuid NOT NULL REFERENCES org.sociedad(id);
ALTER TABLE fin.orden_pago ADD COLUMN sociedad_id uuid NOT NULL REFERENCES org.sociedad(id);
ALTER TABLE fin.movimiento_cc ADD COLUMN sociedad_id uuid REFERENCES org.sociedad(id);
CREATE INDEX comprobante_sociedad_ix ON fin.comprobante (sociedad_id, fecha);

-- La cuenta corriente toma la sociedad de lo que la mueve (las funciones que la asientan no cambian).
CREATE OR REPLACE FUNCTION fin.movimiento_cc_sociedad() RETURNS trigger AS $$
BEGIN
  NEW.sociedad_id := COALESCE(NEW.sociedad_id,
    (SELECT sociedad_id FROM fin.comprobante WHERE id = NEW.comprobante_id),
    (SELECT sociedad_id FROM fin.orden_pago WHERE id = NEW.orden_pago_id),
    (SELECT sociedad_id FROM fin.movimiento_cc WHERE id = NEW.anula_a));
  IF NEW.sociedad_id IS NULL THEN RAISE EXCEPTION 'Un movimiento de cuenta corriente sin sociedad.'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER movimiento_cc_sociedad BEFORE INSERT ON fin.movimiento_cc FOR EACH ROW EXECUTE FUNCTION fin.movimiento_cc_sociedad();

-- Una nota asociada a una factura es de la misma sociedad.
CREATE OR REPLACE FUNCTION fin.comprobante_sociedad() RETURNS trigger AS $$
BEGIN
  IF NEW.asociado_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fin.comprobante a WHERE a.id = NEW.asociado_id AND a.sociedad_id = NEW.sociedad_id) THEN
    RAISE EXCEPTION 'La nota y la factura a la que se asocia son de sociedades distintas.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER comprobante_sociedad BEFORE INSERT OR UPDATE OF asociado_id, sociedad_id ON fin.comprobante
  FOR EACH ROW EXECUTE FUNCTION fin.comprobante_sociedad();

-- Una orden de pago aplica comprobantes de su sociedad...
CREATE OR REPLACE FUNCTION fin.orden_pago_aplicacion_sociedad() RETURNS trigger AS $$
DECLARE s uuid; c record;
BEGIN
  SELECT sociedad_id INTO s FROM fin.orden_pago WHERE id = NEW.orden_pago_id;
  SELECT x.sociedad_id, so.nombre INTO c FROM fin.comprobante x JOIN org.sociedad so ON so.id = x.sociedad_id WHERE x.id = NEW.comprobante_id;
  IF c.sociedad_id IS DISTINCT FROM s THEN
    RAISE EXCEPTION 'Un comprobante de la orden de pago es de %: la orden paga comprobantes de una sola sociedad.', c.nombre;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER orden_pago_aplicacion_sociedad BEFORE INSERT OR UPDATE ON fin.orden_pago_aplicacion
  FOR EACH ROW EXECUTE FUNCTION fin.orden_pago_aplicacion_sociedad();

-- ... y paga desde cuentas de su sociedad o del grupo.
CREATE OR REPLACE FUNCTION fin.orden_pago_valor_sociedad() RETURNS trigger AS $$
DECLARE s uuid; c record;
BEGIN
  IF NEW.cuenta_id IS NULL THEN RETURN NEW; END IF;
  SELECT sociedad_id INTO s FROM fin.orden_pago WHERE id = NEW.orden_pago_id;
  SELECT cu.nombre, cu.sociedad_id INTO c FROM fin.cuenta cu WHERE cu.id = NEW.cuenta_id;
  IF c.sociedad_id IS NOT NULL AND c.sociedad_id IS DISTINCT FROM s THEN
    RAISE EXCEPTION 'La cuenta % es de otra sociedad: se paga desde una cuenta de la sociedad de la orden o del grupo.', c.nombre;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER orden_pago_valor_sociedad BEFORE INSERT OR UPDATE ON fin.orden_pago_valor
  FOR EACH ROW EXECUTE FUNCTION fin.orden_pago_valor_sociedad();

-- Una orden con renglones no cambia de sociedad.
CREATE OR REPLACE FUNCTION fin.orden_pago_cambia_sociedad() RETURNS trigger AS $$
BEGIN
  IF NEW.sociedad_id IS DISTINCT FROM OLD.sociedad_id AND
     (EXISTS (SELECT 1 FROM fin.orden_pago_aplicacion WHERE orden_pago_id = NEW.id) OR EXISTS (SELECT 1 FROM fin.orden_pago_valor WHERE orden_pago_id = NEW.id)) THEN
    RAISE EXCEPTION 'La orden de pago ya tiene comprobantes o valores: no cambia de sociedad.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER orden_pago_cambia_sociedad BEFORE UPDATE OF sociedad_id ON fin.orden_pago
  FOR EACH ROW EXECUTE FUNCTION fin.orden_pago_cambia_sociedad();

-- Lo pendiente con su sociedad (al final: CREATE OR REPLACE sólo agrega columnas al final).
CREATE OR REPLACE VIEW fin.comprobante_pendiente AS
SELECT c.id AS comprobante_id, c.proveedor_id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha,
       COALESCE(c.vencimiento, c.fecha) AS vencimiento,
       c.total - COALESCE((SELECT SUM(n.total) FROM fin.comprobante n WHERE n.asociado_id = c.id AND n.tipo = 'nota_credito' AND n.estado = 'registrado'), 0)
               - COALESCE((SELECT SUM(a.importe) FROM fin.orden_pago_aplicacion a JOIN fin.orden_pago o ON o.id = a.orden_pago_id
                            WHERE a.comprobante_id = c.id AND o.estado = 'registrada'), 0) AS pendiente,
       c.sociedad_id
  FROM fin.comprobante c
 WHERE c.estado = 'registrado' AND c.tipo IN ('factura', 'nota_debito');

CREATE OR REPLACE VIEW fin.credito_pendiente AS
SELECT c.id AS comprobante_id, c.proveedor_id, c.letra, c.punto_venta, c.numero, c.fecha,
       c.total - COALESCE((SELECT SUM(a.importe) FROM fin.orden_pago_aplicacion a JOIN fin.orden_pago o ON o.id = a.orden_pago_id
                            WHERE a.comprobante_id = c.id AND o.estado = 'registrada'), 0) AS disponible,
       c.sociedad_id
  FROM fin.comprobante c
 WHERE c.estado = 'registrado' AND c.tipo = 'nota_credito' AND c.asociado_id IS NULL;

-- El saldo con cada proveedor por sociedad (fin.saldo_proveedor sigue siendo el total del grupo con el proveedor).
CREATE VIEW fin.saldo_proveedor_sociedad AS
SELECT proveedor_id, sociedad_id, SUM(haber - debe) AS saldo, MAX(fecha) AS ultimo_movimiento
  FROM fin.movimiento_cc GROUP BY proveedor_id, sociedad_id;
