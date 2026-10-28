// API del estado de resultados por filial (pedido de Fer, 28/10/2026): rubros, reglas de clasificación del extracto,
// clasificación de movimientos y el estado en sí. El estado NO se guarda: sale de la vista fin.resultado (ventas, costo
// teórico de lo vendido y movimientos de tesorería clasificados), como el stock. Todo /fin exige finanzas (auth.js).
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, texto, fecha, h, enTransaccion } = require('./util');

const r = express.Router();

const LINEAS = ['ventas', 'cmv', 'cobro', 'impuestos', 'bancarios', 'operativos', 'diferencias', 'otros', 'fuera'];
// Las de ventas y costo de mercadería las arma el sistema: no se clasifica nada a mano ahí.
const LINEAS_A_MANO = LINEAS.filter(l => !['ventas', 'cmv'].includes(l));

// ── Rubros ───────────────────────────────────────────────────────────────────────────────────
r.get('/fin/rubros', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.nombre, r.linea, r.clave, r.activo, r.orden,
            (SELECT COUNT(*)::int FROM fin.clasificacion k WHERE k.rubro_id = r.id) + (SELECT COUNT(*)::int FROM fin.regla g WHERE g.rubro_id = r.id) AS usos
       FROM fin.rubro r ORDER BY r.orden, r.nombre`);
  res.json({ ok: true, rubros: rows, lineas: LINEAS });
}));
function leerRubro(b, sistema) {
  const x = { nombre: texto(b.nombre, { campo: 'el nombre', requerido: true }), linea: texto(b.linea), activo: b.activo === undefined ? true : !!b.activo };
  if (!sistema && !LINEAS_A_MANO.includes(x.linea)) throw new ErrorUsuario('Elegí en qué línea del estado va el rubro.');
  return x;
}
r.post('/fin/rubros', h(async (req, res) => {
  const x = leerRubro(req.body);
  const { rows: [n] } = await pool.query(
    `INSERT INTO fin.rubro (nombre, linea, activo, orden) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(orden), 100) FROM fin.rubro WHERE linea = $2) + 1) RETURNING id`,
    [x.nombre, x.linea, x.activo]);
  res.status(201).json({ ok: true, id: n.id });
}));
// Un rubro del sistema cambia de nombre pero no de línea (lo usa la clasificación automática); ninguno se borra.
r.put('/fin/rubros/:id', h(async (req, res) => {
  const { rows: [ant] } = await pool.query('SELECT clave FROM fin.rubro WHERE id = $1::uuid', [req.params.id]);
  if (!ant) throw new ErrorUsuario('No existe ese rubro.', 404);
  const x = leerRubro(req.body, !!ant.clave);
  if (ant.clave && !x.activo) throw new ErrorUsuario('Ese rubro lo usa el sistema: no se desactiva.');
  await pool.query('UPDATE fin.rubro SET nombre = $1, linea = COALESCE(CASE WHEN clave IS NULL THEN $2 END, linea), activo = $3 WHERE id = $4',
    [x.nombre, x.linea, x.activo, req.params.id]);
  res.json({ ok: true });
}));
async function rubroValido(c, id, campo = 'el rubro') {
  const rid = texto(id, { campo, requerido: true });
  const { rows: [x] } = await c.query('SELECT linea FROM fin.rubro WHERE id = $1::uuid AND activo', [rid]);
  if (!x) throw new ErrorUsuario('Ese rubro no existe o está inactivo.');
  if (!LINEAS_A_MANO.includes(x.linea)) throw new ErrorUsuario('Ventas y costo de mercadería los arma el sistema: elegí otro rubro.');
  return rid;
}

// ── Reglas de clasificación del extracto ─────────────────────────────────────────────────────
// "En esta cuenta (o en cualquiera), la línea cuyo concepto contiene X es del rubro Y". La conciliación automática las
// aplica a lo que no pareó: asienta el ingreso o egreso, lo clasifica y lo concilia. Sin acentos ni mayúsculas; si
// varias coinciden, gana la más larga (la más específica).
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
async function aplicarReglas(c, cuentaId) {
  const [{ rows: reglas }, { rows: lineas }] = await Promise.all([
    c.query(`SELECT id, sentido, patron, rubro_id, sede_id FROM fin.regla WHERE activa AND (cuenta_id IS NULL OR cuenta_id = $1::uuid)
              ORDER BY length(patron) DESC`, [cuentaId]),
    c.query(`SELECT l.id, l.fecha, l.cuenta_id, l.importe::text, l.concepto, l.referencia FROM fin.extracto_linea l
              WHERE l.cuenta_id = $1::uuid AND l.compensa_a IS NULL
                AND NOT EXISTS (SELECT 1 FROM fin.extracto_linea x WHERE x.compensa_a = l.id)
                AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)
              ORDER BY l.fecha, l.id FOR UPDATE OF l`, [cuentaId]),
  ]);
  if (!reglas.length) return 0;
  const rs = reglas.map(g => ({ ...g, p: norm(g.patron) }));
  let n = 0;
  for (const l of lineas) {
    const sale = l.importe.startsWith('-'), txt = norm(`${l.concepto} ${l.referencia || ''}`);
    const g = rs.find(x => x.sentido === (sale ? 'egreso' : 'ingreso') && txt.includes(x.p));
    if (!g) continue;
    const { rows: [m] } = await c.query(
      `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [l.fecha, l.cuenta_id, sale ? 'egreso' : 'ingreso', sale ? 0 : l.importe, sale ? l.importe.slice(1) : 0, (l.concepto || 'Según regla').slice(0, 300)]);
    await c.query('INSERT INTO fin.clasificacion (movimiento_id, rubro_id, sede_id, regla_id) VALUES ($1,$2,$3,$4)', [m.id, g.rubro_id, g.sede_id, g.id]);
    await c.query('INSERT INTO fin.conciliacion (linea_id, movimiento_id) VALUES ($1,$2)', [l.id, m.id]);
    n++;
  }
  return n;
}
async function crearRegla(c, b) {
  const g = {
    cuenta_id: texto(b.cuenta_id), sentido: texto(b.sentido, { campo: 'si es ingreso o egreso', requerido: true }),
    patron: texto(b.patron, { campo: 'el texto que tiene que contener', requerido: true }),
    rubro_id: await rubroValido(c, b.rubro_id), sede_id: texto(b.sede_id),
  };
  if (!['egreso', 'ingreso'].includes(g.sentido)) throw new ErrorUsuario('Una regla es para ingresos o para egresos.');
  if (norm(g.patron).length < 3) throw new ErrorUsuario('El texto de la regla tiene que tener al menos 3 letras.');
  const { rows: [dup] } = await c.query(
    `SELECT id FROM fin.regla WHERE COALESCE(cuenta_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND sentido = $2 AND lower(patron) = lower($3)`, [g.cuenta_id, g.sentido, g.patron]);
  if (dup) throw new ErrorUsuario('Ya hay una regla con ese texto para esa cuenta.');
  const { rows: [n] } = await c.query(
    'INSERT INTO fin.regla (cuenta_id, sentido, patron, rubro_id, sede_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [g.cuenta_id, g.sentido, g.patron.trim(), g.rubro_id, g.sede_id]);
  // Se aplica en el acto a lo pendiente: de esa cuenta, o de todas si es para cualquiera.
  const { rows: cuentas } = g.cuenta_id ? { rows: [{ id: g.cuenta_id }] }
    : await c.query('SELECT DISTINCT cuenta_id AS id FROM fin.extracto_linea');
  let aplicadas = 0;
  for (const cu of cuentas) aplicadas += await aplicarReglas(c, cu.id);
  return { id: n.id, aplicadas };
}

r.get('/fin/reglas', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT g.id, g.cuenta_id, cu.nombre AS cuenta, g.sentido, g.patron, g.rubro_id, ru.nombre AS rubro, ru.linea, g.sede_id, s.nombre AS sede,
            g.activa, g.creada_por, g.creada_en, (SELECT COUNT(*)::int FROM fin.clasificacion k WHERE k.regla_id = g.id) AS aplicadas
       FROM fin.regla g JOIN fin.rubro ru ON ru.id = g.rubro_id LEFT JOIN fin.cuenta cu ON cu.id = g.cuenta_id LEFT JOIN org.sede s ON s.id = g.sede_id
      ORDER BY g.activa DESC, cu.nombre NULLS FIRST, g.patron`);
  res.json({ ok: true, reglas: rows });
}));
r.post('/fin/reglas', h(async (req, res) => {
  const out = await enTransaccion(c => crearRegla(c, req.body));
  res.status(201).json({ ok: true, ...out });
}));
// Cambiar una regla no reclasifica lo que ya aplicó (eso se corrige movimiento por movimiento en el estado).
r.put('/fin/reglas/:id', h(async (req, res) => {
  const b = req.body;
  await enTransaccion(async c => {
    const { rowCount } = await c.query('UPDATE fin.regla SET patron = $1, rubro_id = $2, sede_id = $3, activa = $4 WHERE id = $5::uuid',
      [texto(b.patron, { campo: 'el texto', requerido: true }).trim(), await rubroValido(c, b.rubro_id), texto(b.sede_id), b.activa !== false, req.params.id]);
    if (!rowCount) throw new ErrorUsuario('No existe esa regla.', 404);
  });
  res.json({ ok: true });
}));
r.delete('/fin/reglas/:id', h(async (req, res) => {
  await pool.query('DELETE FROM fin.regla WHERE id = $1::uuid', [req.params.id]);
  res.json({ ok: true });
}));

// ── Clasificar un movimiento ─────────────────────────────────────────────────────────────────
// Un ingreso o egreso sin clasificar (o mal clasificado) recibe su rubro y, si hace falta, su filial. No toca el libro
// mayor: la clasificación va aparte.
r.post('/fin/resultados/clasificar', h(async (req, res) => {
  const b = req.body;
  await enTransaccion(async c => {
    const { rows: [m] } = await c.query(`SELECT tipo FROM fin.movimiento_tes WHERE id = $1`, [b.movimiento_id]);
    if (!m) throw new ErrorUsuario('No existe ese movimiento.', 404);
    if (!['ingreso', 'egreso'].includes(m.tipo)) throw new ErrorUsuario('Sólo se clasifican ingresos y egresos.');
    await c.query(
      `INSERT INTO fin.clasificacion (movimiento_id, rubro_id, sede_id) VALUES ($1,$2,$3)
       ON CONFLICT (movimiento_id) DO UPDATE SET rubro_id = EXCLUDED.rubro_id, sede_id = EXCLUDED.sede_id, regla_id = NULL, por = org.usuario_actual(), en = now()`,
      [b.movimiento_id, await rubroValido(c, b.rubro_id), texto(b.sede_id)]);
  });
  res.json({ ok: true });
}));

// ── Estado de resultados ─────────────────────────────────────────────────────────────────────
// Por filial (o todas) y período: cada línea con sus rubros. Aparte, lo que no entra: lo sin clasificar, lo que no es
// resultado (aportes, retiros) y lo que no tiene filial (de una cuenta sin filial asignada).
function periodo(req) {
  const desde = fecha(req.query.desde, { campo: 'Desde', requerido: true }), hasta = fecha(req.query.hasta, { campo: 'Hasta', requerido: true });
  if (desde > hasta) throw new ErrorUsuario('El período está al revés.');
  return { desde, hasta, sede: texto(req.query.sede) };
}
r.get('/fin/resultados', h(async (req, res) => {
  const p = periodo(req);
  const [{ rows }, { rows: [sinFilial] }] = await Promise.all([
    pool.query(
      `SELECT ru.id AS rubro_id, ru.nombre AS rubro, ru.linea, ru.orden, COUNT(*)::int AS n, SUM(x.importe)::numeric(16,2)::text AS importe
         FROM fin.resultado x LEFT JOIN fin.rubro ru ON ru.id = x.rubro_id
        WHERE x.dia BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR x.sede_id = $3::uuid)
        GROUP BY ru.id, ru.nombre, ru.linea, ru.orden ORDER BY ru.orden NULLS LAST, ru.nombre`, [p.desde, p.hasta, p.sede]),
    pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(importe), 0)::numeric(16,2)::text AS importe FROM fin.resultado
        WHERE dia BETWEEN $1 AND $2 AND sede_id IS NULL`, [p.desde, p.hasta]),
  ]);
  res.json({ ok: true, ...p, rubros: rows, sin_filial: sinFilial });
}));
// El detalle de un rubro (o "sin" = sin clasificar): cada hecho con su día, concepto, importe y cuenta.
r.get('/fin/resultados/detalle', h(async (req, res) => {
  const p = periodo(req), rubro = texto(req.query.rubro, { campo: 'el rubro', requerido: true });
  const sinFilial = req.query.sin_filial === '1';
  const { rows } = await pool.query(
    `SELECT to_char(x.dia, 'YYYY-MM-DD') AS dia, x.origen, x.movimiento_id, x.concepto, x.importe::text, cu.nombre AS cuenta, s.nombre AS sede,
            k.rubro_id IS NOT NULL AS clasificado, g.patron AS regla
       FROM fin.resultado x LEFT JOIN fin.movimiento_tes m ON m.id = x.movimiento_id AND x.origen = 'movimiento'
       LEFT JOIN fin.cuenta cu ON cu.id = m.cuenta_id LEFT JOIN org.sede s ON s.id = x.sede_id
       LEFT JOIN fin.clasificacion k ON k.movimiento_id = m.id LEFT JOIN fin.regla g ON g.id = k.regla_id
      WHERE x.dia BETWEEN $1 AND $2
        AND (CASE WHEN $4 THEN x.sede_id IS NULL ELSE ($3::uuid IS NULL OR x.sede_id = $3::uuid) END)
        AND (CASE WHEN $5 = 'sin' THEN x.rubro_id IS NULL WHEN $5 = 'todos' THEN true ELSE x.rubro_id = $5::uuid END)
      ORDER BY x.dia, x.movimiento_id NULLS FIRST LIMIT 1001`, [p.desde, p.hasta, p.sede, sinFilial, rubro === 'sin' || rubro === 'todos' ? rubro : rubro]);
  res.json({ ok: true, filas: rows.slice(0, 1000), hay_mas: rows.length > 1000 });
}));

Object.assign(r, { aplicarReglas, crearRegla, rubroValido });
module.exports = r;
