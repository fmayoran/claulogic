-- Cancelaciones de PedidosYa (pedido de Fer, 13/11/2026).
-- 1. Para seguir el KPI: cuándo se aceptó cada pedido, y de los cancelados el motivo y quién canceló (el local, el cliente,
--    PedidosYa). Lo trae el orderDetails; los pedidos ya importados lo reciben al volver a importar el archivo.
-- 2. Un pedido cancelado puede tener un cargo (el local no lo confirmó: PedidosYa le cobra la comisión y su IVA) o una
--    compensación (lo canceló el cliente con el pedido hecho). Va como un pago en $0 del pedido anulado con su neto y sus
--    costos: no es venta ni cobro, pero los costos se asientan al procesar el día, como los de un pedido entregado. Por eso,
--    un pago de un ticket anulado vale si trae costos.
ALTER TABLE pos.ticket ADD COLUMN aceptado_en timestamptz, ADD COLUMN cancelado_motivo text, ADD COLUMN cancelado_por text;

CREATE OR REPLACE VIEW pos.jornada AS
SELECT t.integracion_id, t.dia,
       count(*) FILTER (WHERE t.estado = 'cerrado')::int AS ventas,
       count(*) FILTER (WHERE t.estado = 'anulado')::int AS anuladas,
       COALESCE(SUM(COALESCE(t.total, it.vendido)) FILTER (WHERE t.estado = 'cerrado'), 0)::numeric(16,2) AS vendido,
       COALESCE(SUM(pg.cobrado) FILTER (WHERE t.estado = 'cerrado'), 0)::numeric(16,2) AS cobrado,
       COALESCE(SUM(pg.por_cobrar) FILTER (WHERE t.estado = 'cerrado'), 0)::numeric(16,2) AS por_cobrar,
       COALESCE(SUM(pg.pendientes), 0)::int AS pagos_pendientes,
       COALESCE(SUM(pg.sin_asignar), 0)::int AS pagos_sin_asignar,
       COALESCE(SUM(pg.procesados), 0)::int AS pagos_procesados,
       sd.abiertas, sd.sincronizado_en
  FROM pos.ticket t
  JOIN pos.importacion im ON im.id = t.importacion_id AND im.estado = 'recibida'
  LEFT JOIN LATERAL (SELECT SUM(COALESCE(i.importe, i.cantidad * i.precio)) AS vendido
                       FROM pos.ticket_item i WHERE i.ticket_id = t.id AND NOT i.anulado) it ON true
  LEFT JOIN LATERAL (SELECT SUM(p.importe) FILTER (WHERE NOT p.anulado) AS cobrado,
                            SUM(p.importe) FILTER (WHERE NOT p.anulado AND p.cobro_id IS NULL) AS por_cobrar,
                            count(*) FILTER (WHERE NOT p.anulado AND p.cobro_id IS NULL) AS pendientes,
                            count(*) FILTER (WHERE NOT p.anulado AND p.cobro_id IS NULL AND m.cuenta_id IS NULL) AS sin_asignar,
                            count(*) FILTER (WHERE NOT p.anulado AND p.cobro_id IS NOT NULL) AS procesados
                       FROM pos.ticket_pago p JOIN pos.medio m ON m.id = p.medio_id
                      WHERE p.ticket_id = t.id AND (t.estado = 'cerrado' OR p.costos IS NOT NULL)) pg ON true
  LEFT JOIN pos.sincronizacion_dia sd ON sd.integracion_id = t.integracion_id AND sd.dia = t.dia
 GROUP BY t.integracion_id, t.dia, sd.abiertas, sd.sincronizado_en;
