-- Lotes de los procesadores que liquidan por lotes (Fudo Pagos; decisiones de Fer, 26/10/2026). Fudo informa por la
-- API, pago por pago, la fecha de liquidación (`expectedBy`) y el neto que deposita (`receivedAmount`): los cobros de
-- una misma fecha forman el lote. Cuando llega la fecha, el lote se liquida solo: el neto pasa de la cuenta "a
-- acreditar" a la cuenta donde deposita el procesador (Brubank) y el costo queda como cargo del procesador. El
-- extracto de esa cuenta lo confirma: el depósito del lote se parea con la entrada del lote. Un lote liquidado que no
-- aparece en el banco queda en alerta.

-- Del pago de la venta: su número en el POS (para cruzarlo con la liquidación), la fecha de liquidación y el neto
-- que informa el procesador, y el lote con que se liquidó.
ALTER TABLE pos.ticket_pago ADD COLUMN id_externo text, ADD COLUMN liquida_el date, ADD COLUMN neto numeric(16,2), ADD COLUMN lote_id uuid;

CREATE TABLE fin.lote (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procesador_id  uuid NOT NULL REFERENCES fin.procesador(id),
  fecha          date NOT NULL,                                     -- la de liquidación
  pagos          int NOT NULL CHECK (pagos > 0),
  bruto          numeric(16,2) NOT NULL,
  neto           numeric(16,2) NOT NULL,
  movimiento_id  bigint NOT NULL UNIQUE REFERENCES fin.movimiento_tes(id),   -- la entrada en la cuenta donde deposita
  costo_movimiento_id bigint REFERENCES fin.movimiento_tes(id),             -- el cargo del procesador (egreso de "a acreditar")
  desde_linea_id bigint REFERENCES fin.extracto_linea(id),                  -- si se armó al confirmar un depósito (un cobro sin neto informado)
  creado_en      timestamptz NOT NULL DEFAULT now(),
  creado_por     text DEFAULT org.usuario_actual()
);
CREATE INDEX lote_procesador_ix ON fin.lote (procesador_id, fecha);
ALTER TABLE pos.ticket_pago ADD CONSTRAINT ticket_pago_lote_fk FOREIGN KEY (lote_id) REFERENCES fin.lote(id);
CREATE INDEX ticket_pago_lote_ix ON pos.ticket_pago (lote_id);
CREATE INDEX ticket_pago_por_liquidar_ix ON pos.ticket_pago (liquida_el) WHERE lote_id IS NULL AND liquida_el IS NOT NULL;

-- Una línea del extracto puede conciliarse con VARIOS movimientos que suman su importe: un depósito de Fudo Pagos que
-- junta dos lotes del mismo día (un crédito de una venta anterior se liquida con los débitos del día), o un lote más
-- la diferencia confirmada con su motivo. Cada movimiento sigue conciliado con una sola línea. La suma se controla al
-- terminar la transacción (los movimientos de una línea se insertan de a uno).
ALTER TABLE fin.conciliacion DROP CONSTRAINT conciliacion_pkey;
ALTER TABLE fin.conciliacion ADD PRIMARY KEY (linea_id, movimiento_id);
CREATE OR REPLACE FUNCTION fin.conciliacion_coherente() RETURNS trigger AS $$
DECLARE l record; m record;
BEGIN
  PERFORM org.exigir_finanzas();
  SELECT cuenta_id INTO l FROM fin.extracto_linea WHERE id = NEW.linea_id;
  SELECT cuenta_id INTO m FROM fin.movimiento_tes WHERE id = NEW.movimiento_id;
  IF l.cuenta_id <> m.cuenta_id THEN RAISE EXCEPTION 'La línea y el movimiento son de cuentas distintas.'; END IF;
  NEW.conciliado_por := COALESCE(org.usuario_actual(), NEW.conciliado_por);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION fin.conciliacion_suma() RETURNS trigger AS $$
DECLARE li numeric; mo numeric;
BEGIN
  SELECT importe INTO li FROM fin.extracto_linea WHERE id = NEW.linea_id;
  SELECT COALESCE(SUM(m.entrada - m.salida), 0) INTO mo FROM fin.conciliacion k JOIN fin.movimiento_tes m ON m.id = k.movimiento_id WHERE k.linea_id = NEW.linea_id;
  IF li IS NOT NULL AND li <> mo THEN
    RAISE EXCEPTION 'La línea (%) y sus movimientos (%) no suman lo mismo.', li, mo;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER conciliacion_suma AFTER INSERT OR UPDATE ON fin.conciliacion
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fin.conciliacion_suma();
