-- Cobros de un procesador que no van a llegar por él (pedido de Fer, 08/11/2026: en Pago24 de CORTAFUEGO quedaban cobros "para
-- revisar" que no aparecen en ningún extracto). Se resuelven con un movimiento que los saca de la cuenta "a acreditar":
--   efectivo  — se cobró en efectivo y quedó mal cargado en el sistema de venta: pasa al efectivo a rendir del punto de venta;
--   no_llega  — no va a llegar: egreso de "a acreditar" con su motivo (Diferencias en el estado de resultados).
-- resuelto_movimiento_id es ese movimiento; deshacerlo lo anula y el cobro vuelve a pendiente.
ALTER TABLE pos.ticket_pago
  ADD COLUMN resuelto_movimiento_id bigint REFERENCES fin.movimiento_tes(id),
  ADD COLUMN resuelto_como text CHECK (resuelto_como IN ('efectivo', 'no_llega')),
  ADD CONSTRAINT ticket_pago_resuelto_ck CHECK ((resuelto_movimiento_id IS NULL) = (resuelto_como IS NULL)),
  ADD CONSTRAINT ticket_pago_resuelto_o_acreditado_ck CHECK (resuelto_movimiento_id IS NULL OR acreditado_linea_id IS NULL);
COMMENT ON COLUMN pos.ticket_pago.resuelto_movimiento_id IS 'Movimiento que sacó el cobro de "a acreditar" sin extracto (cobrado en efectivo o que no llega).';
COMMENT ON COLUMN pos.ticket_pago.resuelto_como IS 'efectivo: se cobró en efectivo; no_llega: no va a llegar (diferencia).';
