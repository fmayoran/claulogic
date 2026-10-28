-- Cuáles ventas seguían abiertas al sincronizar (pedido de Fer, 28/10/2026: el 27/10 había "una mesa abierta" que no se
-- encontraba; era un delivery enviado y sin cerrar). Hasta ahora se guardaba sólo cuántas; ahora también el detalle
-- mínimo para encontrarla en el sistema de venta: número, estado, tipo, hora de apertura, total, cliente, mesa y mozo.
-- Se reemplaza en cada sincronización del día, como el contador.
ALTER TABLE pos.sincronizacion_dia ADD COLUMN abiertas_detalle jsonb;
