-- Los 270 comprobantes X armados desde los pagos sin factura (15/11/2026) tienen un renglón sin producto ni rubro. Su rubro es el del
-- egreso que los pagó (fin.clasificacion), que ya estaba clasificado: se completa para que "Compras por rubro" (Cuentas por pagar) tenga
-- la historia. No cambia importes ni el estado de resultados (esos pagos están clasificados a mano y eso manda). El trigger que cierra
-- los renglones de un comprobante registrado se apaga sólo para este UPDATE.
ALTER TABLE fin.comprobante_item DISABLE TRIGGER comprobante_item_cerrado;
UPDATE fin.comprobante_item ci SET rubro_id = k.rubro_id
  FROM fin.pago_previo pp JOIN fin.clasificacion k ON k.movimiento_id = pp.movimiento_id
 WHERE pp.comprobante_id = ci.comprobante_id AND ci.producto_id IS NULL AND ci.rubro_id IS NULL
   AND (SELECT count(*) FROM fin.comprobante_item x WHERE x.comprobante_id = ci.comprobante_id) = 1
   AND (SELECT count(DISTINCT k2.rubro_id) FROM fin.pago_previo p2 JOIN fin.clasificacion k2 ON k2.movimiento_id = p2.movimiento_id
         WHERE p2.comprobante_id = ci.comprobante_id) = 1;
ALTER TABLE fin.comprobante_item ENABLE TRIGGER comprobante_item_cerrado;
