-- Organización del grupo (decisiones de Fer, 07/11/2026). Hasta acá "sede" mezclaba el lugar físico, la filial de las cuentas y el
-- punto de venta. Queda así:
--   · Grupo CF CENTRAL: el holding que consolida, sin sociedad. Es dueño del centro de producción y de la caja mayor.
--   · Sociedad (org.sociedad): CORTAFUEGO SRL y SORELLE CIUCIO S.A. Son dueñas de las cuentas bancarias y de las cuentas de cobro
--     (Mercado Pago, Pago24, Fudo Pagos, PedidosYa), que pueden usar varios stores.
--   · Local (org.sede tipo local): el lugar físico, de una sociedad, con su depósito, su caja de efectivo y sus sistemas de venta.
--   · Store (org.comercio; "Store" en pantalla): lo que se vende con una marca. Un local tiene uno o más; si tiene varios, las ventas
--     se reparten como hasta ahora (rubros del sistema de venta y tiendas de PedidosYa). Con uno solo, todo es de ése.
-- El centro no tiene sociedad (es del grupo). Las facturas de compra a nombre de cada sociedad quedan para una etapa siguiente.

CREATE TABLE org.sociedad (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     text NOT NULL CHECK (btrim(nombre) <> ''),
  cuit       text UNIQUE CHECK (cuit IS NULL OR fin.cuit_valido(cuit)),
  activa     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sociedad_nombre_ux ON org.sociedad (lower(btrim(nombre)));

ALTER TABLE org.sede ADD COLUMN sociedad_id uuid REFERENCES org.sociedad(id);
ALTER TABLE fin.cuenta ADD COLUMN sociedad_id uuid REFERENCES org.sociedad(id);
ALTER TABLE fin.procesador ADD COLUMN sociedad_id uuid REFERENCES org.sociedad(id);

INSERT INTO org.sociedad (nombre) VALUES ('CORTAFUEGO SRL'), ('SORELLE CIUCIO S.A.');

-- Cada local, a su sociedad; el centro queda en el grupo.
UPDATE org.sede SET sociedad_id = (SELECT id FROM org.sociedad WHERE nombre = 'CORTAFUEGO SRL') WHERE nombre = 'CORTAFUEGO PARRILLA';
UPDATE org.sede SET sociedad_id = (SELECT id FROM org.sociedad WHERE nombre = 'SORELLE CIUCIO S.A.') WHERE nombre IN ('SORELLE BODEGON Y SUSHI', 'SORELLE CAFETERIA');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM org.sede WHERE tipo = 'local' AND sociedad_id IS NULL) THEN
    RAISE EXCEPTION 'Quedó un local sin sociedad: %', (SELECT string_agg(nombre, ', ') FROM org.sede WHERE tipo = 'local' AND sociedad_id IS NULL);
  END IF;
END $$;
ALTER TABLE org.sede ADD CONSTRAINT sede_local_sociedad CHECK (tipo <> 'local' OR sociedad_id IS NOT NULL);

-- Las cuentas, a la sociedad de su sede (la caja mayor de CF CENTRAL queda en el grupo); los procesadores, a la de su cuenta.
UPDATE fin.cuenta c SET sociedad_id = s.sociedad_id FROM org.sede s WHERE s.id = c.sede_id AND s.sociedad_id IS NOT NULL;
UPDATE fin.procesador p SET sociedad_id = c.sociedad_id FROM fin.cuenta c WHERE c.id = p.cuenta_id;

-- Un store por cada local que todavía no tenía (con uno solo, todo es de ése). La cafetería se queda con su tienda de PedidosYa.
INSERT INTO org.comercio (sede_id, nombre, tiendas)
SELECT s.id, CASE s.nombre WHEN 'SORELLE CAFETERIA' THEN 'Di Ciucio Caffe' ELSE s.nombre END,
       COALESCE((SELECT array_agg(DISTINCT t) FROM pos.integracion i, unnest(i.tiendas) t WHERE i.sede_id = s.id AND i.sistema = 'pedidosya'), '{}')
  FROM org.sede s
 WHERE s.tipo = 'local' AND NOT EXISTS (SELECT 1 FROM org.comercio c WHERE c.sede_id = s.id);

-- El peso de cada store en las ventas de un sistema de venta en un día. Con un solo store activo en el local, es 1 (todo es suyo);
-- con varios, como hasta ahora: Maxirest por los rubros propios del informe de artículos, PedidosYa por la tienda de cada pedido.
CREATE OR REPLACE VIEW pos.comercio_peso_dia AS
WITH activos AS (
  SELECT sede_id, COUNT(*) AS n, MIN(id::text)::uuid AS unico FROM org.comercio WHERE activo GROUP BY sede_id
), propio AS (
  SELECT a.integracion_id, i.sede_id, a.dia, c.id AS comercio_id, SUM(a.venta) AS v
    FROM pos.articulo_dia a
    JOIN pos.integracion i ON i.id = a.integracion_id
    JOIN activos ac ON ac.sede_id = i.sede_id AND ac.n > 1
    JOIN org.comercio c ON c.sede_id = i.sede_id AND c.activo
                       AND EXISTS (SELECT 1 FROM unnest(c.rubros) r(r) WHERE lower(btrim(r.r)) = lower(btrim(a.rubro)))
   GROUP BY a.integracion_id, i.sede_id, a.dia, c.id
), tienda AS (
  SELECT t.integracion_id, i.sede_id, t.dia, c.id AS comercio_id, SUM(COALESCE(t.total, 0)) AS v
    FROM pos.ticket t
    JOIN pos.integracion i ON i.id = t.integracion_id
    JOIN activos ac ON ac.sede_id = i.sede_id AND ac.n > 1
    JOIN org.comercio c ON c.sede_id = i.sede_id AND c.activo AND t.tienda = ANY (c.tiendas)
   WHERE t.estado = 'cerrado' AND t.tienda IS NOT NULL
   GROUP BY t.integracion_id, i.sede_id, t.dia, c.id
), tienda_total AS (
  SELECT t.integracion_id, t.dia, SUM(COALESCE(t.total, 0)) AS v
    FROM pos.ticket t
   WHERE t.estado = 'cerrado' AND (t.integracion_id, t.dia) IN (SELECT integracion_id, dia FROM tienda)
   GROUP BY t.integracion_id, t.dia
)
SELECT propio.integracion_id, propio.sede_id, propio.dia, propio.comercio_id,
       propio.v / SUM(propio.v) OVER (PARTITION BY propio.integracion_id, propio.dia) AS peso
  FROM propio WHERE propio.v > 0
UNION ALL
SELECT x.integracion_id, x.sede_id, x.dia, x.comercio_id, x.v / tt.v
  FROM tienda x JOIN tienda_total tt USING (integracion_id, dia)
 WHERE tt.v <> 0
UNION ALL
SELECT d.integracion_id, i.sede_id, d.dia, ac.unico, 1::numeric
  FROM (SELECT DISTINCT integracion_id, dia FROM pos.ticket WHERE estado = 'cerrado') d
  JOIN pos.integracion i ON i.id = d.integracion_id
  JOIN activos ac ON ac.sede_id = i.sede_id AND ac.n = 1;
