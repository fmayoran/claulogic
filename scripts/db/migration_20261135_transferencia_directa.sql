-- Transferencia directa (pedido de Fer, 09/11/2026: la venta 2020 de CORTAFUEGO se pagó con una transferencia a BRUBANK y en
-- Fudo existe el medio "Transferencia Brubank"). Se modela como un procesador sin comisión, marca 'transferencia': su cuenta
-- "a acreditar" tiene lo cobrado hasta que el extracto del banco donde deposita lo confirma, venta por venta, como cualquier
-- procesador. Un banco puede recibir de varios procesadores (BRUBANK: Fudo Pagos y la transferencia directa).
ALTER TABLE fin.procesador DROP CONSTRAINT procesador_marca_check;
ALTER TABLE fin.procesador ADD CONSTRAINT procesador_marca_check
  CHECK (marca IN ('mercadopago', 'pago24', 'fudo', 'getnet', 'pedidosya', 'transferencia', 'otro'));
