-- Anular desde ClauLogic una venta del sistema de venta (pedido de Fer, 21/11/2026: "no podemos depender del punto de venta").
-- Caso que lo originó: la venta #2408 de CORTAFUEGO (20/11, 22:13, $28.000) está cerrada y cobrada con "Online Pedidos Ya" en Fudo,
-- pero el pedido 2379539428 se canceló en PedidosYa (por el cliente): no se empareja, PedidosYa no paga esos $28.000 y el día no se
-- puede cobrar. Volver a traer el día no lo arregla aunque se anule en Fudo: una venta ya importada no se actualiza.
-- La venta pasa a 'anulado' con quién, cuándo y por qué; volver a traer las ventas no la toca (ON CONFLICT DO NOTHING) y se deshace
-- devolviéndola a 'cerrado'.
ALTER TABLE pos.ticket
  ADD COLUMN anulada_por text,
  ADD COLUMN anulada_en timestamptz,
  ADD COLUMN anulada_motivo text,
  ADD CONSTRAINT ticket_anulada_aqui_ck CHECK (
    (anulada_por IS NULL AND anulada_en IS NULL AND anulada_motivo IS NULL)
    OR (anulada_por IS NOT NULL AND anulada_en IS NOT NULL AND length(btrim(anulada_motivo)) > 0 AND estado = 'anulado'));

COMMENT ON COLUMN pos.ticket.anulada_por IS 'Usuario que anuló la venta desde ClauLogic (el sistema de venta la tiene cerrada). NULL = el estado es el del sistema de venta.';
COMMENT ON COLUMN pos.ticket.anulada_motivo IS 'Por qué se anuló desde ClauLogic (p. ej., el pedido se canceló en PedidosYa).';
