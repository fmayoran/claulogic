-- Fase 5: tablero. No guarda nada nuevo: son vistas sobre los libros mayores que ya existen.
--
-- KARDEX VALORIZADO. Cada movimiento de stock tiene hasta dos puntas (origen y destino); acá se
-- abre en una fila por punta, con la sede de esa punta, el signo (+ entra a la sede, - sale) y el
-- costo unitario. Sobre esto se arman el consumo teórico y el real por sede sin reprocesar nada.
--
-- El costo unitario es el del LOTE si lo tiene (lo que costó esa partida: compra o producción) y si
-- no, el costo vigente del producto. Para lo que no tiene lote (no perecederos) eso significa
-- valorizar a costo de hoy movimientos de antes: es una aproximación, y se dice así en la pantalla.
CREATE VIEW logic.kardex AS
SELECT m.id AS movimiento_id, m.ocurrido_en,
       (m.ocurrido_en AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS dia,
       m.tipo, m.producto_id, m.lote_id,
       lado.ubicacion_id, u.almacen_id, a.sede_id,
       lado.signo, m.cantidad_base * lado.signo AS cantidad,
       COALESCE(l.costo_base, p.costo_base) AS costo_unitario,
       m.cantidad_base * lado.signo * COALESCE(l.costo_base, p.costo_base) AS valor,
       ao.sede_id AS otra_sede_id,
       m.pos_consumo_id, m.produccion_id, m.remito_id, m.compra_item_id, m.anula_a
  FROM logic.movimiento m
 CROSS JOIN LATERAL (VALUES (m.origen_id, -1, m.destino_id), (m.destino_id, 1, m.origen_id)) AS lado(ubicacion_id, signo, otra_id)
  JOIN logic.ubicacion u ON u.id = lado.ubicacion_id
  JOIN logic.almacen a ON a.id = u.almacen_id
  JOIN logic.producto p ON p.id = m.producto_id
  LEFT JOIN logic.lote l ON l.id = m.lote_id
  LEFT JOIN logic.ubicacion uo ON uo.id = lado.otra_id
  LEFT JOIN logic.almacen ao ON ao.id = uo.almacen_id
 WHERE lado.ubicacion_id IS NOT NULL;

-- Para qué sirvió cada fila del kardex, desde el punto de vista de su sede. Las anulaciones tienen
-- el mismo tipo que lo que anulan y el signo contrario, así que al sumar se cancelan solas.
--   teorico          lo que descontaron las ventas del POS (consumo teórico)
--   perdida          mermas y vencimientos (incluye faltantes de remitos)
--   diferencia       ajustes por conteo y sobrantes de remito: la diferencia entre teórico y real
--   consumo_interno  egresos de consumo cargados a mano (comida del personal, degustaciones)
--   venta_manual     ventas cargadas a mano, fuera del POS
--   produccion       insumos consumidos y elaborados producidos (se compensan en valor)
--   compra           entradas por compra
--   transferencia    remitos entre sedes (entra a una, sale de otra: no es consumo)
--   interno          traslados dentro de la sede
CREATE VIEW logic.kardex_concepto AS
SELECT k.*,
       CASE
         WHEN k.tipo = 'traslado' AND k.otra_sede_id = k.sede_id THEN 'interno'
         WHEN k.tipo = 'traslado' THEN 'transferencia'
         WHEN k.tipo = 'venta' AND k.pos_consumo_id IS NOT NULL THEN 'teorico'
         WHEN k.tipo = 'venta' THEN 'venta_manual'
         WHEN k.tipo IN ('merma','vencimiento') THEN 'perdida'
         WHEN k.tipo = 'ajuste' THEN 'diferencia'
         WHEN k.tipo IN ('consumo','produccion') AND k.produccion_id IS NOT NULL THEN 'produccion'
         WHEN k.tipo = 'consumo' THEN 'consumo_interno'
         WHEN k.tipo = 'compra' THEN 'compra'
         ELSE 'otro'
       END AS concepto
  FROM logic.kardex k;
