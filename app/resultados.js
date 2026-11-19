// API del estado de resultados por filial (pedido de Fer, 28/10/2026): rubros, reglas de clasificación del extracto,
// clasificación de movimientos y el estado en sí. El estado NO se guarda: sale de la vista fin.resultado (ventas, costo
// teórico de lo vendido y movimientos de tesorería clasificados), como el stock. Todo /fin exige finanzas (auth.js).
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, texto, fecha, h, enTransaccion } = require('./util');

const r = express.Router();

// Líneas del estado (10/11/2026: Personal, Locación, Comercialización, Administración e Inversiones, para ver el prime cost).
const LINEAS = ['ventas', 'cmv', 'personal', 'cobro', 'locacion', 'operativos', 'comercializacion', 'administracion', 'impuestos', 'bancarios',
  'inversiones', 'diferencias', 'otros', 'fuera'];
// Ventas la arma el sistema. En costo de mercadería, el rubro del sistema (el consumo) tampoco se toca, pero "Compras de
// mercadería" sí se clasifica a mano (decisión de Fer, 10/11/2026: para la historia, sin facturas ni consumo).
const LINEAS_A_MANO = LINEAS.filter(l => l !== 'ventas');

// ── Rubros ───────────────────────────────────────────────────────────────────────────────────
r.get('/fin/rubros', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.nombre, r.linea, r.clave, r.activo, r.orden, r.del_centro,
            (SELECT COUNT(*)::int FROM fin.clasificacion k WHERE k.rubro_id = r.id) + (SELECT COUNT(*)::int FROM fin.regla g WHERE g.rubro_id = r.id) AS usos
       FROM fin.rubro r ORDER BY r.orden, r.nombre`);
  res.json({ ok: true, rubros: rows, lineas: LINEAS });
}));
// "Del centro" (fin.rubro.del_centro): lo que se compra en ese rubro es de CF CENTRAL, pague quien pague. Un rubro de mercadería
// nace así salvo que se diga lo contrario (Fer, 15/11/2026: Aves, Pastas y Leña, creados desde egresos, quedaron en el local).
function leerRubro(b, sistema) {
  const x = { nombre: texto(b.nombre, { campo: 'el nombre', requerido: true }), linea: texto(b.linea), activo: b.activo === undefined ? true : !!b.activo };
  if (!sistema && !LINEAS_A_MANO.includes(x.linea)) throw new ErrorUsuario('Elegí en qué línea del estado va el rubro.');
  x.del_centro = b.del_centro === undefined ? x.linea === 'cmv' : !!b.del_centro;
  return x;
}
// Los de mercadería se llaman "Mercadería · <qué>", como los originales: así se leen juntos en el estado de resultados.
const PREFIJO_CMV = 'Mercadería · ';
const conPrefijo = (nombre, linea) => linea === 'cmv' && !/^mercader[ií]a\b/i.test(nombre) ? PREFIJO_CMV + nombre : nombre;
async function nombreLibre(c, nombre, id = null) {
  const sinAc = "lower(translate(nombre, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU'))";
  const { rows: [ya] } = await c.query(`SELECT nombre FROM fin.rubro WHERE ${sinAc} = lower(translate($1, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) AND id IS DISTINCT FROM $2::uuid`, [nombre, id]);
  if (ya) throw new ErrorUsuario(`Ya existe el rubro "${ya.nombre}".`);
}
// Un rubro que pasa a ser del centro lleva lo ya clasificado a la central (el trigger de fin.clasificacion lo hace al tocarlo) y sus
// reglas dejan de fijar filial. Al revés no se puede deshacer solo: no se sabe de qué local era cada gasto.
async function alCentro(c, id) {
  await c.query('UPDATE fin.clasificacion SET sede_id = sede_id WHERE rubro_id = $1', [id]);
  await c.query('UPDATE fin.regla SET sede_id = NULL WHERE rubro_id = $1 AND sede_id IS NOT NULL', [id]);
}
r.post('/fin/rubros', h(async (req, res) => {
  const x = leerRubro(req.body);
  x.nombre = conPrefijo(x.nombre, x.linea);
  const id = await enTransaccion(async c => {
    await nombreLibre(c, x.nombre);
    const { rows: [n] } = await c.query(
      `INSERT INTO fin.rubro (nombre, linea, activo, del_centro, orden)
       VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(orden), 100) FROM fin.rubro WHERE linea = $2) + 1) RETURNING id`,
      [x.nombre, x.linea, x.activo, x.del_centro]);
    return n.id;
  });
  res.status(201).json({ ok: true, id, nombre: x.nombre, del_centro: x.del_centro });
}));
// Un rubro del sistema cambia de nombre pero no de línea (lo usa la clasificación automática); ninguno se borra.
r.put('/fin/rubros/:id', h(async (req, res) => {
  const { rows: [ant] } = await pool.query('SELECT clave FROM fin.rubro WHERE id = $1::uuid', [req.params.id]);
  if (!ant) throw new ErrorUsuario('No existe ese rubro.', 404);
  const x = leerRubro(req.body, !!ant.clave);
  if (ant.clave && !x.activo) throw new ErrorUsuario('Ese rubro lo usa el sistema: no se desactiva.');
  if (req.body.del_centro === undefined) x.del_centro = null;
  await enTransaccion(async c => {
    await nombreLibre(c, x.nombre, req.params.id);
    const { rows: [u] } = await c.query(
      `UPDATE fin.rubro r SET nombre = $1, linea = COALESCE(CASE WHEN clave IS NULL THEN $2 END, linea), activo = $3,
              del_centro = COALESCE($5, del_centro)
         FROM (SELECT del_centro AS antes FROM fin.rubro WHERE id = $4) a
        WHERE r.id = $4 RETURNING a.antes, r.del_centro`,
      [x.nombre, x.linea, x.activo, req.params.id, x.del_centro]);
    if (u.del_centro && !u.antes) await alCentro(c, req.params.id);
  });
  res.json({ ok: true });
}));
async function rubroValido(c, id, campo = 'el rubro') {
  const rid = texto(id, { campo, requerido: true });
  const { rows: [x] } = await c.query('SELECT linea, clave FROM fin.rubro WHERE id = $1::uuid AND activo', [rid]);
  if (!x) throw new ErrorUsuario('Ese rubro no existe o está inactivo.');
  if (!LINEAS_A_MANO.includes(x.linea) || x.clave === 'cmv') throw new ErrorUsuario('Ventas y costo de mercadería los arma el sistema: elegí otro rubro.');
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
    c.query(`SELECT l.id, l.fecha, l.cuenta_id, l.importe::text, l.concepto, l.referencia, l.destinatario FROM fin.extracto_linea l
              WHERE l.cuenta_id = $1::uuid AND l.compensa_a IS NULL AND l.descartada IS NULL
                AND NOT EXISTS (SELECT 1 FROM fin.extracto_linea x WHERE x.compensa_a = l.id)
                AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)
              ORDER BY l.fecha, l.id FOR UPDATE OF l`, [cuentaId]),
  ]);
  if (!reglas.length) return 0;
  const rs = reglas.map(g => ({ ...g, p: norm(g.patron) }));
  let n = 0;
  for (const l of lineas) {
    const sale = l.importe.startsWith('-'), txt = norm(`${l.concepto} ${l.referencia || ''} ${l.destinatario || ''}`);
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
    // Un pago con orden de pago se reparte solo entre los rubros de lo que paga; clasificarlo a mano lo lleva entero a un rubro.
    if (!['ingreso', 'egreso', 'pago', 'debito_cheque'].includes(m.tipo)) throw new ErrorUsuario('Sólo se clasifican ingresos, egresos y pagos.');
    // El comercio, si el gasto es de uno solo (si no, se prorratea por las ventas del mes); con comercio, la filial es la suya.
    let sede = texto(b.sede_id);
    const comercio = texto(b.comercio_id);
    if (comercio) {
      const { rows: [cm] } = await c.query('SELECT sede_id, nombre FROM org.comercio WHERE id = $1::uuid AND activo', [comercio]);
      if (!cm) throw new ErrorUsuario('Ese comercio no existe o está inactivo.');
      if (sede && sede !== cm.sede_id) throw new ErrorUsuario(`${cm.nombre} es de otra filial.`);
      sede = cm.sede_id;
    }
    await c.query(
      `INSERT INTO fin.clasificacion (movimiento_id, rubro_id, sede_id, comercio_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (movimiento_id) DO UPDATE SET rubro_id = EXCLUDED.rubro_id, sede_id = EXCLUDED.sede_id, comercio_id = EXCLUDED.comercio_id,
              regla_id = NULL, por = org.usuario_actual(), en = now()`,
      [b.movimiento_id, await rubroValido(c, b.rubro_id), sede, comercio]);
  });
  res.json({ ok: true });
}));

// ── Estado de resultados ─────────────────────────────────────────────────────────────────────
// Del grupo consolidado (sin filtro), de una sociedad, del grupo sólo ("grupo": lo que no es de ninguna sociedad: el centro y la
// caja mayor) o de un store, y período: cada línea con sus rubros. Aparte, lo sin clasificar y lo que no es resultado.
const UUID = /^[0-9a-f-]{36}$/i;
function periodo(req) {
  const desde = fecha(req.query.desde, { campo: 'Desde', requerido: true }), hasta = fecha(req.query.hasta, { campo: 'Hasta', requerido: true });
  if (desde > hasta) throw new ErrorUsuario('El período está al revés.');
  const sociedad = texto(req.query.sociedad) || '', comercio = texto(req.query.comercio);
  if (sociedad && sociedad !== 'grupo' && !UUID.test(sociedad)) throw new ErrorUsuario('Sociedad inválida.');
  if (comercio && comercio !== 'sin' && !UUID.test(comercio)) throw new ErrorUsuario('Store inválido.');
  if (comercio === 'sin' && !UUID.test(sociedad)) throw new ErrorUsuario('Elegí la sociedad.');
  return { desde, hasta, sociedad, comercio };
}
// La sociedad de un hecho, como condición SQL sobre x (el parámetro $3).
const DE_SOCIEDAD = `(CASE WHEN $3 = '' THEN true WHEN $3 = 'grupo' THEN x.sociedad_id IS NULL ELSE x.sociedad_id::text = $3 END)`;
// Con un comercio elegido, el estado sale de fin.resultado_comercio (cada hecho con la parte de ese comercio); "sin" es lo
// del local que no se pudo repartir. Sin comercio, de fin.resultado como siempre.
const origen = p => !p.comercio ? { tabla: 'fin.resultado', filtro: 'true' }
  : { tabla: 'fin.resultado_comercio', filtro: p.comercio === 'sin' ? 'x.comercio_id IS NULL' : `x.comercio_id = '${p.comercio.replace(/[^0-9a-f-]/gi, '')}'::uuid` };
r.get('/fin/resultados', h(async (req, res) => {
  const p = periodo(req), o = origen(p);
  const [{ rows }, { rows: ventasPorTipo }] = await Promise.all([
    pool.query(
      `SELECT ru.id AS rubro_id, ru.nombre AS rubro, ru.linea, ru.orden, COUNT(*)::int AS n, SUM(x.importe)::numeric(16,2)::text AS importe
         FROM ${o.tabla} x LEFT JOIN fin.rubro ru ON ru.id = x.rubro_id
        WHERE x.dia BETWEEN $1 AND $2 AND ${DE_SOCIEDAD} AND ${o.filtro}
        GROUP BY ru.id, ru.nombre, ru.linea, ru.orden ORDER BY ru.orden NULLS LAST, ru.nombre`, [p.desde, p.hasta, p.sociedad]),
    // Las ventas abiertas por tipo (salón, para llevar, delivery), con la misma regla que la vista: por el total del día.
    // Con un comercio: los pedidos de sus tiendas enteros y el resto por el peso del día de ese comercio (cantidades aproximadas).
    p.comercio === 'sin' ? { rows: [] } : p.comercio ? pool.query(
      `WITH pd AS MATERIALIZED (SELECT integracion_id, dia, peso FROM pos.comercio_peso_dia WHERE comercio_id = $3::uuid),
            co AS (SELECT c.id, c.sede_id, c.tiendas FROM org.comercio c WHERE c.activo)
       SELECT COALESCE(t.tipo, 'sin tipo') AS tipo, ROUND(SUM(w.peso))::int AS ventas, SUM(COALESCE(t.total, 0) * w.peso)::numeric(16,2)::text AS importe
         FROM pos.ticket t JOIN pos.integracion i ON i.id = t.integracion_id
         LEFT JOIN pd ON pd.integracion_id = t.integracion_id AND pd.dia = t.dia
         CROSS JOIN LATERAL (SELECT CASE WHEN EXISTS (SELECT 1 FROM co WHERE co.sede_id = i.sede_id AND t.tienda = ANY (co.tiendas))
                                         THEN CASE WHEN EXISTS (SELECT 1 FROM co WHERE co.id = $3::uuid AND t.tienda = ANY (co.tiendas)) THEN 1 ELSE 0 END
                                         ELSE COALESCE(pd.peso, 0) END::numeric AS peso) w
        WHERE t.estado = 'cerrado' AND t.dia BETWEEN $1 AND $2 AND i.sede_id = (SELECT sede_id FROM org.comercio WHERE id = $3::uuid) AND w.peso > 0
        GROUP BY 1 ORDER BY SUM(COALESCE(t.total, 0) * w.peso) DESC`, [p.desde, p.hasta, p.comercio]) :
    pool.query(
      `SELECT COALESCE(t.tipo, 'sin tipo') AS tipo, COUNT(*)::int AS ventas, SUM(COALESCE(t.total, it.vendido, 0))::numeric(16,2)::text AS importe
         FROM pos.ticket t JOIN pos.integracion i ON i.id = t.integracion_id JOIN org.sede x ON x.id = i.sede_id
         LEFT JOIN LATERAL (SELECT SUM(COALESCE(y.importe, y.cantidad * y.precio)) AS vendido FROM pos.ticket_item y
                             WHERE y.ticket_id = t.id AND NOT y.anulado) it ON true
        WHERE t.estado = 'cerrado' AND t.dia BETWEEN $1 AND $2 AND ${DE_SOCIEDAD}
        GROUP BY 1 ORDER BY SUM(COALESCE(t.total, it.vendido, 0)) DESC`, [p.desde, p.hasta, p.sociedad]),
  ]);
  res.json({ ok: true, ...p, rubros: rows, ventas_por_tipo: ventasPorTipo });
}));
// El detalle de un rubro (o "sin" = sin clasificar): cada hecho con su día, proveedor, concepto, importe y cuenta.
r.get('/fin/resultados/detalle', h(async (req, res) => {
  const p = periodo(req), rubro = texto(req.query.rubro, { campo: 'el rubro', requerido: true }), o = origen(p);
  const { rows } = await pool.query(
    `SELECT to_char(x.dia, 'YYYY-MM-DD') AS dia, x.origen, x.movimiento_id, x.concepto, x.importe::text, cu.nombre AS cuenta, s.nombre AS sede, x.sede_id,
            k.rubro_id IS NOT NULL AS clasificado, g.patron AS regla, k.comercio_id, cm.nombre AS comercio, pv.nombre AS proveedor,
            ${p.comercio ? 'x.peso::float AS peso, x.regla AS reparto' : 'NULL::float AS peso, NULL AS reparto'}
       FROM ${o.tabla} x LEFT JOIN fin.movimiento_tes m ON m.id = x.movimiento_id AND x.origen = 'movimiento'
       LEFT JOIN fin.cuenta cu ON cu.id = m.cuenta_id LEFT JOIN org.sede s ON s.id = x.sede_id
       LEFT JOIN fin.clasificacion k ON k.movimiento_id = m.id LEFT JOIN fin.regla g ON g.id = k.regla_id
       LEFT JOIN org.comercio cm ON cm.id = k.comercio_id
       -- El proveedor: el de la factura que pagó el movimiento (pago sin factura ya documentado) o el de su orden de pago.
       LEFT JOIN LATERAL (SELECT v.nombre FROM fin.pago_previo pp JOIN fin.comprobante c ON c.id = pp.comprobante_id AND c.estado <> 'anulado'
                            JOIN logic.proveedor v ON v.id = c.proveedor_id WHERE pp.movimiento_id = m.id
                          UNION ALL
                          SELECT v.nombre FROM fin.orden_pago op JOIN logic.proveedor v ON v.id = op.proveedor_id WHERE op.id = m.orden_pago_id
                          LIMIT 1) pv ON true
      WHERE x.dia BETWEEN $1 AND $2 AND ${o.filtro} AND ${DE_SOCIEDAD}
        AND (CASE WHEN $4 = 'sin' THEN x.rubro_id IS NULL WHEN $4 = 'todos' THEN true ELSE x.rubro_id = $4::uuid END)
      ORDER BY x.dia, x.movimiento_id NULLS FIRST LIMIT 1001`, [p.desde, p.hasta, p.sociedad, rubro]);
  res.json({ ok: true, filas: rows.slice(0, 1000), hay_mas: rows.length > 1000 });
}));

// ── Del resultado a la caja (pedido de Fer, 19/11/2026) ──
// El resultado del período contra la variación de todas las cuentas (bancos, cajas, efectivo de los locales, por acreditar,
// préstamos de socios, cartera), renglón por renglón. Consolidado del grupo: por sociedad aparecerían las transferencias entre
// sociedades. Cada movimiento del período cae en un solo renglón: cobro de ventas, atado a hechos del resultado (por su rubro:
// resultado, no es resultado o sin clasificar), transferencia, u otro sin resultado. Del lado del resultado, lo devengado en el
// período (ventas por el día de la venta, costos de cobro por el día de la venta). Lo que no cierra queda en "sin explicar".
// La deuda con proveedores y el stock no entran: el costo se toma al pagar (se informa la deuda aparte).
r.get('/fin/resultados/puente', h(async (req, res) => {
  const desde = fecha(req.query.desde, { campo: 'Desde', requerido: true }), hasta = fecha(req.query.hasta, { campo: 'Hasta', requerido: true });
  if (desde > hasta) throw new ErrorUsuario('El período está al revés.');
  const VIVOS = `SELECT m.* FROM fin.movimiento_tes m
                  WHERE m.tipo <> 'anulacion' AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = m.id)`;
  const [res1, res2, movs, cuentas, deuda] = await Promise.all([
    // Lado del resultado, por el día devengado.
    pool.query(`SELECT x.origen, ru.linea, SUM(x.importe)::text AS importe
                  FROM fin.resultado x LEFT JOIN fin.rubro ru ON ru.id = x.rubro_id
                 WHERE x.dia BETWEEN $1 AND $2 GROUP BY 1, 2`, [desde, hasta]),
    // Los hechos atados a un movimiento, por la fecha del movimiento (lo que movió la plata en el período).
    pool.query(`SELECT x.origen, ru.linea, ru.nombre AS rubro, SUM(x.importe)::text AS importe
                  FROM fin.resultado x JOIN fin.movimiento_tes m ON m.id = x.movimiento_id LEFT JOIN fin.rubro ru ON ru.id = x.rubro_id
                 WHERE x.origen IN ('movimiento', 'lote', 'acreditacion') AND m.fecha BETWEEN $1 AND $2 GROUP BY 1, 2, 3`, [desde, hasta]),
    // Los movimientos del período, cada uno en su grupo.
    pool.query(`WITH v AS (${VIVOS} AND m.fecha BETWEEN $1 AND $2),
                     atado AS (SELECT DISTINCT movimiento_id FROM fin.resultado WHERE origen IN ('movimiento', 'lote'))
                SELECT CASE WHEN v.tipo = 'cobro' THEN 'cobro' WHEN v.tipo = 'transferencia' THEN 'transferencia'
                            WHEN EXISTS (SELECT 1 FROM atado a WHERE a.movimiento_id = v.id) THEN 'atado'
                            WHEN v.gasto IS NULL AND v.concepto = 'Saldo de apertura según extracto' THEN 'apertura'
                            ELSE 'otro:' || v.tipo END AS grupo, COUNT(*)::int AS n, SUM(v.entrada - v.salida)::text AS importe
                  FROM v GROUP BY 1
                UNION ALL
                SELECT 'todos', COUNT(*)::int, COALESCE(SUM(entrada - salida), 0)::text FROM fin.movimiento_tes WHERE fecha BETWEEN $1 AND $2`, [desde, hasta]),
    // Saldo de cada grupo de cuentas al empezar y al terminar el período.
    pool.query(`SELECT CASE c.tipo WHEN 'banco' THEN 'bancos' WHEN 'cobranza' THEN 'por_acreditar' WHEN 'socios' THEN 'socios' WHEN 'cartera' THEN 'cartera'
                         ELSE CASE WHEN EXISTS (SELECT 1 FROM pos.integracion i WHERE i.cuenta_efectivo_id = c.id) THEN 'efectivo' ELSE 'cajas' END END AS grupo,
                       COALESCE(SUM(m.entrada - m.salida) FILTER (WHERE m.fecha < $1), 0)::text AS inicial,
                       COALESCE(SUM(m.entrada - m.salida) FILTER (WHERE m.fecha <= $2), 0)::text AS final
                  FROM fin.cuenta c LEFT JOIN fin.movimiento_tes m ON m.cuenta_id = c.id GROUP BY 1`, [desde, hasta]),
    pool.query(`SELECT COALESCE(SUM(haber - debe) FILTER (WHERE fecha < $1), 0)::text AS inicial,
                       COALESCE(SUM(haber - debe) FILTER (WHERE fecha <= $2), 0)::text AS final FROM fin.movimiento_cc`, [desde, hasta]),
  ]);
  // En centavos (BigInt): ni un centavo de float.
  const c = v => { if (v == null) return 0n; const [e, d = ''] = String(v).split('.'); const neg = e.startsWith('-');
    const x = BigInt(e.replace('-', '') || '0') * 100n + BigInt((d + '00').slice(0, 2)); return neg ? -x : x; };
  const t = c2 => { const neg = c2 < 0n, a = neg ? -c2 : c2; return (neg ? '-' : '') + (a / 100n) + '.' + String(a % 100n).padStart(2, '0'); };
  const suma = (rows, f) => rows.filter(f).reduce((s, x) => s + c(x.importe), 0n);
  const esRes = l => l != null && l !== 'fuera';
  const R = suma(res1.rows, x => esRes(x.linea));
  const ventas = suma(res1.rows, x => ['ventas', 'cobro'].includes(x.origen) && esRes(x.linea));
  const sinPlata = suma(res1.rows, x => ['cmv', 'ajuste'].includes(x.origen) && esRes(x.linea));
  const atadoDia = suma(res1.rows, x => ['movimiento', 'lote'].includes(x.origen) && esRes(x.linea));
  const acredDia = suma(res1.rows, x => x.origen === 'acreditacion' && esRes(x.linea));
  const atadoFecha = suma(res2.rows, x => x.origen !== 'acreditacion' && esRes(x.linea));
  const acredFecha = suma(res2.rows, x => x.origen === 'acreditacion');
  const fueraRows = res2.rows.filter(x => x.origen !== 'acreditacion' && x.linea === 'fuera');
  const fuera = suma(fueraRows, () => true), sinClas = suma(res2.rows, x => x.origen !== 'acreditacion' && x.linea == null);
  const g = k => movs.rows.filter(x => x.grupo === k);
  const cobros = suma(g('cobro'), () => true), transf = suma(g('transferencia'), () => true), apertura = suma(g('apertura'), () => true);
  const atadoMov = suma(g('atado'), () => true), todos = suma(g('todos'), () => true);
  const vivos = suma(movs.rows.filter(x => x.grupo !== 'todos'), () => true);
  const otros = movs.rows.filter(x => x.grupo.startsWith('otro:')).map(x => ({ tipo: x.grupo.slice(5), n: x.n, importe: x.importe }));
  const otrosT = otros.reduce((s, x) => s + c(x.importe), 0n);
  const sinExplicar = atadoMov - (atadoFecha + fuera + sinClas);
  const renglones = [
    { k: 'ventas', importe: cobros - ventas, ventas: t(ventas), cobros: t(cobros) },
    { k: 'sin_plata', importe: -sinPlata },
    { k: 'fechas', importe: (atadoFecha - atadoDia) + (acredFecha - acredDia) },
    { k: 'fuera', importe: fuera, rubros: fueraRows.map(x => ({ rubro: x.rubro, importe: x.importe })) },
    { k: 'sin_clasificar', importe: sinClas },
    { k: 'apertura', importe: apertura },
    { k: 'transferencias', importe: transf - acredFecha },
    { k: 'otros', importe: otrosT, tipos: otros },
    { k: 'anulaciones', importe: todos - vivos },
    { k: 'sin_explicar', importe: sinExplicar },
  ].map(x => ({ ...x, importe: t(x.importe) }));
  // Control: resultado + renglones = variación de las cuentas (por construcción; si no, hay un error de cálculo, no de datos).
  const controlCuadra = R + renglones.reduce((s, x) => s + c(x.importe), 0n) === todos;
  res.json({ ok: true, desde, hasta, resultado: t(R), renglones, variacion: t(todos), cuadra: controlCuadra,
    cuentas: cuentas.rows, deuda: deuda.rows[0] });
}));

Object.assign(r, { aplicarReglas, crearRegla, rubroValido });
module.exports = r;
