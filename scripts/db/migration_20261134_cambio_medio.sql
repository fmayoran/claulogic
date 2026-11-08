-- Corregir el medio de pago de un cobro ya procesado (pedido de Fer, 08/11/2026: casi siempre un cobro que no aparece en el
-- extracto es un medio mal cargado en el sistema de venta). El pago pasa a otro medio del mismo sistema de venta y la plata se
-- mueve con una transferencia de la cuenta del medio anterior a la del nuevo, en el día de la venta (el cobro del día no se
-- reescribe: es libro mayor). Volver a traer las ventas no lo pisa: un ticket que ya está no se toca.
--   medio_original_id     — el medio con que vino del sistema de venta (NULL = no se cambió).
--   medio_cambio_mov_id   — la pata de salida de esa transferencia; deshacer la anula y vuelve al medio original.
ALTER TABLE pos.ticket_pago
  ADD COLUMN medio_original_id uuid REFERENCES pos.medio(id),
  ADD COLUMN medio_cambio_mov_id bigint REFERENCES fin.movimiento_tes(id),
  ADD CONSTRAINT ticket_pago_cambio_medio_ck CHECK ((medio_original_id IS NULL) = (medio_cambio_mov_id IS NULL));
COMMENT ON COLUMN pos.ticket_pago.medio_original_id IS 'Medio con que vino del sistema de venta, si se corrigió a mano (medio_id es el corregido).';
COMMENT ON COLUMN pos.ticket_pago.medio_cambio_mov_id IS 'Salida de la transferencia que movió el cobro a la cuenta del medio corregido.';
