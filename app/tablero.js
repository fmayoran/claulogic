// API del tablero: food cost, consumo teórico contra real, rentabilidad por plato y flujo de caja.
//
// No hay tablas propias: todo sale de los libros mayores (logic.kardex sobre logic.movimiento,
// fin.movimiento_tes) y de los tickets del POS. Montos en NUMERIC hasta el final; el navegador sólo
// los muestra.
//
// Quién ve qué (decisión mía): los indicadores operativos, el encargado de cada sede, finanzas y el
// administrador; el flujo de caja, sólo finanzas. Un operador no ve costos ni márgenes.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, texto, fecha, h } = require('./util');
const { puede } = require('./auth');

const r = express.Router();

// Sedes que el usuario puede mirar en el tablero: todas si es admin o finanzas; si no, aquellas
// donde es encargado. Con ?sede=, sólo ésa (si la puede ver).
function sedesTablero(req) {
  const u = req.usuario;
  let sedes = u.es_admin || puede(u, 'finanzas') ? null : (u.roles || []).filter(x => x.rol === 'encargado').map(x => x.sede_id);
  if (sedes && !sedes.length) throw new ErrorUsuario('El tablero es para encargados, finanzas y administración.', 403);
  const pedida = texto(req.query.sede);
  if (pedida) {
    if (sedes && !sedes.includes(pedida)) throw new ErrorUsuario('No tenés acceso a esa sede.', 403);
    sedes = [pedida];
  }
  return sedes;
}

// Período: por defecto, el mes en curso. Las ventas del POS suelen venir con IVA: se dividen por
// (1 + iva/100) para comparar contra costos, que se cargan netos. ?iva=0 las deja brutas.
function periodo(req) {
  const desde = fecha(req.query.desde, { campo: 'Desde' });
  const hasta = fecha(req.query.hasta, { campo: 'Hasta' });
  const iva = numero(req.query.iva, { campo: 'El IVA de ventas' }) ?? '21';
  if (Number(iva) > 50) throw new ErrorUsuario('El IVA de ventas parece fuera de rango.');
  return { desde, hasta, iva };
}
const RANGO = `COALESCE($2::date, date_trunc('month', current_date)::date) AS desde, COALESCE($3::date, current_date) AS hasta`;

// ── Indicadores operativos por sede ──────────────────────────────────────────────────────────
r.get('/tablero/operativo', h(async (req, res) => {
  const sedes = sedesTablero(req), p = periodo(req);
  const { rows } = await pool.query(
    `WITH rango AS (SELECT ${RANGO}),
     k AS (
       SELECT kc.sede_id, kc.concepto, -SUM(kc.valor) AS consumo, COUNT(*) FILTER (WHERE kc.costo_unitario IS NULL) AS sin_costo
         FROM logic.kardex_concepto kc, rango
        WHERE kc.dia BETWEEN rango.desde AND rango.hasta AND ($1::uuid[] IS NULL OR kc.sede_id = ANY($1))
        GROUP BY kc.sede_id, kc.concepto),
     v AS (
       SELECT i.sede_id, SUM(COALESCE(it.importe, it.cantidad * it.precio)) AS bruto, COUNT(DISTINCT t.id) AS tickets
         FROM pos.ticket t JOIN pos.integracion i ON i.id = t.integracion_id
         JOIN pos.ticket_item it ON it.ticket_id = t.id AND NOT it.anulado, rango
        WHERE t.estado = 'cerrado' AND t.dia BETWEEN rango.desde AND rango.hasta
          AND ($1::uuid[] IS NULL OR i.sede_id = ANY($1))
        GROUP BY i.sede_id),
     st AS (
       SELECT a.sede_id, SUM(s.cantidad * COALESCE(l.costo_base, p.costo_base)) AS valor,
              COUNT(*) FILTER (WHERE COALESCE(l.costo_base, p.costo_base) IS NULL AND s.cantidad > 0) AS sin_costo
         FROM logic.stock s JOIN logic.ubicacion u ON u.id = s.ubicacion_id JOIN logic.almacen a ON a.id = u.almacen_id
         JOIN logic.producto p ON p.id = s.producto_id LEFT JOIN logic.lote l ON l.id = s.lote_id
        WHERE $1::uuid[] IS NULL OR a.sede_id = ANY($1)
        GROUP BY a.sede_id)
     SELECT s.id AS sede_id, s.nombre AS sede, s.tipo,
            (SELECT desde FROM rango) AS desde, (SELECT hasta FROM rango) AS hasta,
            round(COALESCE(v.bruto, 0), 2)::text AS ventas_brutas,
            round(COALESCE(v.bruto, 0) / (1 + $4::numeric / 100), 2)::text AS ventas_netas,
            COALESCE(v.tickets, 0)::int AS tickets,
            ${['teorico', 'perdida', 'diferencia', 'consumo_interno', 'venta_manual', 'compra', 'transferencia', 'produccion'].map(c =>
              `round(COALESCE((SELECT consumo FROM k WHERE k.sede_id = s.id AND k.concepto = '${c}'), 0), 2)::text AS ${c}`).join(',\n            ')},
            round(COALESCE((SELECT SUM(consumo) FROM k WHERE k.sede_id = s.id
                             AND k.concepto IN ('teorico','perdida','diferencia','consumo_interno','venta_manual')), 0), 2)::text AS real,
            COALESCE((SELECT SUM(sin_costo) FROM k WHERE k.sede_id = s.id), 0)::int AS movimientos_sin_costo,
            round(COALESCE(st.valor, 0), 2)::text AS stock_valorizado, COALESCE(st.sin_costo, 0)::int AS stock_sin_costo
       FROM org.sede s
       LEFT JOIN v ON v.sede_id = s.id LEFT JOIN st ON st.sede_id = s.id
      WHERE s.activa AND ($1::uuid[] IS NULL OR s.id = ANY($1))
      ORDER BY s.tipo, s.nombre`, [sedes, p.desde, p.hasta, p.iva]);
  // Food cost = consumo / ventas netas. Lo calcula la base para no dividir plata en float.
  const { rows: fc } = await pool.query(
    `SELECT x.sede_id, CASE WHEN x.netas > 0 THEN round(x.teorico / x.netas * 100, 1)::text END AS fc_teorico,
            CASE WHEN x.netas > 0 THEN round(x.real / x.netas * 100, 1)::text END AS fc_real
       FROM unnest($1::uuid[], $2::numeric[], $3::numeric[], $4::numeric[]) AS x(sede_id, netas, teorico, real)`,
    [rows.map(x => x.sede_id), rows.map(x => x.ventas_netas), rows.map(x => x.teorico), rows.map(x => x.real)]);
  const porSede = new Map(fc.map(x => [x.sede_id, x]));
  res.json({ ok: true, iva: p.iva, sedes: rows.map(x => ({ ...x, ...porSede.get(x.sede_id) })) });
}));

// Productos que más explican la diferencia entre teórico y real en una sede.
r.get('/tablero/productos', h(async (req, res) => {
  const sedes = sedesTablero(req), p = periodo(req);
  if (!req.query.sede) throw new ErrorUsuario('Elegí la sede.');
  const { rows } = await pool.query(
    `WITH rango AS (SELECT ${RANGO})
     SELECT p.id AS producto_id, p.nombre, p.unidad_base,
            trim_scale(-SUM(kc.cantidad) FILTER (WHERE kc.concepto = 'teorico'))::text AS teorico_cant,
            round(-COALESCE(SUM(kc.valor) FILTER (WHERE kc.concepto = 'teorico'), 0), 2)::text AS teorico,
            round(-COALESCE(SUM(kc.valor) FILTER (WHERE kc.concepto = 'perdida'), 0), 2)::text AS perdida,
            round(-COALESCE(SUM(kc.valor) FILTER (WHERE kc.concepto = 'diferencia'), 0), 2)::text AS diferencia,
            round(-COALESCE(SUM(kc.valor) FILTER (WHERE kc.concepto IN ('consumo_interno','venta_manual')), 0), 2)::text AS otros,
            trim_scale(-SUM(kc.cantidad) FILTER (WHERE kc.concepto IN ('perdida','diferencia','consumo_interno','venta_manual')))::text AS desvio_cant,
            round(-COALESCE(SUM(kc.valor) FILTER (WHERE kc.concepto IN ('perdida','diferencia','consumo_interno','venta_manual')), 0), 2)::text AS desvio,
            bool_or(kc.costo_unitario IS NULL) AS sin_costo
       FROM logic.kardex_concepto kc JOIN logic.producto p ON p.id = kc.producto_id, rango
      WHERE kc.dia BETWEEN rango.desde AND rango.hasta AND kc.sede_id = ANY($1)
        AND kc.concepto IN ('teorico','perdida','diferencia','consumo_interno','venta_manual')
      GROUP BY p.id
      ORDER BY abs(COALESCE(SUM(kc.valor) FILTER (WHERE kc.concepto IN ('perdida','diferencia','consumo_interno','venta_manual')), 0)) DESC NULLS LAST, p.nombre
      LIMIT 40`, [sedes, p.desde, p.hasta]);
  res.json({ ok: true, productos: rows });
}));

// Rentabilidad por plato: lo vendido (POS), a qué precio, y el costo teórico de la porción con el
// costo vigente de hoy. Food cost = costo / precio neto.
r.get('/tablero/platos', h(async (req, res) => {
  const sedes = sedesTablero(req), p = periodo(req);
  const { rows } = await pool.query(
    `WITH rango AS (SELECT ${RANGO}),
     costo AS (
       SELECT pi.plato_id, SUM(pi.cantidad_base / (1 - pi.merma_pct / 100) * pr.costo_base) AS costo,
              bool_or(pr.costo_base IS NULL) AS incompleto
         FROM logic.plato_item pi JOIN logic.producto pr ON pr.id = pi.producto_id GROUP BY pi.plato_id),
     vendido AS (
       SELECT a.plato_id, SUM(it.cantidad) AS cantidad, SUM(COALESCE(it.importe, it.cantidad * it.precio)) AS bruto
         FROM pos.ticket_item it JOIN pos.ticket t ON t.id = it.ticket_id JOIN pos.articulo a ON a.id = it.articulo_id
         JOIN pos.integracion i ON i.id = t.integracion_id, rango
        WHERE t.estado = 'cerrado' AND NOT it.anulado AND a.plato_id IS NOT NULL
          AND t.dia BETWEEN rango.desde AND rango.hasta
          AND ($1::uuid[] IS NULL OR i.sede_id = ANY($1))
        GROUP BY a.plato_id)
     SELECT pl.id, pl.nombre, trim_scale(v.cantidad)::text AS cantidad, round(v.bruto, 2)::text AS ventas,
            round(v.bruto / NULLIF(v.cantidad, 0), 2)::text AS precio_promedio,
            round(c.costo, 2)::text AS costo_porcion, c.incompleto,
            CASE WHEN v.bruto > 0 AND NOT c.incompleto
                 THEN round(c.costo * v.cantidad / (v.bruto / (1 + $4::numeric / 100)) * 100, 1)::text END AS food_cost,
            round(v.bruto / (1 + $4::numeric / 100) - COALESCE(c.costo, 0) * v.cantidad, 2)::text AS margen
       FROM vendido v JOIN logic.plato pl ON pl.id = v.plato_id LEFT JOIN costo c ON c.plato_id = pl.id
      ORDER BY v.bruto DESC NULLS LAST LIMIT 100`, [sedes, p.desde, p.hasta, p.iva]);
  res.json({ ok: true, platos: rows });
}));

// ── Flujo de caja ────────────────────────────────────────────────────────────────────────────
// Histórico por semana (lunes) del período, y proyección de las próximas 8 semanas con lo
// comprometido: facturas a pagar por vencimiento, cheques propios a debitar y cheques de cartera
// a cobrar. Lo vencido sin pagar va en una columna aparte. Los movimientos internos (transferencias
// entre cuentas, depósito de cheques) no son flujo y no se cuentan.
r.get('/tablero/flujo', h(async (req, res) => {
  if (!puede(req.usuario, 'finanzas')) throw new ErrorUsuario('El flujo de caja es de finanzas.', 403);
  const p = periodo(req);
  const [{ rows: hist }, { rows: saldos }, { rows: proy }] = await Promise.all([
    pool.query(
      `WITH rango AS (SELECT COALESCE($1::date, date_trunc('month', current_date)::date) AS desde, COALESCE($2::date, current_date) AS hasta),
       m AS (
         SELECT date_trunc('week', m.fecha)::date AS semana, m.tipo, m.entrada, m.salida, c.tipo AS cuenta_tipo
           FROM fin.movimiento_tes m JOIN fin.cuenta c ON c.id = m.cuenta_id, rango
          WHERE m.fecha BETWEEN rango.desde AND rango.hasta AND m.tipo NOT IN ('transferencia','deposito_cheque'))
       SELECT semana,
              round(SUM(entrada) FILTER (WHERE tipo = 'cobro'), 2)::text AS cobros,
              round(SUM(entrada) FILTER (WHERE tipo IN ('ingreso','alta_cheque','arqueo')), 2)::text AS otros_ingresos,
              round(SUM(salida) FILTER (WHERE tipo IN ('pago','endoso','debito_cheque')), 2)::text AS pagos,
              round(SUM(salida) FILTER (WHERE tipo IN ('egreso','arqueo','cobro')), 2)::text AS otros_egresos,
              round(SUM(entrada - salida) FILTER (WHERE tipo = 'anulacion'), 2)::text AS anulaciones,
              round(SUM(entrada), 2)::text AS entradas, round(SUM(salida), 2)::text AS salidas,
              round(SUM(entrada - salida), 2)::text AS neto
         FROM m GROUP BY semana ORDER BY semana`, [p.desde, p.hasta]),
    pool.query(
      `SELECT c.tipo, round(SUM(sc.saldo), 2)::text AS saldo FROM fin.saldo_cuenta sc JOIN fin.cuenta c ON c.id = sc.cuenta_id
        WHERE c.activa GROUP BY c.tipo`),
    pool.query(
      `WITH semanas AS (SELECT generate_series(date_trunc('week', current_date)::date, date_trunc('week', current_date)::date + 49, '7 days')::date AS semana),
       pagar AS (SELECT CASE WHEN vencimiento < current_date THEN NULL ELSE date_trunc('week', vencimiento)::date END AS semana, pendiente AS importe
                   FROM fin.comprobante_pendiente WHERE pendiente > 0),
       cheq_propios AS (SELECT date_trunc('week', GREATEST(fecha_pago, current_date))::date AS semana, importe
                          FROM fin.cheque WHERE tipo = 'propio' AND estado = 'emitido'),
       cheq_terceros AS (SELECT date_trunc('week', GREATEST(fecha_pago, current_date))::date AS semana, importe
                           FROM fin.cheque WHERE tipo = 'tercero' AND estado = 'en_cartera')
       SELECT s.semana::text,
              round(COALESCE((SELECT SUM(importe) FROM pagar x WHERE x.semana = s.semana), 0), 2)::text AS facturas,
              round(COALESCE((SELECT SUM(importe) FROM cheq_propios x WHERE x.semana = s.semana), 0), 2)::text AS cheques_propios,
              round(COALESCE((SELECT SUM(importe) FROM cheq_terceros x WHERE x.semana = s.semana), 0), 2)::text AS cheques_terceros
         FROM semanas s
       UNION ALL
       SELECT 'vencido', round(COALESCE((SELECT SUM(importe) FROM pagar WHERE semana IS NULL), 0), 2)::text, '0', '0'
       UNION ALL
       SELECT 'mas_adelante',
              round(COALESCE((SELECT SUM(importe) FROM pagar WHERE semana > date_trunc('week', current_date)::date + 49), 0), 2)::text,
              round(COALESCE((SELECT SUM(importe) FROM cheq_propios WHERE semana > date_trunc('week', current_date)::date + 49), 0), 2)::text,
              round(COALESCE((SELECT SUM(importe) FROM cheq_terceros WHERE semana > date_trunc('week', current_date)::date + 49), 0), 2)::text`),
  ]);
  // Saldo proyectado: lo disponible hoy (bancos y cajas) menos lo vencido, y semana a semana lo que
  // entra y sale comprometido. Acumulado en la base, en NUMERIC.
  const disponible = saldos.filter(s => ['banco', 'caja'].includes(s.tipo));
  const semanas = proy.filter(x => /^\d{4}/.test(x.semana));
  const vencido = proy.find(x => x.semana === 'vencido'), adelante = proy.find(x => x.semana === 'mas_adelante');
  // La salida de cada semana es facturas + cheques propios: se suma en la base, no acá.
  const { rows: salidas } = await pool.query(
    'SELECT (f + c)::numeric(16,2)::text AS s FROM unnest($1::numeric[], $2::numeric[]) WITH ORDINALITY AS t(f, c, n) ORDER BY n',
    [semanas.map(s => s.facturas), semanas.map(s => s.cheques_propios)]);
  const { rows: acum } = await pool.query(
    `SELECT (COALESCE((SELECT SUM(x) FROM unnest($1::numeric[]) x), 0) - $2::numeric
            + SUM(ent - sal) OVER (ORDER BY n))::numeric(16,2)::text AS saldo
       FROM unnest($3::numeric[], $4::numeric[]) WITH ORDINALITY AS t(ent, sal, n) ORDER BY n`,
    [disponible.map(s => s.saldo), vencido.facturas, semanas.map(s => s.cheques_terceros), salidas.map(x => x.s)]);
  res.json({ ok: true, historico: hist, saldos,
    proyeccion: semanas.map((s, i) => ({ ...s, salidas: salidas[i].s, saldo: acum[i].saldo })),
    vencido: vencido.facturas, mas_adelante: adelante });
}));

module.exports = r;
