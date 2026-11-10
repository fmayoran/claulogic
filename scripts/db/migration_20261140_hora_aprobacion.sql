-- Hora de aprobación del cobro en el extracto (pedido de Fer, 10/11/2026). El reporte de liberaciones de Mercado Pago trae
-- TRANSACTION_APPROVAL_DATE con la hora: la conciliación automática la usa para elegir, entre ventas del mismo importe, la que
-- estaba abierta cuando se aprobó el cobro (un QR de $27.500 a las 20:37 se había pareado con otra venta de $27.500 de la noche).
ALTER TABLE fin.extracto_linea ADD COLUMN aprobada_en timestamptz;
COMMENT ON COLUMN fin.extracto_linea.aprobada_en IS 'Cuándo se aprobó el cobro según el procesador (Mercado Pago); NULL si el extracto no lo trae.';
