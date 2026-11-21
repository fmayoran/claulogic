-- Cambiar el medio de un pago todavía sin cobrar (pedido de Fer, 21/11/2026: resolver desde ClauLogic, sin depender del punto de
-- venta). Ej.: una venta cargada en Fudo con "Online Pedidos Ya" cuyo pedido no se pagó por PedidosYa y el cliente pagó en efectivo.
-- El cambio de medio de la conciliación (migración 20261134) es para un cobro ya procesado y mueve la plata con una transferencia
-- (medio_cambio_mov_id). Antes de cobrar no hay plata que mover: se cambia el medio, el original queda en medio_original_id y el
-- día se cobra con el nuevo. Ese cambio lleva motivo, quién y cuándo.
ALTER TABLE pos.ticket_pago
  ADD COLUMN medio_cambio_motivo text,
  ADD COLUMN medio_cambio_por text,
  ADD COLUMN medio_cambio_en timestamptz,
  DROP CONSTRAINT ticket_pago_cambio_medio_ck,
  -- El movimiento sólo con el medio original; un cambio sin movimiento (antes de cobrar) exige motivo, quién y cuándo.
  ADD CONSTRAINT ticket_pago_cambio_medio_ck CHECK (
    (medio_cambio_mov_id IS NULL OR medio_original_id IS NOT NULL)
    AND (medio_original_id IS NULL OR medio_cambio_mov_id IS NOT NULL
         OR (length(btrim(medio_cambio_motivo)) > 0 AND medio_cambio_por IS NOT NULL AND medio_cambio_en IS NOT NULL)));

COMMENT ON COLUMN pos.ticket_pago.medio_cambio_motivo IS 'Por qué se cambió el medio antes de cobrar (sin movimiento; el cambio después de cobrar lleva el motivo en el concepto de la transferencia).';
