-- PedidosYa (pedido de Fer, 05/11/2026). Los tres locales venden por PedidosYa; sus pedidos no pasan por Fudo ni por Maxirest,
-- se registran sólo en el portal de PedidosYa (Partner Portal de Delivery Hero, sin API para el local y con protección contra
-- bots: va por archivo, el "orderDetails.csv" que exporta el portal). Decisiones de Fer:
--   · va ADENTRO del local, para que sume a sus ventas: es un segundo sistema de venta de la misma sede (hasta ahora era uno
--     por sede). Usa la ubicación y la cuenta de efectivo del sistema principal del local;
--   · entregan los repartidores de PedidosYa y se cobra casi todo en línea; PedidosYa deposita lo suyo (neto de comisiones)
--     en una cuenta del local (CORTAFUEGO: Brubank). Un pedido en efectivo lo cobra el local y la comisión de ese pedido
--     PedidosYa la descuenta de la liquidación.
-- Se empieza por CORTAFUEGO PARRILLA, que vende por PedidosYa desde noviembre.

-- Un sistema principal por sede, más PedidosYa.
ALTER TABLE pos.integracion DROP CONSTRAINT integracion_sistema_check;
ALTER TABLE pos.integracion ADD CONSTRAINT integracion_sistema_check CHECK (sistema IN ('fudo', 'maxirest', 'otro', 'pedidosya'));
ALTER TABLE pos.integracion ADD CONSTRAINT integracion_pedidosya_archivo CHECK (sistema <> 'pedidosya' OR modo = 'archivo');
DROP INDEX pos.integracion_sede_ux;
CREATE UNIQUE INDEX integracion_sede_ux ON pos.integracion (sede_id) WHERE sistema <> 'pedidosya';
CREATE UNIQUE INDEX integracion_pedidosya_ux ON pos.integracion (sede_id) WHERE sistema = 'pedidosya';

-- La marca y el tipo de operación.
ALTER TABLE fin.procesador DROP CONSTRAINT procesador_marca_check;
ALTER TABLE fin.procesador ADD CONSTRAINT procesador_marca_check CHECK (marca IN ('mercadopago', 'pago24', 'fudo', 'getnet', 'pedidosya', 'otro'));
ALTER TABLE fin.medio_pago DROP CONSTRAINT medio_pago_tipo_operacion_check;
ALTER TABLE fin.medio_pago ADD CONSTRAINT medio_pago_tipo_operacion_check
  CHECK (tipo_operacion IN ('efectivo', 'transferencia', 'qr', 'debito', 'credito', 'online', 'otro'));

-- La cuenta de cobro de CORTAFUEGO en PedidosYa, con su "a acreditar". Todavía sin "Deposita en": Brubank es la cuenta donde
-- deposita Fudo Pagos y la conciliación automática toma un solo procesador por cuenta; se completa con la primera liquidación.
WITH s AS (SELECT id FROM org.sede WHERE nombre = 'CORTAFUEGO PARRILLA'),
     cu AS (INSERT INTO fin.cuenta (nombre, tipo, sede_id) SELECT 'PEDIDOSYA CORTAFUEGO a acreditar', 'cobranza', s.id FROM s RETURNING id),
     pr AS (INSERT INTO fin.procesador (nombre, cuenta_id, marca) SELECT 'PEDIDOSYA CORTAFUEGO', cu.id, 'pedidosya' FROM cu RETURNING id)
INSERT INTO fin.medio_pago (procesador_id, tipo_operacion) SELECT pr.id, 'online' FROM pr;
