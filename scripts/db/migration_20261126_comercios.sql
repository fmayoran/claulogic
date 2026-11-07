-- Comercios dentro de un local (pedido de Fer, 07/11/2026). SORELLE BODEGON Y SUSHI es un solo punto de venta (un Maxirest,
-- una caja, una cuenta de Mercado Pago) pero dos comercios que se miran por separado: Wera Sushi y Lo de Titi Bodegón.
-- Maxirest no dice de qué carta es cada comprobante (mismos mozos, mismas mesas, y una mesa pide de las dos), así que:
--   · las ventas de Maxirest se reparten POR DÍA con el informe de artículos: los rubros propios de cada comercio van directo
--     y los compartidos (bebidas, postres, guarniciones) en proporción a lo propio de ese día (decisión de Fer). El peso de
--     un comercio en un día es lo propio suyo sobre lo propio de todos;
--   · PedidosYa, pedido por pedido, por su tienda del portal;
--   · lo atado a una venta o a un cobro (costos de cobro, diferencias) sigue a esa venta o a ese día;
--   · un gasto con comercio elegido al clasificarlo es de ése; si no, se prorratea por las ventas del mes (decisión de Fer).
-- Lo financiero (caja, cuentas, rendición, conciliación) no cambia: sigue siendo del local. Nada de esto se guarda como
-- resultado: fin.resultado_comercio lo deriva de fin.resultado, como el resto del estado.

CREATE TABLE org.comercio (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id    uuid NOT NULL REFERENCES org.sede(id),
  nombre     text NOT NULL CHECK (btrim(nombre) <> ''),
  rubros     text[] NOT NULL DEFAULT '{}',
  tiendas    text[] NOT NULL DEFAULT '{}',
  activo     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX comercio_nombre_ux ON org.comercio (sede_id, lower(btrim(nombre)));
COMMENT ON TABLE org.comercio IS 'Comercio (marca) dentro de un local que comparte punto de venta, caja y cuentas con otros: se separa en ventas y resultados.';
COMMENT ON COLUMN org.comercio.rubros IS 'Rubros del sistema de venta (Maxirest) que son propios de este comercio; los demás rubros se reparten en proporción.';
COMMENT ON COLUMN org.comercio.tiendas IS 'ID de tienda de PedidosYa de este comercio.';

-- Lo vendido por artículo cada día, como lo informa el sistema de venta (Maxirest no trae los artículos de cada comprobante,
-- sólo el total del día por artículo, con su rubro). Se reemplaza entero por día al volver a traer: es un dato importado.
CREATE TABLE pos.articulo_dia (
  integracion_id uuid NOT NULL REFERENCES pos.integracion(id),
  dia            date NOT NULL,
  codigo         text NOT NULL,
  nombre         text NOT NULL,
  rubro          text,
  unidades       numeric(14,3) NOT NULL DEFAULT 0,
  venta          numeric(16,2) NOT NULL DEFAULT 0,
  traido_en      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integracion_id, dia, codigo)
);
COMMENT ON TABLE pos.articulo_dia IS 'Venta por artículo y día según el sistema de venta (informe de artículos de Maxirest).';

-- PedidosYa: la tienda del portal de cada pedido (un archivo puede juntar varias). Los ya importados la reciben al volver a
-- importar el archivo.
ALTER TABLE pos.ticket ADD COLUMN tienda text;

-- El comercio de un gasto, si es de uno solo (si no, se prorratea).
ALTER TABLE fin.clasificacion ADD COLUMN comercio_id uuid REFERENCES org.comercio(id);

-- fin.resultado con lo que hace falta para repartir: de qué sistema de venta, venta o cobro sale cada hecho, y el comercio
-- elegido al clasificar. Las ventas pasan a ir por sistema de venta (antes por nombre, que es lo mismo: uno por nombre).
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
SELECT COALESCE(k.sede_id, iv.sede_id, cu.sede_id), COALESCE(tv.dia, m.fecha),
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

-- El peso de cada comercio en las ventas de un sistema de venta en un día (0 a 1; lo que no es de ningún comercio queda
-- sin repartir). Maxirest: por el informe de artículos (rubros propios). Tickets con tienda (PedidosYa): por lo vendido en
-- los pedidos de las tiendas de cada comercio.
CREATE VIEW pos.comercio_peso_dia AS
WITH propio AS (
  SELECT a.integracion_id, i.sede_id, a.dia, c.id AS comercio_id, SUM(a.venta) AS v
    FROM pos.articulo_dia a JOIN pos.integracion i ON i.id = a.integracion_id
    JOIN org.comercio c ON c.sede_id = i.sede_id AND c.activo
                       AND EXISTS (SELECT 1 FROM unnest(c.rubros) r WHERE lower(btrim(r)) = lower(btrim(a.rubro)))
   GROUP BY 1, 2, 3, 4),
tienda AS (
  SELECT t.integracion_id, i.sede_id, t.dia, c.id AS comercio_id, SUM(COALESCE(t.total, 0)) AS v
    FROM pos.ticket t JOIN pos.integracion i ON i.id = t.integracion_id
    JOIN org.comercio c ON c.sede_id = i.sede_id AND c.activo AND t.tienda = ANY (c.tiendas)
   WHERE t.estado = 'cerrado' AND t.tienda IS NOT NULL
   GROUP BY 1, 2, 3, 4),
tienda_total AS (
  SELECT t.integracion_id, t.dia, SUM(COALESCE(t.total, 0)) AS v FROM pos.ticket t
   WHERE t.estado = 'cerrado' AND (t.integracion_id, t.dia) IN (SELECT integracion_id, dia FROM tienda)
   GROUP BY 1, 2)
SELECT integracion_id, sede_id, dia, comercio_id, (v / SUM(v) OVER (PARTITION BY integracion_id, dia))::numeric AS peso
  FROM propio WHERE v > 0
UNION ALL
SELECT x.integracion_id, x.sede_id, x.dia, x.comercio_id, (x.v / tt.v)::numeric
  FROM tienda x JOIN tienda_total tt USING (integracion_id, dia) WHERE tt.v <> 0;

-- El estado de resultados repartido por comercio: cada hecho de una sede con comercios, en una fila por comercio con su
-- parte (peso). Orden de las reglas, de más a menos precisa: el comercio elegido al clasificar; la tienda de la venta a la
-- que está atado; los costos de PedidosYa de un cobro, por lo que costó cada pedido de cada comercio (mismo concepto); el
-- peso del día de su sistema de venta (lo no repartido queda sin comercio); el peso del mes de la sede (las ventas del mes
-- repartidas, sólo entre comercios); y si no hay con qué, sin comercio. Las sedes sin comercios pasan enteras.
CREATE VIEW fin.resultado_comercio AS
WITH r AS (
  SELECT x.*, date_trunc('month', x.dia)::date AS mes,
         EXISTS (SELECT 1 FROM org.comercio c WHERE c.sede_id = x.sede_id AND c.activo) AS con
    FROM fin.resultado x),
pd AS (SELECT * FROM pos.comercio_peso_dia),
vm AS (
  SELECT r.sede_id, r.mes, pd.comercio_id, SUM(r.importe * pd.peso) AS v
    FROM r JOIN pd ON pd.integracion_id = r.integracion_id AND pd.dia = r.dia
   WHERE r.origen = 'ventas' GROUP BY 1, 2, 3),
pm AS (SELECT sede_id, mes, comercio_id, v / NULLIF(SUM(v) OVER (PARTITION BY sede_id, mes), 0) AS peso FROM vm),
cc AS (
  SELECT p.cobro_id, x->>'concepto' AS concepto, c.id AS comercio_id, SUM((x->>'importe')::numeric) AS v
    FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
    LEFT JOIN org.comercio c ON c.sede_id = i.sede_id AND c.activo AND t.tienda = ANY (c.tiendas)
    CROSS JOIN LATERAL jsonb_array_elements(p.costos) x
   WHERE p.costos IS NOT NULL AND p.cobro_id IS NOT NULL
   GROUP BY 1, 2, 3),
ccp AS (SELECT cobro_id, concepto, comercio_id, v / NULLIF(SUM(v) OVER (PARTITION BY cobro_id, concepto), 0) AS peso FROM cc)
SELECT r.sede_id, r.dia, r.rubro_id, (r.importe * a.peso)::numeric(16,2) AS importe, r.origen, r.movimiento_id, r.concepto,
       a.comercio_id, a.peso, a.regla
  FROM r CROSS JOIN LATERAL (
    SELECT z.comercio_id, z.peso, z.regla FROM (
      SELECT y.*, MIN(y.prio) OVER () AS mejor FROM (
        SELECT NULL::uuid AS comercio_id, 1::numeric AS peso, 0 AS prio, 'sin comercios' AS regla WHERE NOT r.con
        UNION ALL SELECT r.comercio_id, 1, 1, 'elegido' WHERE r.con AND r.comercio_id IS NOT NULL
        UNION ALL SELECT c.id, 1, 2, 'tienda' FROM pos.ticket t JOIN org.comercio c ON c.sede_id = r.sede_id AND c.activo AND t.tienda = ANY (c.tiendas)
                   WHERE r.con AND t.id = r.ticket_id
        UNION ALL SELECT ccp.comercio_id, ccp.peso, 3, 'pedidos' FROM ccp
                   WHERE r.con AND r.origen = 'movimiento' AND ccp.cobro_id = r.cobro_id AND r.concepto LIKE ccp.concepto || ' · %' AND ccp.peso IS NOT NULL
        UNION ALL SELECT pd.comercio_id, pd.peso, 4, 'dia' FROM pd WHERE r.con AND pd.integracion_id = r.integracion_id AND pd.dia = r.dia
        UNION ALL SELECT NULL, 1 - SUM(pd.peso), 4, 'dia' FROM pd WHERE r.con AND pd.integracion_id = r.integracion_id AND pd.dia = r.dia
                   HAVING SUM(pd.peso) < 0.999999
        UNION ALL SELECT pm.comercio_id, pm.peso, 5, 'mes' FROM pm WHERE r.con AND pm.sede_id = r.sede_id AND pm.mes = r.mes AND pm.peso IS NOT NULL
        UNION ALL SELECT NULL, 1, 6, 'sin datos' WHERE r.con
      ) y
    ) z WHERE z.prio = z.mejor
  ) a;

-- SORELLE BODEGON Y SUSHI: sus dos comercios, con los rubros propios de cada carta en Maxirest y su tienda de PedidosYa.
INSERT INTO org.comercio (sede_id, nombre, rubros, tiendas)
SELECT s.id, x.nombre, x.rubros, x.tiendas FROM org.sede s
 CROSS JOIN (VALUES ('Wera Sushi', '{"Wera Sushi","Rollls Especiales"}'::text[], '{528403}'::text[]),
                    ('Lo de Titi Bodegón', '{"Bodegon","Sugerencias Del Cheff"}'::text[], '{547527}'::text[])) x(nombre, rubros, tiendas)
 WHERE s.nombre = 'SORELLE BODEGON Y SUSHI';
