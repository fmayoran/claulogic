-- Ajustes de resultado sin plata (pedido de Fer, 18/11/2026). Las ventas de septiembre (anteriores al inicio del control, 01/10)
-- están cargadas y los gastos de ese mes no: el estado de resultados del año mostraba septiembre como ganancia. Un ajuste es un hecho
-- del estado de resultados que no mueve ninguna cuenta (la plata ya está en los saldos iniciales del 01/10). Libro inmutable, como los otros.
CREATE TABLE fin.ajuste_resultado (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sede_id       uuid NOT NULL REFERENCES org.sede(id),
  dia           date NOT NULL,
  rubro_id      uuid NOT NULL REFERENCES fin.rubro(id),
  importe       numeric(16,2) NOT NULL CHECK (importe <> 0),
  concepto      text NOT NULL CHECK (btrim(concepto) <> ''),
  registrado_por text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('logic.usuario', true), ''), current_user),
  registrado_en timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION fin.ajuste_resultado_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Un ajuste de resultado no se modifica ni se borra: se asienta otro que lo compense.'; END $$;
CREATE TRIGGER ajuste_resultado_inmutable BEFORE UPDATE OR DELETE ON fin.ajuste_resultado FOR EACH ROW EXECUTE FUNCTION fin.ajuste_resultado_inmutable();
CREATE TRIGGER ajuste_resultado_trunc BEFORE TRUNCATE ON fin.ajuste_resultado FOR EACH STATEMENT EXECUTE FUNCTION fin.ajuste_resultado_inmutable();

INSERT INTO fin.rubro (nombre, linea, clave, orden)
VALUES ('Gastos anteriores al sistema (sin detalle)', 'operativos', 'previo_sistema', (SELECT COALESCE(MAX(orden), 100) + 1 FROM fin.rubro WHERE linea = 'operativos'));

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
          WHERE m.tipo <> 'anulacion'::text AND NOT (EXISTS ( SELECT 1
                   FROM fin.movimiento_tes a
                  WHERE a.anula_a = m.id))
        )
 SELECT i.sede_id,
    t.dia,
    ( SELECT rubro.id
           FROM fin.rubro
          WHERE rubro.clave = 'ventas'::text) AS rubro_id,
    sum(COALESCE(t.total, it.vendido, 0::numeric))::numeric(16,2) AS importe,
    'ventas'::text AS origen,
    NULL::bigint AS movimiento_id,
    'Ventas de '::text || i.nombre AS concepto,
    i.id AS integracion_id,
    NULL::uuid AS ticket_id,
    NULL::uuid AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM pos.ticket t
     JOIN pos.integracion i ON i.id = t.integracion_id
     JOIN org.sede s ON s.id = i.sede_id
     LEFT JOIN LATERAL ( SELECT sum(COALESCE(x.importe, x.cantidad * x.precio)) AS vendido
           FROM pos.ticket_item x
          WHERE x.ticket_id = t.id AND NOT x.anulado) it ON true
  WHERE t.estado = 'cerrado'::text
  GROUP BY i.sede_id, t.dia, i.nombre, i.id, s.sociedad_id
UNION ALL
 SELECT kc.sede_id,
    kc.dia,
    ( SELECT rubro.id
           FROM fin.rubro
          WHERE rubro.clave = 'cmv'::text) AS rubro_id,
    sum(kc.valor)::numeric(16,2) AS importe,
    'cmv'::text AS origen,
    NULL::bigint AS movimiento_id,
    'Consumo teórico de lo vendido'::text AS concepto,
    NULL::uuid AS integracion_id,
    NULL::uuid AS ticket_id,
    NULL::uuid AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM kardex_concepto kc
     LEFT JOIN org.sede s ON s.id = kc.sede_id
  WHERE kc.concepto = 'teorico'::text AND kc.valor IS NOT NULL
  GROUP BY kc.sede_id, kc.dia, s.sociedad_id
UNION ALL
 SELECT sd.sede_id,
    COALESCE(tv.dia, m.fecha) AS dia,
        CASE
            WHEN rp.movimiento_id IS NOT NULL THEN rp.rubro_id
            WHEN m.tipo = 'arqueo'::text AND k.rubro_id IS NULL THEN ( SELECT rubro.id
               FROM fin.rubro
              WHERE rubro.clave = 'dif_caja'::text)
            ELSE fin.rubro_de(k.rubro_id, m.gasto, m.concepto)
        END AS rubro_id,
        CASE
            WHEN rp.movimiento_id IS NOT NULL THEN round((m.entrada - m.salida) * rp.f1, 2) - round((m.entrada - m.salida) * rp.f0, 2)
            ELSE m.entrada - m.salida
        END AS importe,
    'movimiento'::text AS origen,
    m.id AS movimiento_id,
    m.concepto,
    COALESCE(iv.id, co.integracion_id) AS integracion_id,
    tv.id AS ticket_id,
    m.pos_cobro_id AS cobro_id,
    k.comercio_id,
        CASE
            WHEN sd.sede_id IS NOT NULL THEN ( SELECT s.sociedad_id
               FROM org.sede s
              WHERE s.id = sd.sede_id)
            ELSE cu.sociedad_id
        END AS sociedad_id
   FROM vivos m
     JOIN fin.cuenta cu ON cu.id = m.cuenta_id
     LEFT JOIN fin.clasificacion k ON k.movimiento_id = m.id
     LEFT JOIN fin.reparto_pago rp ON rp.movimiento_id = m.id AND k.movimiento_id IS NULL
     LEFT JOIN fin.rubro rr ON rr.id = rp.rubro_id
     LEFT JOIN pos.ticket_pago tp ON tp.id = m.ticket_pago_id
     LEFT JOIN pos.ticket tv ON tv.id = tp.ticket_id
     LEFT JOIN pos.integracion iv ON iv.id = tv.integracion_id
     LEFT JOIN pos.cobro co ON co.id = m.pos_cobro_id
     LEFT JOIN pos.integracion ic ON ic.id = co.integracion_id
     CROSS JOIN LATERAL ( SELECT COALESCE(
                CASE
                    WHEN rr.del_centro THEN ( SELECT sc.id
                       FROM org.sede sc
                      WHERE sc.es_central)
                    ELSE NULL::uuid
                END, k.sede_id, iv.sede_id, ic.sede_id,
                CASE
                    WHEN cu.sociedad_id IS NULL OR cu.tipo = 'caja'::text THEN cu.sede_id
                    ELSE NULL::uuid
                END) AS sede_id) sd
  WHERE ((m.tipo = ANY (ARRAY['ingreso'::text, 'egreso'::text, 'arqueo'::text])) OR (m.tipo = ANY (ARRAY['pago'::text, 'debito_cheque'::text])) AND m.orden_pago_id IS NOT NULL) AND NOT (m.gasto IS NULL AND m.concepto = 'Saldo de apertura según extracto'::text) AND NOT (EXISTS ( SELECT 1
           FROM fin.lote l
          WHERE l.costo_movimiento_id = m.id))
UNION ALL
 SELECT i.sede_id,
    t.dia,
    ( SELECT rubro.id
           FROM fin.rubro
          WHERE rubro.clave = 'comision'::text) AS rubro_id,
    - (p.importe - p.neto) AS importe,
    'lote'::text AS origen,
    l.costo_movimiento_id AS movimiento_id,
    'Costo de cobro · venta '::text || COALESCE(t.id_externo, ''::text) AS concepto,
    i.id AS integracion_id,
    t.id AS ticket_id,
    NULL::uuid AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM fin.lote l
     JOIN vivos cm ON cm.id = l.costo_movimiento_id
     JOIN pos.ticket_pago p ON p.lote_id = l.id
     JOIN pos.ticket t ON t.id = p.ticket_id
     JOIN pos.integracion i ON i.id = t.integracion_id
     JOIN org.sede s ON s.id = i.sede_id
  WHERE p.neto IS NOT NULL AND p.importe <> p.neto
UNION ALL
 SELECT i.sede_id,
    t.dia,
    ( SELECT rubro.id
           FROM fin.rubro
          WHERE rubro.clave = 'dif_acreditacion'::text) AS rubro_id,
    d.dif AS importe,
    'acreditacion'::text AS origen,
    d.mov AS movimiento_id,
    d.concepto,
    i.id AS integracion_id,
    t.id AS ticket_id,
    NULL::uuid AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM ( SELECT x.transferencia_id,
            sum(x.entrada) - sum(x.salida) AS dif,
            min(x.id) AS mov,
            max(x.concepto) AS concepto,
            (array_agg(x.ticket_pago_id) FILTER (WHERE x.ticket_pago_id IS NOT NULL))[1] AS pago
           FROM vivos x
          WHERE x.tipo = 'transferencia'::text AND x.transferencia_id IS NOT NULL
          GROUP BY x.transferencia_id
         HAVING sum(x.entrada) <> sum(x.salida)) d
     JOIN pos.ticket_pago p ON p.id = d.pago
     JOIN pos.ticket t ON t.id = p.ticket_id
     JOIN pos.integracion i ON i.id = t.integracion_id
     JOIN org.sede s ON s.id = i.sede_id
UNION ALL
 SELECT i.sede_id,
    c.dia,
    ( SELECT rubro.id
           FROM fin.rubro
          WHERE rubro.clave = 'dif_cobro'::text) AS rubro_id,
    c.diferencia AS importe,
    'cobro'::text AS origen,
    NULL::bigint AS movimiento_id,
    'Diferencia de cobro: '::text || COALESCE(c.motivo_diferencia, ''::text) AS concepto,
    i.id AS integracion_id,
    NULL::uuid AS ticket_id,
    c.id AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM pos.cobro c
     JOIN pos.integracion i ON i.id = c.integracion_id
     JOIN org.sede s ON s.id = i.sede_id
  WHERE c.diferencia IS NOT NULL AND c.diferencia <> 0::numeric AND (EXISTS ( SELECT 1
           FROM vivos m
          WHERE m.pos_cobro_id = c.id))
UNION ALL
 SELECT a.sede_id,
    a.dia,
    a.rubro_id,
    a.importe,
    'ajuste'::text AS origen,
    NULL::bigint AS movimiento_id,
    a.concepto,
    NULL::uuid AS integracion_id,
    NULL::uuid AS ticket_id,
    NULL::uuid AS cobro_id,
    NULL::uuid AS comercio_id,
    s.sociedad_id
   FROM fin.ajuste_resultado a
     JOIN org.sede s ON s.id = a.sede_id;

-- Septiembre: CORTAFUEGO perdió $16.866.602 (los gastos fueron lo vendido más eso, cubierto con un aporte de los socios); SORELLE arranca
-- el 01/10 en cero (sus gastos de septiembre, iguales a lo vendido). Un ajuste por local, por lo vendido en septiembre según las ventas.
INSERT INTO fin.ajuste_resultado (sede_id, dia, rubro_id, importe, concepto)
SELECT x.sede_id, DATE '2026-09-30', (SELECT id FROM fin.rubro WHERE clave = 'previo_sistema'),
       -(x.vendido + CASE WHEN s.nombre = 'CORTAFUEGO PARRILLA' THEN 16866602 ELSE 0 END),
       CASE WHEN s.nombre = 'CORTAFUEGO PARRILLA'
            THEN 'Gastos de septiembre sin detalle: lo vendido más la pérdida de $16.866.602 cubierta con un aporte de los socios'
            ELSE 'Gastos de septiembre sin detalle: SORELLE arranca el 01/10 en cero' END
  FROM (SELECT r.sede_id, SUM(r.importe) AS vendido FROM fin.resultado r JOIN fin.rubro ru ON ru.id = r.rubro_id
         WHERE ru.clave = 'ventas' AND r.dia BETWEEN '2026-09-01' AND '2026-09-30' GROUP BY r.sede_id) x
  JOIN org.sede s ON s.id = x.sede_id
 WHERE s.nombre IN ('CORTAFUEGO PARRILLA', 'SORELLE BODEGON Y SUSHI', 'SORELLE CAFETERIA');
