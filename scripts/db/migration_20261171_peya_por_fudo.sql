-- PedidosYa integrado con Fudo (CORTAFUEGO, desde el 17/11/2026; decisión de Fer, 20/11/2026: opción B y emparejamiento automático).
-- Los pedidos de PedidosYa entran a Fudo como delivery con el medio "Online Pedidos Ya". La venta la da Fudo (artículos con precio);
-- el archivo de PedidosYa ya no crea ventas desde esa fecha: cada pedido se empareja con su venta de Fudo y le pone el número de pedido,
-- la tienda, el canal PedidosYa, la venta por el total parcial (opción B: el descuento del local es un costo) y el neto y los costos
-- en el cobro. Lo que Fudo trajo queda en total_pos e importe_pos.

-- Desde qué día los pedidos de este PedidosYa entran por el sistema principal del local (NULL: no entran, el archivo crea las ventas).
ALTER TABLE pos.integracion ADD COLUMN en_principal_desde date;

ALTER TABLE pos.ticket ADD COLUMN pedido_peya text,          -- número de pedido de PedidosYa de una venta del sistema principal
                       ADD COLUMN total_pos numeric(16,2),    -- el total que trajo el sistema antes de completarlo con PedidosYa
                       ADD COLUMN peya_omitido boolean NOT NULL DEFAULT false;  -- cobrada con PedidosYa sin pedido en el archivo
CREATE UNIQUE INDEX ticket_pedido_peya_ux ON pos.ticket (integracion_id, pedido_peya) WHERE pedido_peya IS NOT NULL;
ALTER TABLE pos.ticket_pago ADD COLUMN importe_pos numeric(16,2);  -- el importe que trajo el sistema antes de completarlo con PedidosYa

-- Pedidos entregados del archivo que no encontraron su venta en el sistema principal: esperan a que llegue (se vuelve a buscar al
-- traer las ventas) o a que se resuelvan a mano (emparejar con una venta, o crearlo como venta sólo de PedidosYa).
CREATE TABLE pos.peya_pendiente (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integracion_id uuid NOT NULL REFERENCES pos.integracion(id),   -- el PedidosYa del local
  nro            text NOT NULL,
  dia            date NOT NULL,
  abierto_en     timestamptz NOT NULL,
  total          numeric(16,2) NOT NULL,
  datos          jsonb NOT NULL,                                  -- el pedido como lo arma la importación (pagos, costos, artículos)
  archivo        text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integracion_id, nro)
);

UPDATE pos.integracion SET en_principal_desde = DATE '2026-11-17'
 WHERE sistema = 'pedidosya' AND sede_id = (SELECT sede_id FROM pos.integracion WHERE sistema = 'fudo' AND nombre = 'CORTAFUEGO PARRILLA');
