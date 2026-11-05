-- PedidosYa en SORELLE (pedido de Fer, 05/11/2026). SORELLE vende por PedidosYa con tres tiendas (el bodegón, el sushi y la
-- cafetería) en una sola cuenta del portal, y el archivo de pedidos (orderDetails) las junta. Bodegón y sushi son la sede
-- SORELLE BODEGON Y SUSHI y la cafetería es SORELLE CAFETERIA: cada pedido va al local de su tienda ("ID de tienda").
-- pos.integracion.tiendas: los ID de tienda de PedidosYa de ese local. Se cargan solos (un archivo de una sola tienda en un
-- local sin tiendas) o al importar, eligiendo el local de cada tienda nueva; una tienda es de un solo local.

ALTER TABLE pos.integracion ADD COLUMN tiendas text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN pos.integracion.tiendas IS 'PedidosYa: los ID de tienda del portal que son de este local (el archivo puede traer varias).';

-- CORTAFUEGO: la tienda 643855 ("Corta Fuego."), la del archivo de noviembre.
UPDATE pos.integracion SET tiendas = '{643855}'
 WHERE sistema = 'pedidosya' AND sede_id = (SELECT id FROM org.sede WHERE nombre = 'CORTAFUEGO PARRILLA');

-- La cuenta de cobro de SORELLE en PedidosYa, con su "a acreditar" (de la sede del bodegón, como la de Mercado Pago de SORELLE;
-- la cafetería la comparte). Sin "Deposita en" hasta la primera liquidación.
WITH s AS (SELECT id FROM org.sede WHERE nombre = 'SORELLE BODEGON Y SUSHI'),
     cu AS (INSERT INTO fin.cuenta (nombre, tipo, sede_id) SELECT 'PEDIDOSYA SORELLE a acreditar', 'cobranza', s.id FROM s RETURNING id),
     pr AS (INSERT INTO fin.procesador (nombre, cuenta_id, marca) SELECT 'PEDIDOSYA SORELLE', cu.id, 'pedidosya' FROM cu RETURNING id)
INSERT INTO fin.medio_pago (procesador_id, tipo_operacion) SELECT pr.id, 'online' FROM pr;
