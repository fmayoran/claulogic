-- Sede central, puntos de venta y medios de pago globales (decisiones de Fer, 25/10/2026).
--
--   · SEDE CENTRAL: la que consolida las finanzas del grupo. No tiene puntos de venta: recibe los
--     ingresos de todos. Es configurable (una sola a la vez) para que la app sirva a otro negocio; la
--     primera vez la toma el centro de abastecimiento más antiguo.
--   · PUNTO DE VENTA = un sistema (cada pos.integracion): pertenece a un local, tiene código, y su
--     propia cuenta de EFECTIVO, cuyo saldo es lo que tiene pendiente de rendir a la central (rendir es
--     una transferencia a la caja de la central).
--   · MEDIO DE PAGO global = procesador + tipo de operación (Mercado Pago · QR, Getnet · Débito…), más
--     el efectivo. Cada procesador acredita en UNA cuenta; el tipo de operación queda en cada cobro para
--     calcular después el costo de operar con cada uno.
--   · Cada texto con que un sistema nombra un medio ("TARJETA DEBITO") se asigna a un medio global; de
--     ahí sale su cuenta (la del procesador, o la de efectivo del punto de venta), que es lo que usa el
--     procesamiento de cobros. La cuenta se deriva: no se elige a mano.

ALTER TABLE org.sede ADD COLUMN es_central boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX sede_central_ux ON org.sede (es_central) WHERE es_central;
UPDATE org.sede SET es_central = true
 WHERE id = (SELECT id FROM org.sede WHERE tipo = 'centro' AND activa ORDER BY creado_en LIMIT 1);

CREATE TABLE fin.procesador (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     text NOT NULL CHECK (btrim(nombre) <> ''),
  cuenta_id  uuid NOT NULL REFERENCES fin.cuenta(id),     -- donde acredita todo lo de este procesador
  activo     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX procesador_nombre_ux ON fin.procesador (lower(btrim(nombre)));

CREATE TABLE fin.medio_pago (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procesador_id   uuid REFERENCES fin.procesador(id),      -- NULL sólo para el efectivo
  tipo_operacion  text NOT NULL CHECK (tipo_operacion IN ('efectivo','transferencia','qr','debito','credito','otro')),
  activo          boolean NOT NULL DEFAULT true,
  CHECK ((tipo_operacion = 'efectivo') = (procesador_id IS NULL))
);
CREATE UNIQUE INDEX medio_pago_ux ON fin.medio_pago (COALESCE(procesador_id, '00000000-0000-0000-0000-000000000000'::uuid), tipo_operacion);
INSERT INTO fin.medio_pago (tipo_operacion) VALUES ('efectivo');

ALTER TABLE pos.integracion ADD COLUMN codigo text, ADD COLUMN cuenta_efectivo_id uuid REFERENCES fin.cuenta(id);
ALTER TABLE pos.medio ADD COLUMN medio_pago_id uuid REFERENCES fin.medio_pago(id);

-- Los puntos de venta que ya existen reciben su cuenta de efectivo.
INSERT INTO fin.cuenta (nombre, tipo, sede_id)
SELECT 'Efectivo · ' || i.nombre, 'caja', i.sede_id FROM pos.integracion i WHERE i.cuenta_efectivo_id IS NULL;
UPDATE pos.integracion i SET cuenta_efectivo_id = c.id
  FROM fin.cuenta c WHERE c.nombre = 'Efectivo · ' || i.nombre AND i.cuenta_efectivo_id IS NULL;

-- La cuenta del medio de un sistema sale de su medio global.
CREATE FUNCTION pos.medio_cuenta() RETURNS trigger AS $$
BEGIN
  IF NEW.medio_pago_id IS NOT NULL THEN
    SELECT CASE WHEN mp.tipo_operacion = 'efectivo' THEN i.cuenta_efectivo_id ELSE pr.cuenta_id END INTO NEW.cuenta_id
      FROM fin.medio_pago mp LEFT JOIN fin.procesador pr ON pr.id = mp.procesador_id, pos.integracion i
     WHERE mp.id = NEW.medio_pago_id AND i.id = NEW.integracion_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER medio_cuenta BEFORE INSERT OR UPDATE ON pos.medio FOR EACH ROW EXECUTE FUNCTION pos.medio_cuenta();

-- Si cambia la cuenta de un procesador o la de efectivo de un punto de venta, se recalcula en los medios.
CREATE FUNCTION fin.procesador_cuenta_cambia() RETURNS trigger AS $$
BEGIN
  UPDATE pos.medio m SET medio_pago_id = m.medio_pago_id
    FROM fin.medio_pago mp WHERE mp.id = m.medio_pago_id AND mp.procesador_id = NEW.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER procesador_cuenta_cambia AFTER UPDATE OF cuenta_id ON fin.procesador
  FOR EACH ROW EXECUTE FUNCTION fin.procesador_cuenta_cambia();
CREATE FUNCTION pos.integracion_efectivo_cambia() RETURNS trigger AS $$
BEGIN
  UPDATE pos.medio m SET medio_pago_id = m.medio_pago_id
    FROM fin.medio_pago mp WHERE mp.id = m.medio_pago_id AND mp.tipo_operacion = 'efectivo' AND m.integracion_id = NEW.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER integracion_efectivo_cambia AFTER UPDATE OF cuenta_efectivo_id ON pos.integracion
  FOR EACH ROW EXECUTE FUNCTION pos.integracion_efectivo_cambia();
