-- El DÍA de cada punto de venta es la unidad financiera (decisiones de Fer, 25/10/2026). Un mismo día puede
-- llegar en varias importaciones (se vuelve a sincronizar); lo que se controla y se cobra es el día.
--   · Los cobros se procesan por día y TODO O NADA: no se procesan mientras haya un medio del sistema sin su
--     medio de pago asignado (el día no queda cobrado a medias en tesorería).
--   · Si lo cobrado no coincide con lo vendido, no se procesa; se puede forzar con un motivo, que queda en el
--     cobro junto con la diferencia.
--   · El estado del día no se guarda: se deduce (pos.jornada), como el stock. Lo único que se guarda es lo que
--     no se puede deducir: cuántas ventas seguían abiertas al sincronizar (pos.sincronizacion_dia).

ALTER TABLE pos.cobro ALTER COLUMN importacion_id DROP NOT NULL,
  ADD COLUMN integracion_id uuid REFERENCES pos.integracion(id),
  ADD COLUMN dia date,
  ADD COLUMN diferencia numeric(16,2),
  ADD COLUMN motivo_diferencia text;
UPDATE pos.cobro c SET integracion_id = im.integracion_id FROM pos.importacion im WHERE im.id = c.importacion_id;

-- Cada sincronización con el POS deja, por día, cuántas ventas seguían abiertas (mesas sin cerrar): ese día
-- todavía no está completo y conviene volver a traerlo.
CREATE TABLE pos.sincronizacion_dia (
  integracion_id   uuid NOT NULL REFERENCES pos.integracion(id),
  dia              date NOT NULL,
  abiertas         int NOT NULL DEFAULT 0,
  sincronizado_en  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integracion_id, dia)
);

-- Resumen del día por punto de venta. Vendido = total de cada venta cerrada (o la suma de sus renglones si el
-- POS no da el total); cobrado = sus pagos no anulados.
CREATE VIEW pos.jornada AS
SELECT t.integracion_id, t.dia,
       count(*) FILTER (WHERE t.estado = 'cerrado')::int AS ventas,
       count(*) FILTER (WHERE t.estado = 'anulado')::int AS anuladas,
       COALESCE(SUM(COALESCE(t.total, it.vendido)) FILTER (WHERE t.estado = 'cerrado'), 0)::numeric(16,2) AS vendido,
       COALESCE(SUM(pg.cobrado) FILTER (WHERE t.estado = 'cerrado'), 0)::numeric(16,2) AS cobrado,
       COALESCE(SUM(pg.por_cobrar) FILTER (WHERE t.estado = 'cerrado'), 0)::numeric(16,2) AS por_cobrar,
       COALESCE(SUM(pg.pendientes) FILTER (WHERE t.estado = 'cerrado'), 0)::int AS pagos_pendientes,
       COALESCE(SUM(pg.sin_asignar) FILTER (WHERE t.estado = 'cerrado'), 0)::int AS pagos_sin_asignar,
       COALESCE(SUM(pg.procesados) FILTER (WHERE t.estado = 'cerrado'), 0)::int AS pagos_procesados,
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
                       FROM pos.ticket_pago p JOIN pos.medio m ON m.id = p.medio_id WHERE p.ticket_id = t.id) pg ON true
  LEFT JOIN pos.sincronizacion_dia sd ON sd.integracion_id = t.integracion_id AND sd.dia = t.dia
 GROUP BY t.integracion_id, t.dia, sd.abiertas, sd.sincronizado_en;
