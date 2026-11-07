-- PedidosYa como tipo de venta propio (pedido de Fer, 07/11/2026): en el tablero de ventas y en el estado de resultados el
-- delivery propio del local (Maxirest, Fudo) no se mezcla con PedidosYa. Los pedidos ya importados se guardaron como
-- 'delivery' o 'para llevar' (retiro en el local); pasan a 'pedidosya', como los que se importen desde ahora.
UPDATE pos.ticket t SET tipo = 'pedidosya'
  FROM pos.integracion i
 WHERE i.id = t.integracion_id AND i.sistema = 'pedidosya' AND t.tipo IS DISTINCT FROM 'pedidosya';
