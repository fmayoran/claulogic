-- A quién se pagó (o de quién se recibió) una línea del extracto (pedido de Fer, 10/11/2026). El reporte de liberaciones de
-- Mercado Pago dice "Transferencia a banco" o "Pago desde Mercado Pago" con el número de operación; el resumen de cuenta
-- (account_statement) dice "Transferencia enviada Disval S.a." con el mismo número. Importado solo, completa este campo en las
-- líneas que ya están, sin crear líneas: así se pueden clasificar los egresos y las reglas lo miran junto con el concepto.
ALTER TABLE fin.extracto_linea ADD COLUMN destinatario text;
