-- Un local (sede tipo "punto de venta") es UN sistema de venta, con UN almacén y UNA ubicación (decisiones de
-- Fer, 25/10/2026). Lo que pasa con la mercadería adentro del local queda fuera de lo que se puede controlar
-- desde el centro: lo que llega (remitos) entra ahí y lo que se vende sale de ahí. El stock y el frío se
-- gestionan sólo en el centro. Si un local tiene dos sistemas, se carga como dos sedes.
--
-- La configuración de la venta (sistema, modo, credenciales, artículos, medios) pasa a la ficha de la sede;
-- por debajo sigue en pos.integracion, ahora una por sede.

-- Ubicaciones de locales que no son depósito y nunca se usaron: se desactivan (heladeras, cámaras).
UPDATE logic.ubicacion u SET activa = false
  FROM logic.almacen a JOIN org.sede s ON s.id = a.sede_id
 WHERE a.id = u.almacen_id AND s.tipo = 'local' AND u.activa AND u.tipo <> 'deposito'
   AND NOT EXISTS (SELECT 1 FROM logic.movimiento m WHERE u.id IN (m.origen_id, m.destino_id))
   AND NOT EXISTS (SELECT 1 FROM logic.lectura_temperatura l WHERE l.ubicacion_id = u.id);

-- Un almacén activo por local.
CREATE FUNCTION logic.local_un_almacen() RETURNS trigger AS $$
BEGIN
  IF NEW.activo AND EXISTS (SELECT 1 FROM org.sede s WHERE s.id = NEW.sede_id AND s.tipo = 'local')
     AND EXISTS (SELECT 1 FROM logic.almacen a WHERE a.sede_id = NEW.sede_id AND a.activo AND a.id <> NEW.id) THEN
    RAISE EXCEPTION 'Un punto de venta tiene un solo almacén: lo que llega y lo que se vende pasa por un único lugar.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER local_un_almacen BEFORE INSERT OR UPDATE OF activo, sede_id ON logic.almacen
  FOR EACH ROW EXECUTE FUNCTION logic.local_un_almacen();

-- Una ubicación activa por local, y de tipo depósito (en el local no hay control de frío).
CREATE FUNCTION logic.local_una_ubicacion() RETURNS trigger AS $$
DECLARE v_sede uuid;
BEGIN
  IF NOT NEW.activa THEN RETURN NEW; END IF;
  SELECT a.sede_id INTO v_sede FROM logic.almacen a JOIN org.sede s ON s.id = a.sede_id
   WHERE a.id = NEW.almacen_id AND s.tipo = 'local';
  IF v_sede IS NULL THEN RETURN NEW; END IF;
  IF NEW.tipo <> 'deposito' THEN
    RAISE EXCEPTION 'En un punto de venta no se controla el frío: su única ubicación es un depósito.';
  END IF;
  IF EXISTS (SELECT 1 FROM logic.ubicacion u JOIN logic.almacen a ON a.id = u.almacen_id
              WHERE a.sede_id = v_sede AND u.activa AND u.id <> NEW.id) THEN
    RAISE EXCEPTION 'Un punto de venta tiene una sola ubicación: lo que llega y lo que se vende pasa por un único lugar.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER local_una_ubicacion BEFORE INSERT OR UPDATE OF activa, tipo, almacen_id ON logic.ubicacion
  FOR EACH ROW EXECUTE FUNCTION logic.local_una_ubicacion();

-- Un sistema de venta por sede.
CREATE UNIQUE INDEX integracion_sede_ux ON pos.integracion (sede_id);
