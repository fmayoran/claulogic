-- La cuenta destino de una transferencia que sale (pedido de Fer, 15/11/2026). El resumen de cuenta de Mercado Pago, que dice a
-- quién se pagó, sólo se baja por mes; el reporte de liberaciones se baja por día y, con la columna PAYOUT_BANK_ACCOUNT_NUMBER
-- tildada, trae el CBU o CVU de cada "Transferencia a banco" (los "Pago desde Mercado Pago" la traen vacía).

ALTER TABLE fin.extracto_linea ADD COLUMN cuenta_destino text
  CHECK (cuenta_destino IS NULL OR cuenta_destino ~ '^\d{22}$');
COMMENT ON COLUMN fin.extracto_linea.cuenta_destino IS
  'CBU o CVU al que salió la transferencia, según el extracto (Mercado Pago: PAYOUT_BANK_ACCOUNT_NUMBER).';
CREATE INDEX extracto_linea_cuenta_destino_ix ON fin.extracto_linea (cuenta_destino) WHERE cuenta_destino IS NOT NULL;

-- El proveedor de cada CBU no se guarda: se deduce, como el stock, de lo que ya se pagó. Una línea con cuenta destino,
-- conciliada con un egreso que paga un comprobante (fin.pago_previo), dice que ese CBU es de ese proveedor; si hubo
-- varios, manda el pago más reciente (así una asignación equivocada se corrige con la siguiente). Las cuentas propias
-- (fin.cuenta.cbu) quedan afuera: son transferencias, no pagos.
CREATE VIEW fin.proveedor_cbu AS
SELECT DISTINCT ON (l.cuenta_destino) l.cuenta_destino AS cbu, c.proveedor_id, l.fecha AS ultimo_pago
  FROM fin.extracto_linea l
  JOIN fin.conciliacion k ON k.linea_id = l.id
  JOIN fin.pago_previo pp ON pp.movimiento_id = k.movimiento_id
  JOIN fin.comprobante c ON c.id = pp.comprobante_id
 WHERE l.cuenta_destino IS NOT NULL AND c.estado <> 'anulado'
   AND NOT EXISTS (SELECT 1 FROM fin.cuenta cu WHERE cu.cbu = l.cuenta_destino)
 ORDER BY l.cuenta_destino, l.fecha DESC, pp.creado_en DESC;
COMMENT ON VIEW fin.proveedor_cbu IS
  'Proveedor de cada CBU o CVU, deducido de las transferencias que pagaron sus comprobantes (el pago más reciente manda).';
