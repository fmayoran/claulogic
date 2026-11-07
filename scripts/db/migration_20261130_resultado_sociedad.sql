-- El estado de resultados por sociedad y por store (decisión de Fer, 07/11/2026: grupo > sociedades > locales > stores).
-- Cada hecho de fin.resultado lleva además su sociedad (al final: CREATE OR REPLACE sólo agrega columnas al final):
--   · lo atado a una venta, a un cobro o a un local: la sociedad del local (el centro y la caja mayor son del grupo: NULL);
--   · un movimiento de una cuenta de una sociedad (banco, cuenta de cobro) que no está atado a una venta ni clasificado con un
--     local: es de la SOCIEDAD, sin local. Antes iba a la "filial" de la cuenta (cuenta.sede_id), y los gastos del Santander o del
--     Mercado Pago de SORELLE caían todos en el bodegón; ahora se reparten entre los stores de la sociedad.
-- fin.resultado_comercio reparte lo de la sociedad sin local entre sus stores por las ventas del mes (regla "sociedad"), como ya
-- hacía con lo de un local entre los stores del local (regla "mes").

CREATE OR REPLACE VIEW fin.resultado AS
WITH vivos AS (
  SELECT m.* FROM fin.movimiento_tes m
   WHERE m.tipo <> 'anulacion' AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = m.id))
SELECT i.sede_id, t.dia, (SELECT id FROM fin.rubro WHERE clave = 'ventas') AS rubro_id,
       SUM(COALESCE(t.total, it.vendido, 0))::numeric(16,2) AS importe, 'ventas'::text AS origen, NULL::bigint AS movimiento_id,
       'Ventas de ' || i.nombre AS concepto,
       i.id AS integracion_id, NULL::uuid AS ticket_id, NULL::uuid AS cobro_id, NULL::uuid AS comercio_id, s.sociedad_id
  FROM pos.ticket t JOIN pos.integracion i ON i.id = t.integracion_id JOIN org.sede s ON s.id = i.sede_id
  LEFT JOIN LATERAL (SELECT SUM(COALESCE(x.importe, x.cantidad * x.precio)) AS vendido FROM pos.ticket_item x
                      WHERE x.ticket_id = t.id AND NOT x.anulado) it ON true
 WHERE t.estado = 'cerrado'
 GROUP BY i.sede_id, t.dia, i.nombre, i.id, s.sociedad_id
UNION ALL
SELECT kc.sede_id, kc.dia, (SELECT id FROM fin.rubro WHERE clave = 'cmv'), SUM(kc.valor)::numeric(16,2), 'cmv', NULL::bigint,
       'Consumo teórico de lo vendido', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, s.sociedad_id
  FROM logic.kardex_concepto kc LEFT JOIN org.sede s ON s.id = kc.sede_id
 WHERE kc.concepto = 'teorico' AND kc.valor IS NOT NULL
 GROUP BY kc.sede_id, kc.dia, s.sociedad_id
UNION ALL
SELECT sd.sede_id, COALESCE(tv.dia, m.fecha),
       CASE WHEN m.tipo = 'arqueo' AND k.rubro_id IS NULL THEN (SELECT id FROM fin.rubro WHERE clave = 'dif_caja')
            ELSE fin.rubro_de(k.rubro_id, m.gasto, m.concepto) END,
       m.entrada - m.salida, 'movimiento', m.id, m.concepto,
       COALESCE(iv.id, co.integracion_id), tv.id, m.pos_cobro_id, k.comercio_id,
       CASE WHEN sd.sede_id IS NOT NULL THEN (SELECT s.sociedad_id FROM org.sede s WHERE s.id = sd.sede_id) ELSE cu.sociedad_id END
  FROM vivos m JOIN fin.cuenta cu ON cu.id = m.cuenta_id
  LEFT JOIN fin.clasificacion k ON k.movimiento_id = m.id
  LEFT JOIN pos.ticket_pago tp ON tp.id = m.ticket_pago_id
  LEFT JOIN pos.ticket tv ON tv.id = tp.ticket_id
  LEFT JOIN pos.integracion iv ON iv.id = tv.integracion_id
  LEFT JOIN pos.cobro co ON co.id = m.pos_cobro_id
  LEFT JOIN pos.integracion ic ON ic.id = co.integracion_id
  -- El local del hecho: el elegido al clasificar, el de la venta o el cobro, o el de la cuenta si es una caja o una cuenta del grupo.
  -- Una cuenta de una sociedad (banco, cobro) no aporta local: lo suyo es de la sociedad y se reparte entre sus stores.
  CROSS JOIN LATERAL (SELECT COALESCE(k.sede_id, iv.sede_id, ic.sede_id,
                                      CASE WHEN cu.sociedad_id IS NULL OR cu.tipo = 'caja' THEN cu.sede_id END) AS sede_id) sd
 WHERE m.tipo IN ('ingreso','egreso','arqueo')
   AND NOT (m.gasto IS NULL AND m.concepto = 'Saldo de apertura según extracto')
   AND NOT EXISTS (SELECT 1 FROM fin.lote l WHERE l.costo_movimiento_id = m.id)
UNION ALL
SELECT i.sede_id, t.dia, (SELECT id FROM fin.rubro WHERE clave = 'comision'), -(p.importe - p.neto), 'lote', l.costo_movimiento_id,
       'Costo de cobro · venta ' || COALESCE(t.id_externo, ''), i.id, t.id, NULL::uuid, NULL::uuid, s.sociedad_id
  FROM fin.lote l JOIN vivos cm ON cm.id = l.costo_movimiento_id
  JOIN pos.ticket_pago p ON p.lote_id = l.id JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
  JOIN org.sede s ON s.id = i.sede_id
 WHERE p.neto IS NOT NULL AND p.importe <> p.neto
UNION ALL
SELECT i.sede_id, t.dia, (SELECT id FROM fin.rubro WHERE clave = 'dif_acreditacion'), d.dif, 'acreditacion', d.mov, d.concepto,
       i.id, t.id, NULL::uuid, NULL::uuid, s.sociedad_id
  FROM (SELECT x.transferencia_id, SUM(x.entrada) - SUM(x.salida) AS dif, MIN(x.id) AS mov, MAX(x.concepto) AS concepto,
               (array_agg(x.ticket_pago_id) FILTER (WHERE x.ticket_pago_id IS NOT NULL))[1] AS pago
          FROM vivos x WHERE x.tipo = 'transferencia' AND x.transferencia_id IS NOT NULL
         GROUP BY x.transferencia_id HAVING SUM(x.entrada) <> SUM(x.salida)) d
  JOIN pos.ticket_pago p ON p.id = d.pago JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
  JOIN org.sede s ON s.id = i.sede_id
UNION ALL
SELECT i.sede_id, c.dia, (SELECT id FROM fin.rubro WHERE clave = 'dif_cobro'), c.diferencia, 'cobro', NULL::bigint,
       'Diferencia de cobro: ' || COALESCE(c.motivo_diferencia, ''), i.id, NULL::uuid, c.id, NULL::uuid, s.sociedad_id
  FROM pos.cobro c JOIN pos.integracion i ON i.id = c.integracion_id JOIN org.sede s ON s.id = i.sede_id
 WHERE c.diferencia IS NOT NULL AND c.diferencia <> 0 AND EXISTS (SELECT 1 FROM vivos m WHERE m.pos_cobro_id = c.id);

CREATE OR REPLACE VIEW fin.resultado_comercio AS
WITH r AS (
  SELECT x.*, date_trunc('month', x.dia)::date AS mes,
         EXISTS (SELECT 1 FROM org.comercio c WHERE c.sede_id = x.sede_id AND c.activo) AS con,
         -- De una sociedad sin local: se reparte entre los stores de la sociedad.
         (x.sede_id IS NULL AND x.sociedad_id IS NOT NULL) AS soc
    FROM fin.resultado x),
pd AS (SELECT * FROM pos.comercio_peso_dia),
vm AS (
  SELECT r.sede_id, r.mes, pd.comercio_id, SUM(r.importe * pd.peso) AS v
    FROM r JOIN pd ON pd.integracion_id = r.integracion_id AND pd.dia = r.dia
   WHERE r.origen = 'ventas' GROUP BY 1, 2, 3),
pm AS (SELECT sede_id, mes, comercio_id, v / NULLIF(SUM(v) OVER (PARTITION BY sede_id, mes), 0) AS peso FROM vm),
vs AS (SELECT s.sociedad_id, vm.mes, vm.comercio_id, SUM(vm.v) AS v FROM vm JOIN org.sede s ON s.id = vm.sede_id
        WHERE s.sociedad_id IS NOT NULL GROUP BY 1, 2, 3),
ps AS (SELECT sociedad_id, mes, comercio_id, v / NULLIF(SUM(v) OVER (PARTITION BY sociedad_id, mes), 0) AS peso FROM vs),
cc AS (
  SELECT p.cobro_id, x->>'concepto' AS concepto, c.id AS comercio_id, SUM((x->>'importe')::numeric) AS v
    FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
    LEFT JOIN org.comercio c ON c.sede_id = i.sede_id AND c.activo AND t.tienda = ANY (c.tiendas)
    CROSS JOIN LATERAL jsonb_array_elements(p.costos) x
   WHERE p.costos IS NOT NULL AND p.cobro_id IS NOT NULL
   GROUP BY 1, 2, 3),
ccp AS (SELECT cobro_id, concepto, comercio_id, v / NULLIF(SUM(v) OVER (PARTITION BY cobro_id, concepto), 0) AS peso FROM cc)
SELECT r.sede_id, r.dia, r.rubro_id, (r.importe * a.peso)::numeric(16,2) AS importe, r.origen, r.movimiento_id, r.concepto,
       a.comercio_id, a.peso, a.regla, r.sociedad_id
  FROM r CROSS JOIN LATERAL (
    SELECT z.comercio_id, z.peso, z.regla FROM (
      SELECT y.*, MIN(y.prio) OVER () AS mejor FROM (
        SELECT NULL::uuid AS comercio_id, 1::numeric AS peso, 0 AS prio, 'sin comercios' AS regla WHERE NOT r.con AND NOT r.soc
        UNION ALL SELECT r.comercio_id, 1, 1, 'elegido' WHERE r.con AND r.comercio_id IS NOT NULL
        UNION ALL SELECT c.id, 1, 2, 'tienda' FROM pos.ticket t JOIN org.comercio c ON c.sede_id = r.sede_id AND c.activo AND t.tienda = ANY (c.tiendas)
                   WHERE r.con AND t.id = r.ticket_id
        UNION ALL SELECT ccp.comercio_id, ccp.peso, 3, 'pedidos' FROM ccp
                   WHERE r.con AND r.origen = 'movimiento' AND ccp.cobro_id = r.cobro_id AND r.concepto LIKE ccp.concepto || ' · %' AND ccp.peso IS NOT NULL
        UNION ALL SELECT pd.comercio_id, pd.peso, 4, 'dia' FROM pd WHERE r.con AND pd.integracion_id = r.integracion_id AND pd.dia = r.dia
        UNION ALL SELECT NULL, 1 - SUM(pd.peso), 4, 'dia' FROM pd WHERE r.con AND pd.integracion_id = r.integracion_id AND pd.dia = r.dia
                   HAVING SUM(pd.peso) < 0.999999
        UNION ALL SELECT pm.comercio_id, pm.peso, 5, 'mes' FROM pm WHERE r.con AND pm.sede_id = r.sede_id AND pm.mes = r.mes AND pm.peso IS NOT NULL
        UNION ALL SELECT ps.comercio_id, ps.peso, 5, 'sociedad' FROM ps WHERE r.soc AND ps.sociedad_id = r.sociedad_id AND ps.mes = r.mes AND ps.peso IS NOT NULL
        UNION ALL SELECT NULL, 1, 6, 'sin datos' WHERE r.con OR r.soc
      ) y
    ) z WHERE z.prio = z.mejor
  ) a;
