-- Catálogo y estado de resultados unificados (decisión de Fer, 17/11/2026: "no podemos reclasificar a mano para siempre"; las
-- categorías de productos tienen que ser las mismas que los rubros de mercadería del estado de resultados).
--  1. Cada categoría de productos ES un rubro: logic.categoria.rubro_id (único). Crear o renombrar o desactivar una categoría hace lo
--     mismo con su rubro ("Mercadería · <nombre>", del centro) y al revés: un rubro "Mercadería · X" nuevo crea la categoría X. La única
--     categoría sin rubro es la de los elaborados (se producen, no se compran: su costo sale de los ingredientes).
--  2. Insumos que se guardan en stock pero no son mercadería (descartables, limpieza, vajilla) también son categorías: apuntan a su
--     rubro, que sigue en Gastos operativos.
--  3. El renglón de un comprobante sin producto (flete, servicio) lleva su rubro (fin.comprobante_item.rubro_id); con producto, el de
--     su categoría (o el elegido, si se eligió uno).
--  4. El pago de un comprobante (orden de pago, o un egreso vinculado con fin.pago_previo) sin clasificar a mano NO se clasifica: se
--     REPARTE, derivado, entre los rubros de los renglones de lo que paga, en proporción a sus importes (fin.reparto_pago). Lo del
--     centro va a la sede central, como en fin.clasificacion. Clasificarlo a mano sigue mandando. Los pagos con orden de pago entran
--     ahora al estado de resultados (antes no entraban: no había ninguno).

ALTER TABLE logic.categoria
  ADD COLUMN rubro_id uuid UNIQUE REFERENCES fin.rubro(id),
  ADD COLUMN elaborados boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN logic.categoria.rubro_id IS 'Rubro del estado de resultados de lo que se compra en esta categoría (se mantienen sincronizados).';
COMMENT ON COLUMN logic.categoria.elaborados IS 'Categoría de productos elaborados: no se compran, no tiene rubro.';

-- Lo que hay: cada categoría con su "Mercadería · <nombre>".
UPDATE logic.categoria c SET rubro_id = r.id FROM fin.rubro r WHERE r.nombre = 'Mercadería · ' || c.nombre;
-- SANDWICHS (un solo producto, elaborado) pasa a ser la de los elaborados.
UPDATE logic.categoria SET nombre = 'Elaborados', prefijo = 'ELA', elaborados = true WHERE nombre = 'SANDWICHS';
-- Los rubros de mercadería y los del centro sin categoría la reciben (Leña, Pastas, Descartables y packaging, Limpieza, Vajilla y
-- utensilios). "Mercadería varios" (compras sin detalle a mayoristas) y el costo de mercadería vendida no son categorías.
INSERT INTO logic.categoria (nombre, rubro_id)
SELECT regexp_replace(r.nombre, '^Mercadería · ', ''), r.id FROM fin.rubro r
 WHERE r.activo AND r.clave IS NULL AND (r.nombre LIKE 'Mercadería · %' OR (r.del_centro AND r.linea <> 'cmv'))
   AND NOT EXISTS (SELECT 1 FROM logic.categoria c WHERE c.rubro_id = r.id);

ALTER TABLE logic.categoria ADD CONSTRAINT categoria_rubro_check CHECK (elaborados OR rubro_id IS NOT NULL);

-- ── Sincronización ──
CREATE OR REPLACE FUNCTION logic.nombre_rubro_de(cat text, rubro_actual text) RETURNS text AS $$
  SELECT CASE WHEN rubro_actual IS NULL OR rubro_actual LIKE 'Mercadería · %' THEN 'Mercadería · ' || cat ELSE cat END
$$ LANGUAGE sql IMMUTABLE;

-- Categoría nueva sin rubro: toma el rubro de su nombre si existe y está libre; si no, lo crea (mercadería, del centro).
CREATE OR REPLACE FUNCTION logic.categoria_rubro_alta() RETURNS trigger AS $$
DECLARE rid uuid;
BEGIN
  IF NEW.elaborados THEN NEW.rubro_id := NULL; RETURN NEW; END IF;
  IF NEW.rubro_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT r.id INTO rid FROM fin.rubro r
   WHERE lower(r.nombre) IN (lower('Mercadería · ' || btrim(NEW.nombre)), lower(btrim(NEW.nombre))) AND r.clave IS NULL
     AND NOT EXISTS (SELECT 1 FROM logic.categoria c WHERE c.rubro_id = r.id) LIMIT 1;
  IF rid IS NULL THEN
    INSERT INTO fin.rubro (nombre, linea, del_centro, orden)
    VALUES ('Mercadería · ' || btrim(NEW.nombre), 'cmv', true, (SELECT COALESCE(MAX(orden), 100) + 1 FROM fin.rubro WHERE linea = 'cmv'))
    RETURNING id INTO rid;
  END IF;
  NEW.rubro_id := rid;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER categoria_rubro_alta BEFORE INSERT OR UPDATE OF elaborados ON logic.categoria
  FOR EACH ROW EXECUTE FUNCTION logic.categoria_rubro_alta();

-- Renombrar o desactivar una categoría hace lo mismo con su rubro (y al revés). Cada lado sólo escribe si hay diferencia, así la
-- vuelta no rebota.
CREATE OR REPLACE FUNCTION logic.categoria_rubro_sync() RETURNS trigger AS $$
BEGIN
  IF NEW.rubro_id IS NOT NULL THEN
    UPDATE fin.rubro r SET nombre = logic.nombre_rubro_de(NEW.nombre, r.nombre), activo = NEW.activa
     WHERE r.id = NEW.rubro_id AND (r.nombre IS DISTINCT FROM logic.nombre_rubro_de(NEW.nombre, r.nombre) OR r.activo IS DISTINCT FROM NEW.activa);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER categoria_rubro_sync AFTER UPDATE OF nombre, activa, rubro_id ON logic.categoria
  FOR EACH ROW EXECUTE FUNCTION logic.categoria_rubro_sync();

CREATE OR REPLACE FUNCTION fin.rubro_categoria_sync() RETURNS trigger AS $$
DECLARE cat text := regexp_replace(NEW.nombre, '^Mercadería · ', '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Un rubro de mercadería nuevo (desde Rubros y reglas, egresos o conciliación) crea su categoría, salvo que lo esté creando
    -- una categoría (pg_trigger_depth > 1).
    IF pg_trigger_depth() = 1 AND NEW.clave IS NULL AND NEW.nombre LIKE 'Mercadería · %'
       AND NOT EXISTS (SELECT 1 FROM logic.categoria c WHERE lower(btrim(c.nombre)) = lower(cat)) THEN
      INSERT INTO logic.categoria (nombre, rubro_id, activa) VALUES (cat, NEW.id, NEW.activo);
    END IF;
  ELSE
    UPDATE logic.categoria c SET nombre = cat, activa = NEW.activo
     WHERE c.rubro_id = NEW.id AND (c.nombre IS DISTINCT FROM cat OR c.activa IS DISTINCT FROM NEW.activo);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rubro_categoria_sync AFTER INSERT OR UPDATE OF nombre, activo ON fin.rubro
  FOR EACH ROW EXECUTE FUNCTION fin.rubro_categoria_sync();

-- ── Rubro del renglón ──
ALTER TABLE fin.comprobante_item ADD COLUMN rubro_id uuid REFERENCES fin.rubro(id);
COMMENT ON COLUMN fin.comprobante_item.rubro_id IS 'Rubro del renglón. Vacío con producto: el de su categoría. Vacío sin producto: sin clasificar.';

-- ── Reparto del pago de un comprobante entre los rubros de sus renglones ──
-- Peso de cada rubro = lo aplicado a cada comprobante (nota de crédito en negativo) × la parte del renglón en el neto del comprobante.
-- f0 y f1 son la fracción acumulada antes y después de cada rubro: el importe de cada parte es round(total × f1) − round(total × f0),
-- así las partes suman exacto el movimiento.
CREATE VIEW fin.reparto_pago AS
WITH aplicado AS (
  SELECT m.id AS movimiento_id, a.comprobante_id, a.importe
    FROM fin.movimiento_tes m JOIN fin.orden_pago_aplicacion a ON a.orden_pago_id = m.orden_pago_id
   WHERE m.tipo IN ('pago', 'debito_cheque')
  UNION ALL
  SELECT pp.movimiento_id, pp.comprobante_id, pp.importe FROM fin.pago_previo pp
), pesos AS (
  SELECT ap.movimiento_id, COALESCE(ci.rubro_id, ca.rubro_id) AS rubro_id,
         sum(CASE WHEN c.tipo = 'nota_credito' THEN -1 ELSE 1 END * ap.importe * ci.importe / t.neto) AS peso
    FROM aplicado ap
    JOIN fin.comprobante c ON c.id = ap.comprobante_id
    JOIN LATERAL (SELECT sum(x.importe) AS neto FROM fin.comprobante_item x WHERE x.comprobante_id = c.id) t ON t.neto > 0
    JOIN fin.comprobante_item ci ON ci.comprobante_id = c.id
    LEFT JOIN logic.producto p ON p.id = ci.producto_id
    LEFT JOIN logic.categoria ca ON ca.id = p.categoria_id
   GROUP BY 1, 2
), tot AS (
  SELECT *, sum(peso) OVER (PARTITION BY movimiento_id) AS total,
         sum(peso) OVER (PARTITION BY movimiento_id ORDER BY rubro_id NULLS LAST ROWS UNBOUNDED PRECEDING) AS acum
    FROM pesos
)
SELECT movimiento_id, rubro_id, (acum - peso) / total AS f0, acum / total AS f1
  FROM tot WHERE total > 0;
COMMENT ON VIEW fin.reparto_pago IS
  'Cómo se reparte entre rubros el pago de comprobantes (orden de pago o pago previo) según sus renglones; lo usa fin.resultado si el movimiento no está clasificado a mano.';

CREATE OR REPLACE VIEW fin.resultado AS
WITH vivos AS (
         SELECT m.id,
            m.ocurrido_en,
            m.fecha,
            m.cuenta_id,
            m.tipo,
            m.entrada,
            m.salida,
            m.concepto,
            m.orden_pago_id,
            m.cheque_id,
            m.transferencia_id,
            m.anula_a,
            m.registrado_por,
            m.pos_cobro_id,
            m.gasto,
            m.iva,
            m.ticket_pago_id
           FROM fin.movimiento_tes m
          WHERE ((m.tipo <> 'anulacion'::text) AND (NOT (EXISTS ( SELECT 1
                   FROM fin.movimiento_tes a
                  WHERE (a.anula_a = m.id)))))
        )
 SELECT i.sede_id,
    t.dia,
    ( SELECT rubro.id
           FROM fin.rubro
          WHERE (rubro.clave = 'ventas'::text)) AS rubro_id,
    (sum(COALESCE(t.total, it.vendido, (0)::numeric)))::numeric(16,2) AS importe,
    'ventas'::text AS origen,
    NULL::bigint AS movimiento_id,
    ('Ventas de '::text || i.nombre) AS concepto,
    i.id AS integracion_id,
    NULL::uuid AS ticket_id,
    NULL::uuid AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM (((pos.ticket t
     JOIN pos.integracion i ON ((i.id = t.integracion_id)))
     JOIN org.sede s ON ((s.id = i.sede_id)))
     LEFT JOIN LATERAL ( SELECT sum(COALESCE(x.importe, (x.cantidad * x.precio))) AS vendido
           FROM pos.ticket_item x
          WHERE ((x.ticket_id = t.id) AND (NOT x.anulado))) it ON (true))
  WHERE (t.estado = 'cerrado'::text)
  GROUP BY i.sede_id, t.dia, i.nombre, i.id, s.sociedad_id
UNION ALL
 SELECT kc.sede_id,
    kc.dia,
    ( SELECT rubro.id
           FROM fin.rubro
          WHERE (rubro.clave = 'cmv'::text)) AS rubro_id,
    (sum(kc.valor))::numeric(16,2) AS importe,
    'cmv'::text AS origen,
    NULL::bigint AS movimiento_id,
    'Consumo teórico de lo vendido'::text AS concepto,
    NULL::uuid AS integracion_id,
    NULL::uuid AS ticket_id,
    NULL::uuid AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM (kardex_concepto kc
     LEFT JOIN org.sede s ON ((s.id = kc.sede_id)))
  WHERE ((kc.concepto = 'teorico'::text) AND (kc.valor IS NOT NULL))
  GROUP BY kc.sede_id, kc.dia, s.sociedad_id
UNION ALL
 SELECT sd.sede_id,
    COALESCE(tv.dia, m.fecha) AS dia,
        CASE
            WHEN (rp.movimiento_id IS NOT NULL) THEN rp.rubro_id
            WHEN ((m.tipo = 'arqueo'::text) AND (k.rubro_id IS NULL)) THEN ( SELECT rubro.id
               FROM fin.rubro
              WHERE (rubro.clave = 'dif_caja'::text))
            ELSE fin.rubro_de(k.rubro_id, m.gasto, m.concepto)
        END AS rubro_id,
        CASE
            WHEN (rp.movimiento_id IS NOT NULL) THEN (round(((m.entrada - m.salida) * rp.f1), 2) - round(((m.entrada - m.salida) * rp.f0), 2))
            ELSE (m.entrada - m.salida)
        END AS importe,
    'movimiento'::text AS origen,
    m.id AS movimiento_id,
    m.concepto,
    COALESCE(iv.id, co.integracion_id) AS integracion_id,
    tv.id AS ticket_id,
    m.pos_cobro_id AS cobro_id,
    k.comercio_id,
        CASE
            WHEN (sd.sede_id IS NOT NULL) THEN ( SELECT s.sociedad_id
               FROM org.sede s
              WHERE (s.id = sd.sede_id))
            ELSE cu.sociedad_id
        END AS sociedad_id
   FROM ((((((((((vivos m
     JOIN fin.cuenta cu ON ((cu.id = m.cuenta_id)))
     LEFT JOIN fin.clasificacion k ON ((k.movimiento_id = m.id)))
     LEFT JOIN fin.reparto_pago rp ON (((rp.movimiento_id = m.id) AND (k.movimiento_id IS NULL))))
     LEFT JOIN fin.rubro rr ON ((rr.id = rp.rubro_id)))
     LEFT JOIN pos.ticket_pago tp ON ((tp.id = m.ticket_pago_id)))
     LEFT JOIN pos.ticket tv ON ((tv.id = tp.ticket_id)))
     LEFT JOIN pos.integracion iv ON ((iv.id = tv.integracion_id)))
     LEFT JOIN pos.cobro co ON ((co.id = m.pos_cobro_id)))
     LEFT JOIN pos.integracion ic ON ((ic.id = co.integracion_id)))
     CROSS JOIN LATERAL ( SELECT COALESCE(CASE WHEN rr.del_centro THEN (SELECT sc.id FROM org.sede sc WHERE sc.es_central) END, k.sede_id, iv.sede_id, ic.sede_id,
                CASE
                    WHEN ((cu.sociedad_id IS NULL) OR (cu.tipo = 'caja'::text)) THEN cu.sede_id
                    ELSE NULL::uuid
                END) AS sede_id) sd)
  WHERE (((m.tipo = ANY (ARRAY['ingreso'::text, 'egreso'::text, 'arqueo'::text])) OR ((m.tipo = ANY (ARRAY['pago'::text, 'debito_cheque'::text])) AND (m.orden_pago_id IS NOT NULL))) AND (NOT ((m.gasto IS NULL) AND (m.concepto = 'Saldo de apertura según extracto'::text))) AND (NOT (EXISTS ( SELECT 1
           FROM fin.lote l
          WHERE (l.costo_movimiento_id = m.id)))))
UNION ALL
 SELECT i.sede_id,
    t.dia,
    ( SELECT rubro.id
           FROM fin.rubro
          WHERE (rubro.clave = 'comision'::text)) AS rubro_id,
    (- (p.importe - p.neto)) AS importe,
    'lote'::text AS origen,
    l.costo_movimiento_id AS movimiento_id,
    ('Costo de cobro · venta '::text || COALESCE(t.id_externo, ''::text)) AS concepto,
    i.id AS integracion_id,
    t.id AS ticket_id,
    NULL::uuid AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM (((((fin.lote l
     JOIN vivos cm ON ((cm.id = l.costo_movimiento_id)))
     JOIN pos.ticket_pago p ON ((p.lote_id = l.id)))
     JOIN pos.ticket t ON ((t.id = p.ticket_id)))
     JOIN pos.integracion i ON ((i.id = t.integracion_id)))
     JOIN org.sede s ON ((s.id = i.sede_id)))
  WHERE ((p.neto IS NOT NULL) AND (p.importe <> p.neto))
UNION ALL
 SELECT i.sede_id,
    t.dia,
    ( SELECT rubro.id
           FROM fin.rubro
          WHERE (rubro.clave = 'dif_acreditacion'::text)) AS rubro_id,
    d.dif AS importe,
    'acreditacion'::text AS origen,
    d.mov AS movimiento_id,
    d.concepto,
    i.id AS integracion_id,
    t.id AS ticket_id,
    NULL::uuid AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM ((((( SELECT x.transferencia_id,
            (sum(x.entrada) - sum(x.salida)) AS dif,
            min(x.id) AS mov,
            max(x.concepto) AS concepto,
            (array_agg(x.ticket_pago_id) FILTER (WHERE (x.ticket_pago_id IS NOT NULL)))[1] AS pago
           FROM vivos x
          WHERE ((x.tipo = 'transferencia'::text) AND (x.transferencia_id IS NOT NULL))
          GROUP BY x.transferencia_id
         HAVING (sum(x.entrada) <> sum(x.salida))) d
     JOIN pos.ticket_pago p ON ((p.id = d.pago)))
     JOIN pos.ticket t ON ((t.id = p.ticket_id)))
     JOIN pos.integracion i ON ((i.id = t.integracion_id)))
     JOIN org.sede s ON ((s.id = i.sede_id)))
UNION ALL
 SELECT i.sede_id,
    c.dia,
    ( SELECT rubro.id
           FROM fin.rubro
          WHERE (rubro.clave = 'dif_cobro'::text)) AS rubro_id,
    c.diferencia AS importe,
    'cobro'::text AS origen,
    NULL::bigint AS movimiento_id,
    ('Diferencia de cobro: '::text || COALESCE(c.motivo_diferencia, ''::text)) AS concepto,
    i.id AS integracion_id,
    NULL::uuid AS ticket_id,
    c.id AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM ((pos.cobro c
     JOIN pos.integracion i ON ((i.id = c.integracion_id)))
     JOIN org.sede s ON ((s.id = i.sede_id)))
  WHERE ((c.diferencia IS NOT NULL) AND (c.diferencia <> (0)::numeric) AND (EXISTS ( SELECT 1
           FROM vivos m
          WHERE (m.pos_cobro_id = c.id))));
