-- Facturas de pagos que ya están en tesorería (pedido de Fer, 15/11/2026).
--
-- Muchas compras se registraron desde el extracto como egresos con su rubro (Mercadería · Carnes, Alquiler…), sin proveedor ni
-- factura. Para cargar la factura de uno de esos pagos sin contarlo dos veces, la factura se registra y se COMPENSA en la cuenta
-- corriente con el pago que ya existe: un movimiento 'pago' en fin.movimiento_cc por lo aplicado y un vínculo en fin.pago_previo.
-- No mueve plata ni toca el estado de resultados: el costo sigue saliendo del egreso, en el mes del pago (decisión de Fer).
-- Un pago puede cubrir varias facturas y una factura puede pagarse con varios movimientos; nunca más de lo que salió ni más de lo
-- pendiente. Se deshace con un movimiento de anulación en la cuenta corriente.

CREATE TABLE fin.pago_previo (
  comprobante_id   uuid NOT NULL REFERENCES fin.comprobante(id),
  movimiento_id    bigint NOT NULL REFERENCES fin.movimiento_tes(id),
  importe          numeric(16,2) NOT NULL CHECK (importe > 0),
  cc_movimiento_id bigint NOT NULL UNIQUE REFERENCES fin.movimiento_cc(id),
  creado_en        timestamptz NOT NULL DEFAULT now(),
  creado_por       text DEFAULT org.usuario_actual(),
  PRIMARY KEY (comprobante_id, movimiento_id)
);
CREATE INDEX pago_previo_movimiento_ix ON fin.pago_previo (movimiento_id);

-- Lo aplicado de un movimiento no supera lo que salió (se controla al final de la transacción, como la conciliación).
CREATE FUNCTION fin.pago_previo_control() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m record; aplicado numeric;
BEGIN
  SELECT * INTO m FROM fin.movimiento_tes WHERE id = NEW.movimiento_id;
  IF m.salida <= 0 THEN RAISE EXCEPTION 'El movimiento % no es un egreso.', NEW.movimiento_id; END IF;
  IF m.anula_a IS NOT NULL OR EXISTS (SELECT 1 FROM fin.movimiento_tes z WHERE z.anula_a = m.id) THEN
    RAISE EXCEPTION 'El movimiento % está anulado.', NEW.movimiento_id;
  END IF;
  SELECT COALESCE(SUM(importe), 0) INTO aplicado FROM fin.pago_previo WHERE movimiento_id = NEW.movimiento_id;
  IF aplicado > m.salida THEN
    RAISE EXCEPTION 'Del movimiento % salieron %, y se le aplican %.', NEW.movimiento_id, m.salida, aplicado;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pago_previo_control AFTER INSERT ON fin.pago_previo
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fin.pago_previo_control();

-- Lo pendiente de una factura descuenta también lo pagado antes.
CREATE OR REPLACE VIEW fin.comprobante_pendiente AS
 SELECT id AS comprobante_id,
    proveedor_id,
    tipo,
    letra,
    punto_venta,
    numero,
    fecha,
    COALESCE(vencimiento, fecha) AS vencimiento,
    total - COALESCE(( SELECT sum(n.total) AS sum
           FROM fin.comprobante n
          WHERE n.asociado_id = c.id AND n.tipo = 'nota_credito'::text AND n.estado = 'registrado'::text), 0::numeric) - COALESCE(( SELECT sum(a.importe) AS sum
           FROM fin.orden_pago_aplicacion a
             JOIN fin.orden_pago o ON o.id = a.orden_pago_id
          WHERE a.comprobante_id = c.id AND o.estado = 'registrada'::text), 0::numeric) - COALESCE(( SELECT sum(lc.importe) AS sum
           FROM fin.liquidacion_comprobante lc
          WHERE lc.comprobante_id = c.id), 0::numeric) - COALESCE(( SELECT sum(pp.importe) AS sum
           FROM fin.pago_previo pp
          WHERE pp.comprobante_id = c.id), 0::numeric) AS pendiente,
    sociedad_id
   FROM fin.comprobante c
  WHERE estado = 'registrado'::text AND (tipo = ANY (ARRAY['factura'::text, 'nota_debito'::text]));

-- Una factura con pagos vinculados no se anula: primero se desvinculan.
CREATE OR REPLACE FUNCTION fin.anular_comprobante(p_id uuid, p_motivo text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
    IF EXISTS (SELECT 1 FROM fin.pago_previo WHERE comprobante_id = p_id) THEN
      RAISE EXCEPTION 'El comprobante tiene pagos de tesorería vinculados: desvinculalos primero.';
    END IF;
    SELECT * INTO m FROM fin.movimiento_cc WHERE comprobante_id = p_id AND anula_a IS NULL AND tipo <> 'anulacion'
     ORDER BY id LIMIT 1;
    INSERT INTO fin.movimiento_cc (fecha, proveedor_id, tipo, comprobante_id, debe, haber, detalle, anula_a)
    VALUES (current_date, m.proveedor_id, 'anulacion', p_id, m.haber, m.debe, 'Anula: ' || m.detalle || ' — ' || p_motivo, m.id);
  END IF;
  UPDATE fin.comprobante SET estado = 'anulado', anulado_en = now(), anulado_por = org.usuario_actual(), motivo_anulacion = p_motivo
   WHERE id = p_id;
END $function$;
