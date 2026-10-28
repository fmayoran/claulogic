-- Estado de resultados por filial (pedido de Fer, 28/10/2026). Como el stock, NO se guarda: se deriva de las ventas, del
-- costo teórico de lo vendido y de los movimientos de tesorería. Lo nuevo que se guarda es la clasificación:
--   · fin.rubro: el catálogo de rubros, cada uno en una línea del estado;
--   · fin.clasificacion: rubro y filial de un movimiento, cuando no salen solos (manuales, reglas). Va aparte del libro
--     mayor a propósito: clasificar no mueve plata, y corregir una clasificación no obliga a anular el movimiento;
--   · fin.regla: "en esta cuenta, la línea del extracto cuyo concepto contiene X es del rubro Y", que la conciliación
--     automática aplica sola;
--   · la filial de cada cuenta (fin.cuenta.sede_id, que hasta ahora sólo tenían las cajas).
-- Decisiones de Fer (28/10/2026): devengado (la venta y sus costos de cobro, el día de la venta; lo demás, el día del
-- movimiento); ventas por el total, con IVA (el IVA se ve después en la central); IVA de las comisiones, impuesto a los
-- débitos y créditos y retenciones van como gasto; Ingresos Brutos es lo retenido más lo que se pague por VEP (sale del
-- extracto y se clasifica al aparecer); por ahora todo es de la filial.

CREATE TABLE fin.rubro (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     text NOT NULL UNIQUE CHECK (btrim(nombre) <> ''),
  linea      text NOT NULL CHECK (linea IN ('ventas','cmv','cobro','impuestos','bancarios','operativos','diferencias','otros','fuera')),
  clave      text UNIQUE,                 -- los del sistema: los usan el código y la clasificación de lo ya asentado
  activo     boolean NOT NULL DEFAULT true,
  orden      int NOT NULL DEFAULT 100
);
COMMENT ON COLUMN fin.rubro.linea IS 'Línea del estado de resultados. "fuera": no es resultado (aportes, retiros, préstamos).';

INSERT INTO fin.rubro (nombre, linea, clave, orden) VALUES
  ('Ventas', 'ventas', 'ventas', 10),
  ('Costo de mercadería vendida', 'cmv', 'cmv', 20),
  ('Comisiones de procesadores', 'cobro', 'comision', 30),
  ('IVA de comisiones', 'cobro', 'iva_credito', 31),
  ('Impuesto a los débitos y créditos (Ley 25.413)', 'impuestos', 'imp_debitos_creditos', 40),
  ('Ingresos Brutos (SIRCREB y VEP)', 'impuestos', 'iibb', 41),
  ('Otras retenciones y percepciones', 'impuestos', 'retencion', 42),
  ('Gastos bancarios', 'bancarios', 'bancario', 50),
  ('Otros gastos operativos', 'operativos', 'otro_gasto', 60),
  ('Diferencias de caja', 'diferencias', 'dif_caja', 70),
  ('Diferencias de acreditación', 'diferencias', 'dif_acreditacion', 71),
  ('Diferencias de cobro', 'diferencias', 'dif_cobro', 72),
  ('Otros ingresos', 'otros', 'otro_ingreso', 80),
  ('Aportes, retiros y préstamos', 'fuera', 'fuera', 90);

-- Rubro y filial (centro de costo) de un movimiento: los ponen la clasificación manual y las reglas. Lo asentado por la
-- conciliación se clasifica solo por su tipo de gasto (fin.rubro_de); una clasificación explícita lo reemplaza.
CREATE TABLE fin.clasificacion (
  movimiento_id bigint PRIMARY KEY REFERENCES fin.movimiento_tes(id),
  rubro_id      uuid NOT NULL REFERENCES fin.rubro(id),
  sede_id       uuid REFERENCES org.sede(id),           -- NULL: la de la venta o la de la cuenta
  regla_id      uuid,                                   -- si la puso una regla
  por           text DEFAULT org.usuario_actual(),
  en            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fin.regla (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id  uuid REFERENCES fin.cuenta(id),            -- NULL: cualquier cuenta
  sentido    text NOT NULL CHECK (sentido IN ('egreso','ingreso')),
  patron     text NOT NULL CHECK (length(btrim(patron)) >= 3),
  rubro_id   uuid NOT NULL REFERENCES fin.rubro(id),
  sede_id    uuid REFERENCES org.sede(id),              -- NULL: la filial de la cuenta
  activa     boolean NOT NULL DEFAULT true,
  creada_por text DEFAULT org.usuario_actual(),
  creada_en  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fin.clasificacion ADD FOREIGN KEY (regla_id) REFERENCES fin.regla(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX regla_ux ON fin.regla (COALESCE(cuenta_id, '00000000-0000-0000-0000-000000000000'::uuid), sentido, lower(patron));

-- Rubro de un movimiento: el explícito o, para lo asentado por la conciliación y las diferencias, el de su tipo de gasto.
-- NULL = sin clasificar (no entra en el estado; se muestra aparte para clasificarlo).
CREATE FUNCTION fin.rubro_de(p_rubro uuid, p_gasto text, p_concepto text) RETURNS uuid AS $$
  SELECT COALESCE(p_rubro, (SELECT id FROM fin.rubro WHERE clave = CASE
    WHEN p_gasto = 'retencion' AND p_concepto ~* 'sircreb|iibb|ingresos\s+brutos' THEN 'iibb'
    WHEN p_gasto IN ('comision','iva_credito','imp_debitos_creditos','retencion') THEN p_gasto
    WHEN p_gasto = 'otro' AND p_concepto ~* '^(faltante|sobrante) de caja' THEN 'dif_caja'
    WHEN p_gasto = 'otro' AND p_concepto ~* '^diferencia con el lote' THEN 'dif_acreditacion'
  END))
$$ LANGUAGE sql STABLE;

-- Una línea por hecho con resultado: sede (filial), día devengado, rubro e importe con signo (+ ingresa, - cuesta).
CREATE VIEW fin.resultado AS
WITH vivos AS (
  SELECT m.* FROM fin.movimiento_tes m
   WHERE m.tipo <> 'anulacion' AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = m.id))
-- Ventas: lo vendido de cada día (apertura), por el total, como la jornada del punto de venta.
SELECT i.sede_id, t.dia, (SELECT id FROM fin.rubro WHERE clave = 'ventas') AS rubro_id,
       SUM(COALESCE(t.total, it.vendido, 0))::numeric(16,2) AS importe, 'ventas'::text AS origen, NULL::bigint AS movimiento_id,
       'Ventas de ' || i.nombre AS concepto
  FROM pos.ticket t JOIN pos.integracion i ON i.id = t.integracion_id
  LEFT JOIN LATERAL (SELECT SUM(COALESCE(x.importe, x.cantidad * x.precio)) AS vendido FROM pos.ticket_item x
                      WHERE x.ticket_id = t.id AND NOT x.anulado) it ON true
 WHERE t.estado = 'cerrado'
 GROUP BY i.sede_id, t.dia, i.nombre
UNION ALL
-- Costo de mercadería vendida: el consumo teórico de las ventas (platos), valorizado como en el tablero.
SELECT kc.sede_id, kc.dia, (SELECT id FROM fin.rubro WHERE clave = 'cmv'), SUM(kc.valor)::numeric(16,2), 'cmv', NULL,
       'Consumo teórico de lo vendido'
  FROM logic.kardex_concepto kc WHERE kc.concepto = 'teorico' AND kc.valor IS NOT NULL
 GROUP BY kc.sede_id, kc.dia
UNION ALL
-- Ingresos y egresos: el atado a una venta, en su día y su filial; si no, la filial explícita o la de la cuenta. El
-- sobrante o faltante de un arqueo es una diferencia de caja. El saldo de apertura que deja el primer extracto de una
-- cuenta no es resultado: es lo que ya había.
SELECT COALESCE(k.sede_id, iv.sede_id, cu.sede_id), COALESCE(tv.dia, m.fecha),
       CASE WHEN m.tipo = 'arqueo' AND k.rubro_id IS NULL THEN (SELECT id FROM fin.rubro WHERE clave = 'dif_caja') ELSE fin.rubro_de(k.rubro_id, m.gasto, m.concepto) END,
       m.entrada - m.salida, 'movimiento', m.id, m.concepto
  FROM vivos m JOIN fin.cuenta cu ON cu.id = m.cuenta_id LEFT JOIN fin.clasificacion k ON k.movimiento_id = m.id
  LEFT JOIN pos.ticket_pago tp ON tp.id = m.ticket_pago_id LEFT JOIN pos.ticket tv ON tv.id = tp.ticket_id
  LEFT JOIN pos.integracion iv ON iv.id = tv.integracion_id
 WHERE m.tipo IN ('ingreso','egreso','arqueo')
   AND NOT (m.gasto IS NULL AND m.concepto = 'Saldo de apertura según extracto')
   AND NOT EXISTS (SELECT 1 FROM fin.lote l WHERE l.costo_movimiento_id = m.id)
UNION ALL
-- Costo de un lote confirmado: exacto por cobro (bruto menos el neto que informó el procesador), en el día y la filial
-- de cada venta.
SELECT i.sede_id, t.dia, (SELECT id FROM fin.rubro WHERE clave = 'comision'), -(p.importe - p.neto), 'lote', l.costo_movimiento_id,
       'Costo de cobro · venta ' || COALESCE(t.id_externo, '')
  FROM fin.lote l JOIN vivos cm ON cm.id = l.costo_movimiento_id
  JOIN pos.ticket_pago p ON p.lote_id = l.id JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
 WHERE p.neto IS NOT NULL AND p.importe <> p.neto
UNION ALL
-- Acreditación confirmada con diferencia (pareo sugerido con motivo): las patas no son iguales.
SELECT i.sede_id, t.dia, (SELECT id FROM fin.rubro WHERE clave = 'dif_acreditacion'), d.dif, 'acreditacion', d.mov, d.concepto
  FROM (SELECT x.transferencia_id, SUM(x.entrada) - SUM(x.salida) AS dif, MIN(x.id) AS mov, MAX(x.concepto) AS concepto,
               (array_agg(x.ticket_pago_id) FILTER (WHERE x.ticket_pago_id IS NOT NULL))[1] AS pago
          FROM vivos x WHERE x.tipo = 'transferencia' AND x.transferencia_id IS NOT NULL
         GROUP BY x.transferencia_id HAVING SUM(x.entrada) <> SUM(x.salida)) d
  JOIN pos.ticket_pago p ON p.id = d.pago JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
UNION ALL
-- Días cobrados con diferencia (lo cobrado no coincidió con lo vendido): la venta se cuenta entera, la diferencia acá.
SELECT i.sede_id, c.dia, (SELECT id FROM fin.rubro WHERE clave = 'dif_cobro'), c.diferencia, 'cobro', NULL,
       'Diferencia de cobro: ' || COALESCE(c.motivo_diferencia, '')
  FROM pos.cobro c JOIN pos.integracion i ON i.id = c.integracion_id
 WHERE c.diferencia IS NOT NULL AND c.diferencia <> 0
   AND EXISTS (SELECT 1 FROM vivos m WHERE m.pos_cobro_id = c.id);

-- La filial de cada cuenta: las que hoy sólo reciben cobros de una sede (las de los procesadores y donde depositan)
-- quedan de esa sede. El resto se asigna en Cajas y bancos.
UPDATE fin.cuenta cu SET sede_id = x.sede_id
  FROM (SELECT c.id, MIN(i.sede_id::text)::uuid AS sede_id
          FROM fin.cuenta c
          JOIN fin.procesador pr ON pr.cuenta_id = c.id OR pr.cuenta_acredita_id = c.id
          JOIN fin.medio_pago mp ON mp.procesador_id = pr.id JOIN pos.medio m ON m.medio_pago_id = mp.id
          JOIN pos.integracion i ON i.id = m.integracion_id
         WHERE c.sede_id IS NULL
         GROUP BY c.id HAVING COUNT(DISTINCT i.sede_id) = 1) x
 WHERE cu.id = x.id;
