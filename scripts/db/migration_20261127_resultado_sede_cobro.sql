-- Los costos de un cobro (PedidosYa: comisiones, descuentos del local, IVA, marketing) son de la filial del punto de venta que
-- cobró, no de la de la cuenta donde se asientan. La cuenta "PEDIDOSYA SORELLE a acreditar" es del bodegón y la usa también la
-- cafetería: sus costos de octubre (104 movimientos, unos $700.000) caían en SORELLE BODEGON Y SUSHI y, adentro, sin comercio.
-- Misma regla que ya tenía lo atado a una venta (iv.sede_id): se agrega la sede del sistema de venta del cobro antes que la de
-- la cuenta. Nada más cambia en la vista.
CREATE OR REPLACE VIEW fin.resultado AS
WITH vivos AS (
  SELECT m.* FROM fin.movimiento_tes m
   WHERE m.tipo <> 'anulacion' AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = m.id))
SELECT i.sede_id, t.dia, (SELECT id FROM fin.rubro WHERE clave = 'ventas') AS rubro_id,
       SUM(COALESCE(t.total, it.vendido, 0))::numeric(16,2) AS importe, 'ventas'::text AS origen, NULL::bigint AS movimiento_id,
       'Ventas de ' || i.nombre AS concepto,
       i.id AS integracion_id, NULL::uuid AS ticket_id, NULL::uuid AS cobro_id, NULL::uuid AS comercio_id
  FROM pos.ticket t JOIN pos.integracion i ON i.id = t.integracion_id
  LEFT JOIN LATERAL (SELECT SUM(COALESCE(x.importe, x.cantidad * x.precio)) AS vendido FROM pos.ticket_item x
                      WHERE x.ticket_id = t.id AND NOT x.anulado) it ON true
 WHERE t.estado = 'cerrado'
 GROUP BY i.sede_id, t.dia, i.nombre, i.id
UNION ALL
SELECT kc.sede_id, kc.dia, (SELECT id FROM fin.rubro WHERE clave = 'cmv'), SUM(kc.valor)::numeric(16,2), 'cmv', NULL::bigint,
       'Consumo teórico de lo vendido', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid
  FROM logic.kardex_concepto kc
 WHERE kc.concepto = 'teorico' AND kc.valor IS NOT NULL
 GROUP BY kc.sede_id, kc.dia
UNION ALL
SELECT COALESCE(k.sede_id, iv.sede_id, ic.sede_id, cu.sede_id), COALESCE(tv.dia, m.fecha),
       CASE WHEN m.tipo = 'arqueo' AND k.rubro_id IS NULL THEN (SELECT id FROM fin.rubro WHERE clave = 'dif_caja')
            ELSE fin.rubro_de(k.rubro_id, m.gasto, m.concepto) END,
       m.entrada - m.salida, 'movimiento', m.id, m.concepto,
       COALESCE(iv.id, co.integracion_id), tv.id, m.pos_cobro_id, k.comercio_id
  FROM vivos m JOIN fin.cuenta cu ON cu.id = m.cuenta_id
  LEFT JOIN fin.clasificacion k ON k.movimiento_id = m.id
  LEFT JOIN pos.ticket_pago tp ON tp.id = m.ticket_pago_id
  LEFT JOIN pos.ticket tv ON tv.id = tp.ticket_id
  LEFT JOIN pos.integracion iv ON iv.id = tv.integracion_id
  LEFT JOIN pos.cobro co ON co.id = m.pos_cobro_id
  LEFT JOIN pos.integracion ic ON ic.id = co.integracion_id
 WHERE m.tipo IN ('ingreso','egreso','arqueo')
   AND NOT (m.gasto IS NULL AND m.concepto = 'Saldo de apertura según extracto')
   AND NOT EXISTS (SELECT 1 FROM fin.lote l WHERE l.costo_movimiento_id = m.id)
UNION ALL
SELECT i.sede_id, t.dia, (SELECT id FROM fin.rubro WHERE clave = 'comision'), -(p.importe - p.neto), 'lote', l.costo_movimiento_id,
       'Costo de cobro · venta ' || COALESCE(t.id_externo, ''), i.id, t.id, NULL::uuid, NULL::uuid
  FROM fin.lote l JOIN vivos cm ON cm.id = l.costo_movimiento_id
  JOIN pos.ticket_pago p ON p.lote_id = l.id JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
 WHERE p.neto IS NOT NULL AND p.importe <> p.neto
UNION ALL
SELECT i.sede_id, t.dia, (SELECT id FROM fin.rubro WHERE clave = 'dif_acreditacion'), d.dif, 'acreditacion', d.mov, d.concepto,
       i.id, t.id, NULL::uuid, NULL::uuid
  FROM (SELECT x.transferencia_id, SUM(x.entrada) - SUM(x.salida) AS dif, MIN(x.id) AS mov, MAX(x.concepto) AS concepto,
               (array_agg(x.ticket_pago_id) FILTER (WHERE x.ticket_pago_id IS NOT NULL))[1] AS pago
          FROM vivos x WHERE x.tipo = 'transferencia' AND x.transferencia_id IS NOT NULL
         GROUP BY x.transferencia_id HAVING SUM(x.entrada) <> SUM(x.salida)) d
  JOIN pos.ticket_pago p ON p.id = d.pago JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
UNION ALL
SELECT i.sede_id, c.dia, (SELECT id FROM fin.rubro WHERE clave = 'dif_cobro'), c.diferencia, 'cobro', NULL::bigint,
       'Diferencia de cobro: ' || COALESCE(c.motivo_diferencia, ''), i.id, NULL::uuid, c.id, NULL::uuid
  FROM pos.cobro c JOIN pos.integracion i ON i.id = c.integracion_id
 WHERE c.diferencia IS NOT NULL AND c.diferencia <> 0 AND EXISTS (SELECT 1 FROM vivos m WHERE m.pos_cobro_id = c.id);
