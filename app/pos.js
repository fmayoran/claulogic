// API de integración con los puntos de venta: recetas de venta (platos), integraciones por local,
// importación de tickets (Fudo por API; Maxirest y otros por archivo), equivalencias de artículos y
// medios de cobro, y el procesamiento de lo importado.
//
// Importar sólo guarda los tickets (idempotente por id del POS). Procesar es aparte y en dos partes:
//   · consumo: descuenta del stock del local lo que llevan los platos vendidos (FEFO; lo que no
//     alcanza queda en negativo, decisión de Fer). Lo hace operación, con permiso en la sede.
//   · cobros: suma lo cobrado a la cuenta de cada medio. Lo hace finanzas.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, monto, texto, fecha, h, enTransaccion, aBase } = require('./util');
// Plata exacta en centavos (BigInt), para repartir importes en texto sin pasar por float.
const centavos = v => { const s = String(v ?? '0'), neg = s.startsWith('-'), [e, d = ''] = s.replace('-', '').split('.'); const c = BigInt(e || '0') * 100n + BigInt((d + '00').slice(0, 2)); return neg ? -c : c; };
const deCentavos = c => { const a = c < 0n ? -c : c; return (c < 0n ? '-' : '') + String(a / 100n) + '.' + String(a % 100n).padStart(2, '0'); };
const { rolEn, exigirOperarEn, exigirEncargadoDe, filtroSedes, puede } = require('./auth');
const crypto = require('./crypto');
const fudo = require('./fudo');
const { MEDIOS_SQL, acreditarLotes } = require('./tesoreria');

const r = express.Router();
const esCero = v => /^-?0+(\.0+)?$/.test(String(v));
// Finanzas es central: ve las integraciones e importaciones de todos los locales (para asignar
// cuentas a los medios y procesar los cobros). El resto, sólo las de sus sedes.
const sedesPos = req => puede(req.usuario, 'finanzas') && !req.query.sede ? null : filtroSedes(req);
const accede = (req, sedeId) => !!rolEn(req.usuario, sedeId) || puede(req.usuario, 'finanzas');
// Importe para los mensajes, al peso como en pantalla: "$2.500".
const $p = v => (Number(v) < 0 ? '-$' : '$') + Math.round(Math.abs(Number(v))).toLocaleString('es-AR');
const limpiar = v => v == null ? null : String(v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

// ── Recetas de venta ─────────────────────────────────────────────────────────────────────────
r.get('/platos', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pl.id, pl.nombre, pl.activo, pl.notas, COUNT(pi.id)::int AS ingredientes,
            (SELECT COUNT(*)::int FROM pos.articulo a WHERE a.plato_id = pl.id) AS articulos
       FROM logic.plato pl LEFT JOIN logic.plato_item pi ON pi.plato_id = pl.id
      WHERE ($1 OR pl.activo) GROUP BY pl.id ORDER BY pl.activo DESC, pl.nombre`, [req.query.todos === '1']);
  res.json({ ok: true, platos: rows });
}));

r.get('/platos/:id', h(async (req, res) => {
  const { rows: [pl] } = await pool.query('SELECT id, nombre, notas, activo FROM logic.plato WHERE id = $1::uuid', [req.params.id]);
  if (!pl) throw new ErrorUsuario('No existe ese plato.', 404);
  const [{ rows: items }, { rows: articulos }] = await Promise.all([
    pool.query(`SELECT pi.producto_id, p.nombre AS producto, p.unidad_base, trim_scale(pi.cantidad_base)::text AS cantidad,
                       trim_scale(pi.merma_pct)::text AS merma_pct,
                       trim_scale((pi.cantidad_base / (1 - pi.merma_pct / 100) * p.costo_base)::numeric(16,2))::text AS costo
                  FROM logic.plato_item pi JOIN logic.producto p ON p.id = pi.producto_id WHERE pi.plato_id = $1 ORDER BY p.nombre`, [pl.id]),
    pool.query(`SELECT a.id, a.nombre, a.codigo_externo, i.nombre AS integracion FROM pos.articulo a
                  JOIN pos.integracion i ON i.id = a.integracion_id WHERE a.plato_id = $1 ORDER BY i.nombre, a.nombre`, [pl.id]),
  ]);
  // Costo teórico de una porción con el costo vigente de cada ingrediente: el dato del food cost.
  const { rows: [{ costo }] } = await pool.query(
    `SELECT trim_scale(SUM(pi.cantidad_base / (1 - pi.merma_pct / 100) * p.costo_base)::numeric(16,2))::text AS costo,
            bool_or(p.costo_base IS NULL) AS incompleto
       FROM logic.plato_item pi JOIN logic.producto p ON p.id = pi.producto_id WHERE pi.plato_id = $1`, [pl.id]);
  res.json({ ok: true, plato: { ...pl, items, articulos, costo } });
}));

async function guardarPlato(c, id, b) {
  const nombre = texto(b.nombre, { campo: 'el nombre del plato', requerido: true });
  const items = (Array.isArray(b.items) ? b.items : []).filter(x => x.producto_id);
  if (!items.length) throw new ErrorUsuario('El plato no tiene ingredientes.');
  if (id) {
    const { rowCount } = await c.query('UPDATE logic.plato SET nombre=$1, notas=$2, activo=$3 WHERE id=$4::uuid',
      [nombre, texto(b.notas), b.activo === undefined ? true : !!b.activo, id]);
    if (!rowCount) throw new ErrorUsuario('No existe ese plato.', 404);
    await c.query('DELETE FROM logic.plato_item WHERE plato_id = $1', [id]);
  } else {
    ({ rows: [{ id }] } = await c.query('INSERT INTO logic.plato (nombre, notas) VALUES ($1,$2) RETURNING id', [nombre, texto(b.notas)]));
  }
  for (const [i, x] of items.entries()) {
    const { rows: [p] } = await c.query('SELECT unidad_base FROM logic.producto WHERE id = $1::uuid', [x.producto_id]);
    if (!p) throw new ErrorUsuario(`El ingrediente ${i + 1} no existe.`);
    const cant = await aBase(c, numero(x.cantidad, { campo: `Cantidad del ingrediente ${i + 1}`, requerido: true, positivo: true }),
      texto(x.unidad), p.unidad_base, `El ingrediente ${i + 1}`);
    const merma = numero(x.merma_pct, { campo: `Merma del ingrediente ${i + 1}` }) || '0';
    await c.query('INSERT INTO logic.plato_item (plato_id, producto_id, cantidad_base, merma_pct) VALUES ($1,$2,$3,$4)',
      [id, x.producto_id, cant, merma]);
  }
  return id;
}
r.post('/platos', h(async (req, res) => res.status(201).json({ ok: true, id: await enTransaccion(c => guardarPlato(c, null, req.body)) })));
r.put('/platos/:id', h(async (req, res) => res.json({ ok: true, id: await enTransaccion(c => guardarPlato(c, req.params.id, req.body)) })));

// ── Integraciones ────────────────────────────────────────────────────────────────────────────
async function integracion(c, req, id, bloquear = false) {
  const { rows: [i] } = await c.query(
    `SELECT i.*, s.nombre AS sede FROM pos.integracion i JOIN org.sede s ON s.id = i.sede_id WHERE i.id = $1::uuid ${bloquear ? 'FOR UPDATE OF i' : ''}`, [id]);
  if (!i) throw new ErrorUsuario('No existe esa integración.', 404);
  if (!accede(req, i.sede_id)) throw new ErrorUsuario('No tenés acceso a esa sede.', 403);
  return i;
}

r.get('/pos/integraciones', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.nombre, i.sistema, i.modo, i.sede_id, s.nombre AS sede, i.almacen_id, a.nombre AS almacen,
            i.ubicacion_id, u.nombre AS ubicacion, i.activa, i.ultima_sincronizacion, i.mapeo,
            i.credenciales IS NOT NULL AS tiene_credenciales,
            (SELECT COUNT(*)::int FROM pos.articulo_pendiente p WHERE p.integracion_id = i.id) AS articulos_sin_receta,
            (SELECT COUNT(*)::int FROM pos.medio m WHERE m.integracion_id = i.id AND m.cuenta_id IS NULL) AS medios_sin_cuenta,
            i.codigo, i.cuenta_efectivo_id, ce.nombre AS cuenta_efectivo, sce.saldo::text AS efectivo_a_rendir, i.sincroniza_auto
       FROM pos.integracion i JOIN org.sede s ON s.id = i.sede_id
       LEFT JOIN fin.cuenta ce ON ce.id = i.cuenta_efectivo_id LEFT JOIN fin.saldo_cuenta sce ON sce.cuenta_id = ce.id
       JOIN logic.almacen a ON a.id = i.almacen_id JOIN logic.ubicacion u ON u.id = i.ubicacion_id
      WHERE $1::uuid[] IS NULL OR i.sede_id = ANY($1)
      ORDER BY s.nombre, i.nombre`, [sedesPos(req)]);
  res.json({ ok: true, integraciones: rows });
}));

function leerIntegracion(b) {
  const i = {
    nombre: texto(b.nombre),
    codigo: texto(b.codigo),
    sede_id: texto(b.sede_id, { campo: 'el local', requerido: true }),
    sistema: texto(b.sistema, { campo: 'el sistema', requerido: true }),
    modo: texto(b.modo, { campo: 'el modo', requerido: true }),
    almacen_id: texto(b.almacen_id),
    ubicacion_id: texto(b.ubicacion_id),
    activa: b.activa === undefined ? true : !!b.activa,
    apiKey: texto(b.apiKey), apiSecret: texto(b.apiSecret),
    // Por API se traen solas todos los días a las 5:00 (se puede pausar); por archivo, siempre a mano.
    sincroniza_auto: b.sincroniza_auto === undefined ? true : !!b.sincroniza_auto,
  };
  if (!['fudo', 'maxirest', 'otro'].includes(i.sistema)) throw new ErrorUsuario('Sistema inválido.');
  if (!['api', 'archivo'].includes(i.modo)) throw new ErrorUsuario('El modo es api o archivo.');
  if (i.modo === 'api' && i.sistema !== 'fudo') throw new ErrorUsuario('Por ahora la API sólo está disponible para Fudo; Maxirest y otros van por archivo.');
  if ((i.apiKey && !i.apiSecret) || (!i.apiKey && i.apiSecret)) throw new ErrorUsuario('Cargá juntos el apiKey y el apiSecret.');
  return i;
}
// Las credenciales se cifran con la clave propia de ClauLogic y nunca se devuelven.
const cifrar = i => i.apiKey ? crypto.encrypt(JSON.stringify({ apiKey: i.apiKey, apiSecret: i.apiSecret })) : null;

// El sistema de venta de una sede punto de venta (una por sede; se configura desde la ficha de la sede).
// Toma el nombre de la sede y descuenta de su única ubicación. Nace con su cuenta de efectivo
// ("Efectivo · <sede>"): su saldo es lo que tiene pendiente de rendir a la central.
async function datosDeSede(c, i) {
  const { rows: [sd] } = await c.query('SELECT nombre, tipo, es_central FROM org.sede WHERE id = $1::uuid', [i.sede_id]);
  if (!sd) throw new ErrorUsuario('No existe esa sede.');
  if (sd.tipo !== 'local' || sd.es_central) throw new ErrorUsuario('Sólo una sede punto de venta tiene sistema de venta.');
  const { rows: [u] } = await c.query(
    `SELECT u.id, u.almacen_id FROM logic.ubicacion u JOIN logic.almacen a ON a.id = u.almacen_id
      WHERE a.sede_id = $1 AND a.activo AND u.activa ORDER BY u.nombre LIMIT 1`, [i.sede_id]);
  if (!u) throw new ErrorUsuario('La sede no tiene su depósito: revisalo en Almacenes.');
  return { ...i, nombre: sd.nombre, almacen_id: u.almacen_id, ubicacion_id: u.id };
}
r.post('/pos/integraciones', h(async (req, res) => {
  let i = leerIntegracion(req.body);
  if (i.modo === 'api' && !i.apiKey) throw new ErrorUsuario('El modo API necesita apiKey y apiSecret.');
  const id = await enTransaccion(async c => {
    i = await datosDeSede(c, i);
    const { rows: [n] } = await c.query(
      `INSERT INTO pos.integracion (nombre, codigo, sede_id, sistema, modo, almacen_id, ubicacion_id, activa, credenciales, sincroniza_auto)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [i.nombre, i.codigo, i.sede_id, i.sistema, i.modo, i.almacen_id, i.ubicacion_id, i.activa, i.modo === 'api' ? cifrar(i) : null, i.sincroniza_auto]);
    const { rows: [cu] } = await c.query(`INSERT INTO fin.cuenta (nombre, tipo, sede_id) VALUES ($1, 'caja', $2) RETURNING id`,
      ['Efectivo · ' + i.nombre, i.sede_id]);
    await c.query('UPDATE pos.integracion SET cuenta_efectivo_id = $1 WHERE id = $2', [cu.id, n.id]);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

r.put('/pos/integraciones/:id', h(async (req, res) => {
  let i = leerIntegracion(req.body);
  await enTransaccion(async c => {
    const ant = await integracion(c, req, req.params.id, true);
    if (ant.sede_id !== i.sede_id) throw new ErrorUsuario('El sistema de venta no cambia de sede.');
    i = await datosDeSede(c, i);
    // Sin credenciales nuevas se conservan las que había (no se muestran, así que no se reenvían).
    const cred = i.modo !== 'api' ? null : i.apiKey ? cifrar(i) : ant.credenciales;
    if (i.modo === 'api' && !cred) throw new ErrorUsuario('El modo API necesita apiKey y apiSecret.');
    await c.query(`UPDATE pos.integracion SET nombre=$1, sistema=$2, modo=$3, almacen_id=$4, ubicacion_id=$5, activa=$6, credenciales=$7, codigo=$9,
                          sincroniza_auto=$10 WHERE id=$8`, [i.nombre, i.sistema, i.modo, i.almacen_id, i.ubicacion_id, i.activa, cred, ant.id, i.codigo, i.sincroniza_auto]);
    // La cuenta de efectivo acompaña el nombre del punto de venta.
    if (ant.cuenta_efectivo_id && ant.nombre !== i.nombre)
      await c.query('UPDATE fin.cuenta SET nombre = $1 WHERE id = $2', ['Efectivo · ' + i.nombre, ant.cuenta_efectivo_id]);
    if (i.apiKey) fudo.olvidarToken(ant.id);
  });
  res.json({ ok: true, id: req.params.id });
}));

// ── Recepción de tickets ─────────────────────────────────────────────────────────────────────
// Formato común (de cualquier origen): tickets con items y pagos, importes como texto.
async function recibir(c, integ, origen, { archivo = null, desde = null, hasta = null, tickets }) {
  const { rows: [imp] } = await c.query(
    `INSERT INTO pos.importacion (integracion_id, origen, archivo, desde, hasta) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [integ.id, origen, archivo, desde, hasta]);
  const articulos = new Map(), medios = new Map();
  const idArticulo = async (codigo, nombre) => {
    if (!articulos.has(codigo)) {
      const { rows: [a] } = await c.query(
        `INSERT INTO pos.articulo (integracion_id, codigo_externo, nombre) VALUES ($1,$2,$3)
         ON CONFLICT (integracion_id, codigo_externo) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id`, [integ.id, codigo, nombre || codigo]);
      articulos.set(codigo, a.id);
    }
    return articulos.get(codigo);
  };
  const idMedio = async (codigo, nombre) => {
    if (!medios.has(codigo)) {
      const { rows: [m] } = await c.query(
        `INSERT INTO pos.medio (integracion_id, codigo_externo, nombre) VALUES ($1,$2,$3)
         ON CONFLICT (integracion_id, codigo_externo) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id`, [integ.id, codigo, nombre || codigo]);
      medios.set(codigo, m.id);
    }
    return medios.get(codigo);
  };
  let nuevos = 0;
  for (const t of tickets) {
    // El id del POS hace idempotente la importación: un ticket que ya está, no se toca.
    const { rows: [nt] } = await c.query(
      // El día de la venta: el de su apertura si el POS la trae (Fudo), si no el de su fecha (archivos).
      `INSERT INTO pos.ticket (integracion_id, importacion_id, id_externo, cerrado_en, estado, total, tipo, mesa, mozo, personas, abierto_en, dia)
       VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11::timestamptz,
               (COALESCE($11::timestamptz, $4::timestamptz) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
       ON CONFLICT (integracion_id, id_externo) DO NOTHING RETURNING id`,
      [integ.id, imp.id, t.id, t.cerrado_en, t.estado, t.total, t.tipo, t.mesa == null ? null : String(t.mesa), t.mozo, t.personas, t.abierto_en || null]);
    if (!nt) continue;
    nuevos++;
    for (const it of t.items)
      await c.query('INSERT INTO pos.ticket_item (ticket_id, articulo_id, cantidad, precio, importe, anulado) VALUES ($1,$2,$3,$4,$5,$6)',
        [nt.id, await idArticulo(it.codigo, it.nombre), it.cantidad, it.precio, it.importe ?? null, !!it.anulado]);
    for (const p of t.pagos)
      await c.query('INSERT INTO pos.ticket_pago (ticket_id, medio_id, importe, anulado, id_externo) VALUES ($1,$2,$3,$4,$5)',
        [nt.id, await idMedio(p.codigo, p.nombre), p.importe, !!p.anulado, p.id || null]);
  }
  // Si no había nada nuevo (el mismo día importado dos veces), no queda una importación vacía.
  if (!nuevos) {
    await c.query('DELETE FROM pos.importacion WHERE id = $1', [imp.id]);
    return { id: null, nuevos: 0, repetidos: tickets.length };
  }
  await c.query('UPDATE pos.importacion SET tickets_nuevos = $1, tickets_repetidos = $2 WHERE id = $3', [nuevos, tickets.length - nuevos, imp.id]);
  return { id: imp.id, nuevos, repetidos: tickets.length - nuevos };
}

// Fudo por API: el rango va en días del local y se pasa a UTC para la consulta.
r.post('/pos/integraciones/:id/sincronizar', h(async (req, res) => {
  const desde = fecha(req.body.desde, { campo: 'Desde', requerido: true });
  const hasta = fecha(req.body.hasta, { campo: 'Hasta' }) || desde;
  const integ = await integracion(pool, req, req.params.id);
  exigirOperarEn(req, integ.sede_id, integ.sede);
  res.status(201).json({ ok: true, ...await sincronizarRango(req, integ, desde, hasta) });
}));

// Trae las ventas de un rango por la API, guarda la liquidación de cada pago, procesa los días sin observaciones y
// liquida los lotes vencidos. La usan la pantalla (un rango elegido) y la corrida diaria (`correr`).
async function sincronizarRango(req, integ, desde, hasta) {
  if (integ.modo !== 'api' || integ.sistema !== 'fudo') throw new ErrorUsuario('Esta integración es por archivo.');
  if (!integ.credenciales) throw new ErrorUsuario('Faltan las credenciales de la API.');
  const { rows: [rango] } = await pool.query(
    `SELECT to_char(($1::date::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS d,
            to_char((($2::date + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'UTC' - interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS h,
            $2::date - $1::date AS dias, $2::date >= current_date AS hasta_hoy`, [desde, hasta]);
  if (rango.dias < 0) throw new ErrorUsuario('El rango está al revés.');
  // El día en curso no se importa: todavía hay mesas abiertas y cobros por hacer (decisión de Fer).
  if (rango.hasta_hoy) throw new ErrorUsuario('El día de hoy todavía está en curso: se trae a partir de mañana. Elegí hasta ayer.');
  if (rango.dias > 31) throw new ErrorUsuario('Sincronizá de a un mes como máximo.');
  let datos, liq = new Map(), avisoLiquidacion = null;
  try {
    const cred = JSON.parse(crypto.decrypt(integ.credenciales));
    datos = await fudo.ventas(integ.id, cred, rango.d, rango.h);
    // La liquidación de cada pago (Fudo Pagos: fecha y neto del lote). Si falla, las ventas entran igual.
    try { liq = await fudo.liquidaciones(integ.id, cred, rango.d, rango.h); }
    catch (e) { if (!(e instanceof fudo.ErrorFudo)) throw e; avisoLiquidacion = e.message; console.error(`Fudo, liquidaciones (${integ.nombre}):`, e.message); }
  }
  // 424 y no 502: el proxy de EasyPanel reemplaza toda respuesta 502 por su propia página y el detalle se pierde.
  catch (e) {
    if (!(e instanceof fudo.ErrorFudo)) throw e;
    console.error(`Fudo (${integ.nombre}):`, e.message);
    throw new ErrorUsuario(e.message, 424);
  }
  const out = await enTransaccion(async c => {
    const o = await recibir(c, integ, 'api', { desde, hasta, tickets: datos.tickets });
    await c.query('UPDATE pos.integracion SET ultima_sincronizacion = now() WHERE id = $1', [integ.id]);
    // Cada pago queda con su número del POS y, si el procesador la informó, su liquidación (fecha y neto). También
    // los de ventas que ya estaban: los anteriores a esto no tenían el número, y se reconocen por medio e importe.
    // Un pago ya liquidado en un lote no cambia.
    for (const t of datos.tickets) for (const p of t.pagos) {
      if (!p.id) continue;
      const l = liq.get(p.id) || {};
      await c.query(
        `UPDATE pos.ticket_pago tp SET id_externo = $3,
                liquida_el = CASE WHEN tp.lote_id IS NULL THEN COALESCE($4::date, tp.liquida_el) ELSE tp.liquida_el END,
                neto = CASE WHEN tp.lote_id IS NULL THEN COALESCE($5::numeric, tp.neto) ELSE tp.neto END
          WHERE tp.id = (SELECT x.id FROM pos.ticket_pago x JOIN pos.ticket tk ON tk.id = x.ticket_id JOIN pos.medio m ON m.id = x.medio_id
                          WHERE tk.integracion_id = $1 AND tk.id_externo = $2
                            AND (x.id_externo = $3 OR (x.id_externo IS NULL AND m.codigo_externo = $6 AND x.importe = $7::numeric))
                          ORDER BY x.id_externo IS NULL, x.id LIMIT 1)`,
        [integ.id, t.id, p.id, l.liquida_el || null, l.neto || null, p.codigo, p.importe]);
    }
    // Por cada día del rango, cuántas ventas seguían abiertas: ese día todavía no está completo.
    await c.query(
      `INSERT INTO pos.sincronizacion_dia (integracion_id, dia, abiertas)
       SELECT $1, d::date, COALESCE(($4::jsonb ->> to_char(d, 'YYYY-MM-DD'))::int, 0)
         FROM generate_series($2::date, $3::date, interval '1 day') d
       ON CONFLICT (integracion_id, dia) DO UPDATE SET abiertas = EXCLUDED.abiertas, sincronizado_en = now()`,
      [integ.id, desde, hasta, JSON.stringify(datos.abiertas || {})]);
    return { ...o, abiertas: Object.values(datos.abiertas || {}).reduce((a, n) => a + n, 0) };
  });
  const cobros = await procesarListos(req, integ, desde, hasta);
  // Los lotes cuya fecha de liquidación ya llegó se liquidan solos (Fudo Pagos).
  return { ...out, cobros, lotes: await acreditarLotes(req), aviso_liquidacion: avisoLiquidacion };
}

// ── La corrida diaria ────────────────────────────────────────────────────────────────────────
// Trae el día anterior y repasa los dos de antes (mesas que cerraron tarde, liquidaciones que Fudo completa
// después); si la última corrida buena es más vieja, desde el día siguiente a lo que trajo (hasta un mes). Queda
// registrada con su resultado o su error. La automática corre una vez por día y por punto de venta.
async function correr(req, integ, automatica) {
  if (integ.modo !== 'api' || integ.sistema !== 'fudo') throw new ErrorUsuario('Este punto de venta es por archivo: las ventas se importan desde Procesar ventas.');
  if (!integ.credenciales) throw new ErrorUsuario('Faltan las credenciales de la API en la ficha de la sede.');
  const { rows: [r] } = await pool.query(
    `SELECT to_char(GREATEST(LEAST(current_date - 3, COALESCE((SELECT MAX(hasta) + 1 FROM pos.corrida WHERE integracion_id = $1 AND ok), current_date - 3)),
                             current_date - 31), 'YYYY-MM-DD') AS desde,
            to_char(current_date - 1, 'YYYY-MM-DD') AS hasta`, [integ.id]);
  const { rows: [co] } = await pool.query(
    `INSERT INTO pos.corrida (integracion_id, automatica, desde, hasta) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
    [integ.id, automatica, r.desde, r.hasta]);
  if (!co) return null;   // la automática de hoy ya corrió (u otro proceso la está corriendo)
  try {
    const o = await sincronizarRango(req, integ, r.desde, r.hasta);
    const resumen = { nuevos: o.nuevos, repetidos: o.repetidos, abiertas: o.abiertas,
      cobros: o.cobros && { procesados: o.cobros.procesados.length, revisar: o.cobros.revisar.length },
      lotes: o.lotes && o.lotes.lotes.length, aviso: o.aviso_liquidacion || null };
    await pool.query('UPDATE pos.corrida SET terminada_en = now(), ok = true, resultado = $2 WHERE id = $1', [co.id, JSON.stringify(resumen)]);
    return { ...o, desde: r.desde, hasta: r.hasta };
  } catch (e) {
    await pool.query('UPDATE pos.corrida SET terminada_en = now(), ok = false, error = $2 WHERE id = $1', [co.id, String(e.message || e).slice(0, 500)]);
    if (!automatica) throw e;
    console.error(`Corrida automática (${integ.nombre}):`, e.message);
    return null;
  }
}

// "Traer ahora": la misma corrida, pedida a mano (no consume la automática del día).
r.post('/pos/integraciones/:id/correr', h(async (req, res) => {
  const integ = await integracion(pool, req, req.params.id);
  exigirOperarEn(req, integ.sede_id, integ.sede);
  res.status(201).json({ ok: true, ...await correr(req, integ, false) });
}));

// Las corridas automáticas pendientes de hoy (las llama el programador, firmadas por el usuario de sistema).
async function correrAutomaticas(req) {
  const { rows } = await pool.query(
    `SELECT i.*, s.nombre AS sede FROM pos.integracion i JOIN org.sede s ON s.id = i.sede_id
      WHERE i.activa AND s.activa AND i.modo = 'api' AND i.sincroniza_auto AND i.credenciales IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pos.corrida c WHERE c.integracion_id = i.id AND c.automatica AND c.fecha = current_date)`);
  for (const integ of rows) await correr(req, integ, true);
  return rows.length;
}

// Por archivo: renglones de venta (uno por artículo de cada ticket) y, opcionalmente, pagos. Las
// columnas las elige el usuario en la pantalla y se recuerdan por integración.
function importeArchivo(v, decimal, campo) {
  let s = String(v ?? '').trim().replace(/[$\s]/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  s = decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new ErrorUsuario(`${campo}: "${v}" no es un número.`);
  return (neg ? '-' : '') + s;
}
function fechaHoraArchivo(v, campo) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${(m[4] || '0').padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new ErrorUsuario(`${campo}: "${v}" no es una fecha (se espera DD/MM/AAAA HH:MM).`);
  const anio = m[3].length === 2 ? '20' + m[3] : m[3];
  if (+m[2] < 1 || +m[2] > 12 || +m[1] < 1 || +m[1] > 31) throw new ErrorUsuario(`${campo}: "${v}" no es una fecha válida.`);
  return `${anio}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')} ${(m[4] || '0').padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'}`;
}
const ANULADO = /^(s[ií]|si|true|1|anulad[oa]|cancelad[oa]|x)$/i;

r.post('/pos/integraciones/:id/importar', h(async (req, res) => {
  const b = req.body, decimal = b.decimal === '.' ? '.' : ',';
  const ventas = Array.isArray(b.ventas) ? b.ventas : [], pagos = Array.isArray(b.pagos) ? b.pagos : [];
  if (!ventas.length) throw new ErrorUsuario('El archivo de ventas no tiene filas.');
  if (ventas.length > 50000) throw new ErrorUsuario('Demasiadas filas: importá por día o por semana.');
  const integ = await integracion(pool, req, req.params.id);
  exigirOperarEn(req, integ.sede_id, integ.sede);
  const tickets = new Map();
  const ticket = (id, f, fila) => {
    if (!id) throw new ErrorUsuario(`Fila ${fila}: falta el número de ticket.`);
    if (!tickets.has(id)) tickets.set(id, { id, cerrado_en: f, estado: 'cerrado', total: null, items: [], pagos: [] });
    return tickets.get(id);
  };
  ventas.forEach((v, i) => {
    const n = i + 1, id = String(v.ticket ?? '').trim();
    const t = ticket(id, v.fecha ? fechaHoraArchivo(v.fecha, `Fila ${n}`) : null, n);
    if (!t.cerrado_en && v.fecha) t.cerrado_en = fechaHoraArchivo(v.fecha, `Fila ${n}`);
    const nombre = String(v.articulo ?? '').trim(), codigo = String(v.codigo ?? '').trim() || nombre;
    if (!codigo) throw new ErrorUsuario(`Fila ${n}: falta el artículo.`);
    const cant = importeArchivo(v.cantidad, decimal, `Fila ${n}, cantidad`) || '1';
    if (cant.startsWith('-') || esCero(cant)) return;   // devoluciones y renglones vacíos no consumen
    t.items.push({ codigo, nombre: nombre || codigo, cantidad: cant, precio: importeArchivo(v.precio, decimal, `Fila ${n}, precio`),
                   importe: importeArchivo(v.importe, decimal, `Fila ${n}, importe`), anulado: ANULADO.test(String(v.anulado ?? '').trim()) });
    if (ANULADO.test(String(v.ticket_anulado ?? '').trim())) t.estado = 'anulado';
  });
  pagos.forEach((p, i) => {
    const n = i + 1, id = String(p.ticket ?? '').trim();
    const t = tickets.get(id);
    if (!t) throw new ErrorUsuario(`Pagos, fila ${n}: el ticket "${id}" no está en el archivo de ventas.`);
    const medio = String(p.medio ?? '').trim();
    if (!medio) throw new ErrorUsuario(`Pagos, fila ${n}: falta el medio de cobro.`);
    t.pagos.push({ codigo: medio, nombre: medio, importe: importeArchivo(p.importe, decimal, `Pagos, fila ${n}`) || '0' });
  });
  for (const t of tickets.values()) if (!t.cerrado_en) throw new ErrorUsuario(`El ticket ${t.id} no tiene fecha.`);
  const lista = [...tickets.values()];
  const out = await enTransaccion(async c => {
    const fechas = lista.map(t => t.cerrado_en.slice(0, 10)).sort();
    // El día en curso no se importa (decisión de Fer): el archivo tiene que terminar ayer.
    const { rows: [hoyDb] } = await c.query(`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`);
    if (fechas.at(-1) >= hoyDb.d) throw new ErrorUsuario('El archivo trae ventas de hoy: el día en curso no se importa. Exportá hasta ayer.');
    const o = await recibir(c, integ, 'archivo', { archivo: texto(b.archivo), desde: fechas[0], hasta: fechas.at(-1), tickets: lista });
    // Se recuerdan las columnas elegidas para la próxima vez.
    if (b.mapeo && typeof b.mapeo === 'object')
      await c.query('UPDATE pos.integracion SET mapeo = $1 WHERE id = $2', [JSON.stringify(b.mapeo).slice(0, 4000), integ.id]);
    return { ...o, desde: fechas[0], hasta: fechas.at(-1) };
  });
  res.status(201).json({ ok: true, ...out, cobros: await procesarListos(req, integ, out.desde, out.hasta) });
}));

// ── Importaciones ────────────────────────────────────────────────────────────────────────────
const RESUMEN = `
  (SELECT COUNT(*)::int FROM pos.ticket t WHERE t.importacion_id = im.id) AS tickets,
  (SELECT COUNT(*)::int FROM pos.ticket t WHERE t.importacion_id = im.id AND t.estado = 'anulado') AS anulados,
  (SELECT trim_scale(COALESCE(SUM(p.importe), 0))::text FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id
     WHERE t.importacion_id = im.id AND t.estado = 'cerrado' AND NOT p.anulado) AS cobrado,
  (SELECT trim_scale(COALESCE(SUM(COALESCE(i.importe, i.cantidad * i.precio)), 0)::numeric(16,2))::text FROM pos.ticket_item i JOIN pos.ticket t ON t.id = i.ticket_id
     WHERE t.importacion_id = im.id AND t.estado = 'cerrado' AND NOT i.anulado) AS vendido,
  (SELECT COUNT(*)::int FROM pos.ticket_item i JOIN pos.ticket t ON t.id = i.ticket_id
     WHERE t.importacion_id = im.id AND t.estado = 'cerrado' AND NOT i.anulado AND i.consumo_id IS NULL) AS renglones_pendientes,
  (SELECT COUNT(*)::int FROM pos.ticket_item i JOIN pos.ticket t ON t.id = i.ticket_id JOIN pos.articulo a ON a.id = i.articulo_id
     WHERE t.importacion_id = im.id AND t.estado = 'cerrado' AND NOT i.anulado AND i.consumo_id IS NULL
       AND a.plato_id IS NULL AND NOT a.sin_consumo) AS renglones_sin_receta,
  (SELECT COUNT(*)::int FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id
     WHERE t.importacion_id = im.id AND t.estado = 'cerrado' AND NOT p.anulado AND p.cobro_id IS NULL) AS pagos_pendientes,
  (SELECT COUNT(*)::int FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
     WHERE t.importacion_id = im.id AND t.estado = 'cerrado' AND NOT p.anulado AND p.cobro_id IS NULL AND m.cuenta_id IS NULL) AS pagos_sin_cuenta`;

r.get('/pos/importaciones', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT im.id, im.integracion_id, i.nombre AS integracion, s.nombre AS sede, im.origen, im.archivo, im.desde, im.hasta,
            im.tickets_nuevos, im.tickets_repetidos, im.estado, im.creado_por, im.creado_en, ${RESUMEN}
       FROM pos.importacion im JOIN pos.integracion i ON i.id = im.integracion_id JOIN org.sede s ON s.id = i.sede_id
      WHERE ($1::uuid[] IS NULL OR i.sede_id = ANY($1)) AND ($2::uuid IS NULL OR im.integracion_id = $2)
      ORDER BY im.creado_en DESC LIMIT 200`, [sedesPos(req), texto(req.query.integracion)]);
  res.json({ ok: true, importaciones: rows });
}));

async function importacion(c, req, id, bloquear = false) {
  const { rows: [im] } = await c.query(
    `SELECT im.*, i.nombre AS integracion, i.sede_id, s.nombre AS sede, i.almacen_id, i.ubicacion_id
       FROM pos.importacion im JOIN pos.integracion i ON i.id = im.integracion_id JOIN org.sede s ON s.id = i.sede_id
      WHERE im.id = $1::uuid ${bloquear ? 'FOR UPDATE OF im' : ''}`, [id]);
  if (!im) throw new ErrorUsuario('No existe esa importación.', 404);
  if (!accede(req, im.sede_id)) throw new ErrorUsuario('No tenés acceso a esa sede.', 403);
  return im;
}

r.get('/pos/importaciones/:id', h(async (req, res) => {
  const im = await importacion(pool, req, req.params.id);
  const [{ rows: [res_] }, art, med, cons] = await Promise.all([
    pool.query(`SELECT ${RESUMEN} FROM pos.importacion im WHERE im.id = $1`, [im.id]),
    pool.query(`SELECT a.id, a.nombre, a.codigo_externo, a.plato_id, pl.nombre AS plato, a.sin_consumo,
                       trim_scale(SUM(i.cantidad))::text AS cantidad, bool_or(i.consumo_id IS NULL) AS pendiente
                  FROM pos.ticket_item i JOIN pos.ticket t ON t.id = i.ticket_id JOIN pos.articulo a ON a.id = i.articulo_id
                  LEFT JOIN logic.plato pl ON pl.id = a.plato_id
                 WHERE t.importacion_id = $1 AND t.estado = 'cerrado' AND NOT i.anulado
                 GROUP BY a.id, pl.nombre ORDER BY SUM(i.cantidad) DESC`, [im.id]),
    pool.query(`SELECT m.id, m.nombre, m.cuenta_id, cu.nombre AS cuenta, trim_scale(SUM(p.importe))::text AS importe,
                       bool_or(p.cobro_id IS NULL) AS pendiente
                  FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
                  LEFT JOIN fin.cuenta cu ON cu.id = m.cuenta_id
                 WHERE t.importacion_id = $1 AND t.estado = 'cerrado' AND NOT p.anulado
                 GROUP BY m.id, cu.nombre ORDER BY SUM(p.importe) DESC`, [im.id]),
    pool.query(`SELECT 'consumo' AS tipo, c.id, c.creado_en, c.creado_por, c.estado, c.renglones AS cantidad FROM pos.consumo c WHERE c.importacion_id = $1
                UNION ALL
                SELECT 'cobro', c.id, c.creado_en, c.creado_por, c.estado, c.pagos FROM pos.cobro c WHERE c.importacion_id = $1
                ORDER BY creado_en`, [im.id]),
  ]);
  res.json({ ok: true, importacion: { ...im, ...res_, articulos: art.rows, medios: med.rows, procesos: cons.rows,
    puede: { consumo: ['admin', 'encargado', 'operador'].includes(rolEn(req.usuario, im.sede_id)), cobros: puede(req.usuario, 'finanzas'),
             anular: ['admin', 'encargado'].includes(rolEn(req.usuario, im.sede_id)) } } });
}));

r.get('/pos/importaciones/:id/tickets', h(async (req, res) => {
  const im = await importacion(pool, req, req.params.id);
  const { rows } = await pool.query(
    `SELECT t.id, t.id_externo, t.cerrado_en, t.estado, t.total::text, t.tipo, t.mesa, t.mozo, t.personas,
            COALESCE((SELECT json_agg(json_build_object('articulo', a.nombre, 'cantidad', trim_scale(i.cantidad)::text,
                       'importe', i.importe::text, 'anulado', i.anulado) ORDER BY a.nombre)
                        FROM pos.ticket_item i JOIN pos.articulo a ON a.id = i.articulo_id WHERE i.ticket_id = t.id), '[]') AS items,
            COALESCE((SELECT json_agg(json_build_object('medio', m.nombre, 'importe', p.importe::text, 'anulado', p.anulado))
                        FROM pos.ticket_pago p JOIN pos.medio m ON m.id = p.medio_id WHERE p.ticket_id = t.id), '[]') AS pagos
       FROM pos.ticket t WHERE t.importacion_id = $1 ORDER BY t.cerrado_en LIMIT 2000`, [im.id]);
  res.json({ ok: true, tickets: rows });
}));

// ── Ventas: el tablero (sólo lectura) ────────────────────────────────────────────────────────
// Lo vendido por punto de venta y período (día de apertura), sobre los tickets guardados: totales, cobros por
// medio de pago, por día, por hora y por tipo, y el detalle de cada venta. Cada medio se agrupa por su medio de
// pago global (procesador + tipo); el que todavía no tiene uno asignado, por su nombre en el sistema.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function filtroVentas(req) {
  const desde = fecha(req.query.desde, { campo: 'Desde', requerido: true }), hasta = fecha(req.query.hasta, { campo: 'Hasta', requerido: true });
  if (hasta < desde) throw new ErrorUsuario('El período termina antes de empezar.');
  if ((new Date(hasta) - new Date(desde)) / 864e5 > 366) throw new ErrorUsuario('El período puede ser de hasta un año.');
  const integ = texto(req.query.integracion);
  if (integ && !UUID.test(integ)) throw new ErrorUsuario('Punto de venta inválido.');
  // Un medio de pago global (su id) o un medio del sistema todavía sin asignar ('m:' + su id).
  const medio = texto(req.query.medio);
  if (medio && !UUID.test(medio.replace(/^m:/, ''))) throw new ErrorUsuario('Medio de pago inválido.');
  // Para ir abriendo el detalle desde los gráficos: el tipo de venta y la hora de apertura.
  const tipo = texto(req.query.tipo), hora = req.query.hora == null || req.query.hora === '' ? null : Number(req.query.hora);
  if (hora != null && !(Number.isInteger(hora) && hora >= 0 && hora <= 23)) throw new ErrorUsuario('Hora inválida.');
  return [sedesPos(req), integ, desde, hasta, medio, tipo, hora, texto(req.query.mozo)];
}
// La hora de apertura (la del cierre si el POS no trae apertura), en la hora de la cocina.
const HORA_SQL = `extract(hour FROM COALESCE(abierto_en, cerrado_en) AT TIME ZONE 'America/Argentina/Buenos_Aires')::int`;
// Los tickets del filtro ($1 sedes, $2 punto de venta, $3 desde, $4 hasta, $5 medio, $6 tipo, $7 hora, $8 mozo),
// sólo de importaciones vigentes.
const VENTAS_CTE = `
  WITH t AS (
    SELECT t.*, i.nombre AS punto_venta,
           COALESCE(t.total, (SELECT SUM(COALESCE(it.importe, it.cantidad * it.precio)) FROM pos.ticket_item it
                               WHERE it.ticket_id = t.id AND NOT it.anulado), 0) AS vendido
      FROM pos.ticket t JOIN pos.importacion im ON im.id = t.importacion_id AND im.estado = 'recibida'
      JOIN pos.integracion i ON i.id = t.integracion_id
     WHERE ($1::uuid[] IS NULL OR i.sede_id = ANY($1)) AND ($2::uuid IS NULL OR t.integracion_id = $2)
       AND t.dia BETWEEN $3::date AND $4::date
       AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM pos.ticket_pago p JOIN pos.medio m ON m.id = p.medio_id
                                         WHERE p.ticket_id = t.id AND NOT p.anulado
                                           AND COALESCE(m.medio_pago_id::text, 'm:' || m.id) = $5))
       AND ($6::text IS NULL OR COALESCE(t.tipo, 'sin dato') = $6)
       AND ($7::int IS NULL OR extract(hour FROM COALESCE(t.abierto_en, t.cerrado_en) AT TIME ZONE 'America/Argentina/Buenos_Aires')::int = $7)
       AND ($8::text IS NULL OR COALESCE(t.mozo, 'sin mozo') = $8))`;
const CLAVE_MEDIO = `COALESCE(m.medio_pago_id::text, 'm:' || m.id)`;

r.get('/pos/ventas/resumen', h(async (req, res) => {
  const f = filtroVentas(req);
  const q = (sql, params = f) => pool.query(VENTAS_CTE + sql, params).then(r => r.rows);
  // El período anterior de la misma duración, terminando el día antes de `desde`: para comparar.
  const largo = Math.round((new Date(f[3]) - new Date(f[2])) / 864e5) + 1;
  const corrido = (d, n) => new Date(new Date(d + 'T12:00:00Z').getTime() - n * 864e5).toISOString().slice(0, 10);
  const ant = [f[0], f[1], corrido(f[2], largo), corrido(f[3], largo), ...f.slice(4)];
  const TOTALES = `SELECT count(*) FILTER (WHERE estado = 'cerrado')::int AS ventas, count(*) FILTER (WHERE estado = 'anulado')::int AS anuladas,
              COALESCE(SUM(vendido) FILTER (WHERE estado = 'cerrado'), 0)::numeric(16,2)::text AS vendido,
              COALESCE(SUM(personas) FILTER (WHERE estado = 'cerrado'), 0)::int AS personas,
              -- El promedio por cubierto, sólo sobre las ventas que traen cubiertos (el salón): lo de para llevar y
              -- delivery no tiene personas y lo inflaría.
              COALESCE(SUM(vendido) FILTER (WHERE estado = 'cerrado' AND personas > 0), 0)::numeric(16,2)::text AS vendido_con_personas,
              count(*) FILTER (WHERE estado = 'cerrado' AND personas > 0)::int AS ventas_con_personas,
              COALESCE((SELECT SUM(p.importe) FROM pos.ticket_pago p JOIN t ON t.id = p.ticket_id
                         WHERE t.estado = 'cerrado' AND NOT p.anulado), 0)::numeric(16,2)::text AS cobrado,
              COALESCE(SUM(vendido) FILTER (WHERE estado = 'anulado'), 0)::numeric(16,2)::text AS vendido_anuladas
         FROM t`;
  const DIAS = `SELECT to_char(dia, 'YYYY-MM-DD') AS dia, count(*)::int AS ventas, SUM(vendido)::numeric(16,2)::text AS vendido,
                       COALESCE(SUM(personas) FILTER (WHERE personas > 0), 0)::int AS personas,
                       COALESCE(SUM(vendido) FILTER (WHERE personas > 0), 0)::numeric(16,2)::text AS vendido_con_personas
                  FROM t WHERE estado = 'cerrado' GROUP BY dia ORDER BY dia`;
  const [[tot], [totAnt], diasAnt, medios, dias, horas, tipos, puntos, mozos] = await Promise.all([
    q(TOTALES), q(TOTALES, ant), q(DIAS, ant),
    // Con el filtro de un medio, los demás medios de esas mismas ventas también aparecen (pagos mixtos).
    q(`SELECT ${CLAVE_MEDIO} AS clave, mp.tipo_operacion, pr.nombre AS procesador, m.medio_pago_id IS NULL AS sin_asignar,
              string_agg(DISTINCT m.nombre, ', ') AS nombres, SUM(p.importe)::numeric(16,2)::text AS importe,
              count(*)::int AS pagos, count(DISTINCT t.id)::int AS ventas
         FROM t JOIN pos.ticket_pago p ON p.ticket_id = t.id AND NOT p.anulado JOIN pos.medio m ON m.id = p.medio_id
         LEFT JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id LEFT JOIN fin.procesador pr ON pr.id = mp.procesador_id
        WHERE t.estado = 'cerrado'
        GROUP BY 1, 2, 3, 4 ORDER BY SUM(p.importe) DESC`),
    q(DIAS),
    q(`SELECT ${HORA_SQL} AS hora,
              count(*)::int AS ventas, SUM(vendido)::numeric(16,2)::text AS vendido
         FROM t WHERE estado = 'cerrado' GROUP BY 1 ORDER BY 1`),
    q(`SELECT COALESCE(tipo, 'sin dato') AS tipo, count(*)::int AS ventas, SUM(vendido)::numeric(16,2)::text AS vendido,
              COALESCE(SUM(personas) FILTER (WHERE personas > 0), 0)::int AS personas,
              COALESCE(SUM(vendido) FILTER (WHERE personas > 0), 0)::numeric(16,2)::text AS vendido_con_personas
         FROM t WHERE estado = 'cerrado' GROUP BY 1 ORDER BY SUM(vendido) DESC`),
    q(`SELECT integracion_id AS id, punto_venta AS nombre, count(*)::int AS ventas, SUM(vendido)::numeric(16,2)::text AS vendido
         FROM t WHERE estado = 'cerrado' GROUP BY 1, 2 ORDER BY SUM(vendido) DESC`),
    q(`SELECT COALESCE(mozo, 'sin mozo') AS mozo, count(*)::int AS ventas, SUM(vendido)::numeric(16,2)::text AS vendido,
              COALESCE(SUM(personas) FILTER (WHERE personas > 0), 0)::int AS personas
         FROM t WHERE estado = 'cerrado' GROUP BY 1 ORDER BY SUM(vendido) DESC`),
  ]);
  res.json({ ok: true, totales: tot, medios, dias, horas, tipos, puntos, mozos,
    anterior: { desde: ant[2], hasta: ant[3], totales: totAnt, dias: diasAnt } });
}));

r.get('/pos/ventas', h(async (req, res) => {
  const f = filtroVentas(req);
  const { rows } = await pool.query(VENTAS_CTE + `
    SELECT t.id, t.id_externo, t.punto_venta, to_char(t.dia, 'YYYY-MM-DD') AS dia, t.abierto_en, t.cerrado_en, t.estado,
           t.vendido::numeric(16,2)::text AS total, t.tipo, t.mesa, t.mozo, t.personas,
           COALESCE((SELECT json_agg(json_build_object('clave', ${CLAVE_MEDIO}, 'medio', m.nombre, 'procesador', pr.nombre,
                                                       'tipo_operacion', mp.tipo_operacion, 'importe', p.importe::text) ORDER BY p.importe DESC)
                       FROM pos.ticket_pago p JOIN pos.medio m ON m.id = p.medio_id
                       LEFT JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id LEFT JOIN fin.procesador pr ON pr.id = mp.procesador_id
                      WHERE p.ticket_id = t.id AND NOT p.anulado), '[]') AS pagos
      FROM t ORDER BY COALESCE(t.abierto_en, t.cerrado_en) DESC LIMIT 1001`, f);
  res.json({ ok: true, ventas: rows.slice(0, 1000), recortado: rows.length > 1000 });
}));

r.get('/pos/ventas/:id', h(async (req, res) => {
  if (!UUID.test(req.params.id)) throw new ErrorUsuario('No existe esa venta.', 404);
  const { rows: [t] } = await pool.query(
    `SELECT t.id, t.id_externo, t.integracion_id, i.nombre AS punto_venta, i.sede_id, to_char(t.dia, 'YYYY-MM-DD') AS dia,
            t.abierto_en, t.cerrado_en, t.estado, t.total::text, t.tipo, t.mesa, t.mozo, t.personas, im.estado AS importacion
       FROM pos.ticket t JOIN pos.integracion i ON i.id = t.integracion_id JOIN pos.importacion im ON im.id = t.importacion_id
      WHERE t.id = $1`, [req.params.id]);
  if (!t) throw new ErrorUsuario('No existe esa venta.', 404);
  if (!accede(req, t.sede_id)) throw new ErrorUsuario('No tenés acceso a esa sede.', 403);
  const [items, pagos] = await Promise.all([
    pool.query(`SELECT a.nombre AS articulo, a.codigo_externo, trim_scale(i.cantidad)::text AS cantidad,
                       COALESCE(i.importe, i.cantidad * i.precio)::numeric(16,2)::text AS importe, i.anulado
                  FROM pos.ticket_item i JOIN pos.articulo a ON a.id = i.articulo_id WHERE i.ticket_id = $1 ORDER BY a.nombre`, [t.id]),
    pool.query(`SELECT m.nombre AS medio, pr.nombre AS procesador, mp.tipo_operacion, p.importe::text, p.anulado,
                       p.cobro_id IS NOT NULL AS procesado, cu.nombre AS cuenta
                  FROM pos.ticket_pago p JOIN pos.medio m ON m.id = p.medio_id
                  LEFT JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id LEFT JOIN fin.procesador pr ON pr.id = mp.procesador_id
                  LEFT JOIN fin.cuenta cu ON cu.id = m.cuenta_id
                 WHERE p.ticket_id = $1 ORDER BY p.importe DESC`, [t.id]),
  ]);
  res.json({ ok: true, venta: { ...t, items: items.rows, pagos: pagos.rows } });
}));

// ── Consumo teórico ──────────────────────────────────────────────────────────────────────────
// Lo vendido con receta, por ingrediente, descontado del almacén del local por FEFO (sin lotes
// vencidos). Lo que no alcanza queda en negativo (decisión de Fer): un perecedero, en el último
// lote conocido de ese producto; uno no perecedero, sin lote, en la ubicación de la integración.
// Un movimiento por producto y lote, no por ticket: el detalle está en los tickets.
r.post('/pos/importaciones/:id/consumo', h(async (req, res) => {
  const out = await enTransaccion(async c => {
    const im = await importacion(c, req, req.params.id, true);
    exigirOperarEn(req, im.sede_id, im.sede);
    if (im.estado !== 'recibida') throw new ErrorUsuario('La importación está anulada.');
    const { rows: items } = await c.query(
      `SELECT i.id, a.plato_id FROM pos.ticket_item i JOIN pos.ticket t ON t.id = i.ticket_id JOIN pos.articulo a ON a.id = i.articulo_id
        WHERE t.importacion_id = $1 AND t.estado = 'cerrado' AND NOT i.anulado AND i.consumo_id IS NULL
          AND (a.plato_id IS NOT NULL OR a.sin_consumo)
        FOR UPDATE OF i`, [im.id]);
    if (!items.length) throw new ErrorUsuario('No hay nada para procesar: lo vendido ya se descontó o le falta la receta.');
    const ids = items.map(x => x.id);
    const { rows: necesidad } = await c.query(
      `SELECT pi.producto_id, p.nombre, p.perecedero, p.unidad_base,
              SUM(i.cantidad * pi.cantidad_base / (1 - pi.merma_pct / 100))::numeric(16,4)::text AS necesario
         FROM pos.ticket_item i JOIN pos.articulo a ON a.id = i.articulo_id
         JOIN logic.plato_item pi ON pi.plato_id = a.plato_id JOIN logic.producto p ON p.id = pi.producto_id
        WHERE i.id = ANY($1::uuid[]) AND NOT a.sin_consumo
        GROUP BY pi.producto_id, p.nombre, p.perecedero, p.unidad_base ORDER BY pi.producto_id`, [ids]);
    for (const n of necesidad) await c.query('SELECT logic.bloquear_stock($1)', [n.producto_id]);
    const { rows: [co] } = await c.query(
      'INSERT INTO pos.consumo (importacion_id, sede_id, renglones) VALUES ($1,$2,$3) RETURNING id', [im.id, im.sede_id, items.length]);
    const motivo = `Ventas ${im.integracion}` + (im.desde ? ` del ${im.desde}${im.hasta && im.hasta !== im.desde ? ' al ' + im.hasta : ''}` : '');
    const negativos = [];
    const mover = (productoId, lote, cant, ubicacion) => c.query(
      `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, origen_id, motivo, referencia, pos_consumo_id)
       VALUES ('venta', $1, $2, $3, $4, $5, $6, $7)`, [productoId, lote, cant, ubicacion, motivo, `POS ${im.integracion}`, co.id]);
    for (const n of necesidad) {
      const { rows: lineas } = await c.query(
        `WITH d AS (
           SELECT ld.*, SUM(ld.cantidad) OVER (ORDER BY ld.vencimiento NULLS LAST, ld.lote, ld.ubicacion_id ROWS UNBOUNDED PRECEDING) AS acum
             FROM logic.lote_disponible ld
            WHERE ld.producto_id = $1 AND ld.almacen_id = $2 AND (ld.vencimiento IS NULL OR ld.vencimiento >= current_date))
         SELECT lote_id, ubicacion_id, LEAST(cantidad, $3::numeric - (acum - cantidad))::numeric(16,4)::text AS tomar
           FROM d WHERE acum - cantidad < $3::numeric ORDER BY acum`, [n.producto_id, im.almacen_id, n.necesario]);
      for (const l of lineas) await mover(n.producto_id, l.lote_id, l.tomar, l.ubicacion_id);
      const { rows: [f] } = await c.query(
        'SELECT ($1::numeric - COALESCE(SUM(x), 0))::numeric(16,4)::text AS falta FROM unnest($2::numeric[]) x', [n.necesario, lineas.map(l => l.tomar)]);
      if (esCero(f.falta) || f.falta.startsWith('-')) continue;
      let lote = null;
      if (n.perecedero) {
        // El último lote conocido: el más reciente que pasó por este almacén; si ninguno, el más reciente del producto.
        const { rows: [l] } = await c.query(
          `SELECT l.id FROM logic.lote l
            WHERE l.producto_id = $1
            ORDER BY EXISTS (SELECT 1 FROM logic.movimiento m JOIN logic.ubicacion u ON u.id IN (m.origen_id, m.destino_id)
                              WHERE m.lote_id = l.id AND u.almacen_id = $2) DESC, l.recibido_en DESC LIMIT 1`, [n.producto_id, im.almacen_id]);
        if (!l) throw new ErrorUsuario(`${n.nombre} es perecedero y nunca tuvo un lote: registrá su ingreso (compra, remito o conteo) antes de procesar.`);
        lote = l.id;
      }
      await mover(n.producto_id, lote, f.falta, im.ubicacion_id);
      negativos.push(`${n.nombre} (${limpiar(f.falta)} ${n.unidad_base})`);
    }
    await c.query('UPDATE pos.ticket_item SET consumo_id = $1 WHERE id = ANY($2::uuid[])', [co.id, ids]);
    return { consumo_id: co.id, renglones: items.length, productos: necesidad.length, negativos };
  });
  res.status(201).json({ ok: true, ...out });
}));

// ── Cobros ───────────────────────────────────────────────────────────────────────────────────
// ── El día del punto de venta (unidad financiera) ───────────────────────────────────────────
// Estado deducido (pos.jornada): con pendientes (un medio sin su medio de pago) → diferencia (lo cobrado no
// coincide con lo vendido) → listo para cobrar → cobrado. Los cobros se procesan por día y todo o nada.
function estadoJornada(j) {
  const dif = Number(j.cobrado) - Number(j.vendido);
  const alertas = [];
  if (j.pagos_sin_asignar) alertas.push({ tipo: 'bloquea', texto: `${j.pagos_sin_asignar} pago(s) con un medio del sistema sin su medio de pago asignado.` });
  if (Math.abs(dif) >= 0.01) alertas.push({ tipo: 'diferencia', texto: `Lo cobrado (${$p(j.cobrado)}) no coincide con lo vendido (${$p(j.vendido)}): diferencia ${$p(dif)}.` });
  if (j.abiertas) alertas.push({ tipo: 'aviso', texto: `Al sincronizar había ${j.abiertas} venta(s) abierta(s): volvé a traer el día cuando cierren.` });
  if (j.anuladas) alertas.push({ tipo: 'info', texto: `${j.anuladas} venta(s) anulada(s) en el día (no suman).` });
  const estado = !j.pagos_pendientes && j.pagos_procesados ? 'cobrado'
    : j.pagos_sin_asignar ? 'pendientes' : Math.abs(dif) >= 0.01 ? 'diferencia' : j.pagos_pendientes ? 'listo' : 'sin cobros';
  return { ...j, diferencia: dif.toFixed(2), estado, alertas };
}
const JORNADA_SQL = `SELECT j.integracion_id, to_char(j.dia, 'YYYY-MM-DD') AS dia, j.ventas, j.anuladas, j.vendido::text, j.cobrado::text,
                            j.por_cobrar::text, j.pagos_pendientes, j.pagos_sin_asignar, j.pagos_procesados, COALESCE(j.abiertas, 0) AS abiertas,
                            j.sincronizado_en
                       FROM pos.jornada j`;

r.get('/pos/jornadas', h(async (req, res) => {
  const integ = await integracion(pool, req, texto(req.query.integracion, { campo: 'el punto de venta', requerido: true }));
  const { rows } = await pool.query(`${JORNADA_SQL} WHERE j.integracion_id = $1 ORDER BY j.dia DESC LIMIT 120`, [integ.id]);
  res.json({ ok: true, jornadas: rows.map(estadoJornada) });
}));

r.get('/pos/jornadas/:integracion/:dia', h(async (req, res) => {
  const integ = await integracion(pool, req, req.params.integracion);
  const dia = fecha(req.params.dia, { campo: 'El día', requerido: true });
  const { rows: [j] } = await pool.query(`${JORNADA_SQL} WHERE j.integracion_id = $1 AND j.dia = $2`, [integ.id, dia]);
  if (!j) throw new ErrorUsuario('No hay ventas importadas de ese día.', 404);
  const [medios, cobros, anuladas, imps] = await Promise.all([
    pool.query(
      `SELECT m.id, m.nombre, m.medio_pago_id, mp.tipo_operacion, pr.nombre AS procesador, cu.nombre AS cuenta,
              SUM(p.importe)::text AS importe, SUM(p.importe) FILTER (WHERE p.cobro_id IS NULL)::text AS pendiente, count(*)::int AS pagos
         FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.importacion im ON im.id = t.importacion_id AND im.estado = 'recibida'
         JOIN pos.medio m ON m.id = p.medio_id
         LEFT JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id LEFT JOIN fin.procesador pr ON pr.id = mp.procesador_id
         LEFT JOIN fin.cuenta cu ON cu.id = m.cuenta_id
        WHERE t.integracion_id = $1 AND t.dia = $2 AND t.estado = 'cerrado' AND NOT p.anulado
        GROUP BY m.id, mp.tipo_operacion, pr.nombre, cu.nombre ORDER BY SUM(p.importe) DESC`, [integ.id, dia]),
    pool.query(`SELECT id, pagos, estado, diferencia::text, motivo_diferencia, creado_por, creado_en FROM pos.cobro
                 WHERE integracion_id = $1 AND dia = $2 ORDER BY creado_en`, [integ.id, dia]),
    pool.query(`SELECT t.id_externo, t.total::text FROM pos.ticket t JOIN pos.importacion im ON im.id = t.importacion_id AND im.estado = 'recibida'
                 WHERE t.integracion_id = $1 AND t.dia = $2 AND t.estado = 'anulado' ORDER BY t.abierto_en, t.cerrado_en`, [integ.id, dia]),
    pool.query(`SELECT DISTINCT im.id, im.creado_en, im.origen FROM pos.importacion im JOIN pos.ticket t ON t.importacion_id = im.id
                 WHERE t.integracion_id = $1 AND t.dia = $2 AND im.estado = 'recibida' ORDER BY im.creado_en`, [integ.id, dia]),
  ]);
  res.json({ ok: true, jornada: { ...estadoJornada(j), punto_venta: integ.nombre, sede_id: integ.sede_id, medios: medios.rows,
    cobros: cobros.rows, anuladas: anuladas.rows, importaciones: imps.rows, puede: { cobros: puede(req.usuario, 'finanzas') } } });
}));

// Procesa los cobros pendientes de un día, todo o nada: con un medio sin asignar no se procesa; con lo cobrado
// distinto de lo vendido, sólo con un motivo (que queda en el cobro con la diferencia). Lo de cada medio entra,
// por día, a su cuenta: efectivo a la del punto de venta (a rendir), cada procesador a la suya (a acreditar).
async function procesarJornada(c, integ, dia, motivo) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['jornada:' + integ.id + ':' + dia]);
  const { rows: [jr] } = await c.query(`${JORNADA_SQL} WHERE j.integracion_id = $1 AND j.dia = $2`, [integ.id, dia]);
  if (!jr) throw new ErrorUsuario('No hay ventas importadas de ese día.');
  const j = estadoJornada(jr);
  if (j.pagos_sin_asignar) {
    const { rows } = await c.query(
      `SELECT DISTINCT m.nombre FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
        WHERE t.integracion_id = $1 AND t.dia = $2 AND NOT p.anulado AND p.cobro_id IS NULL AND m.cuenta_id IS NULL`, [integ.id, dia]);
    throw new ErrorUsuario(`No se procesan los cobros del ${dia} hasta asignar el medio de pago de: ${rows.map(x => x.nombre).join(', ')} (en la ficha de la sede).`);
  }
  if (!j.pagos_pendientes) throw new ErrorUsuario(`Los cobros del ${dia} ya están procesados.`);
  if (j.estado === 'diferencia' && !motivo)
    throw new ErrorUsuario(`Lo cobrado (${$p(j.cobrado)}) no coincide con lo vendido (${$p(j.vendido)}): diferencia ${$p(j.diferencia)}. Para procesar igual, indicá el motivo.`, 409);
  const { rows: pagos } = await c.query(
    `SELECT p.id FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.importacion im ON im.id = t.importacion_id AND im.estado = 'recibida'
      WHERE t.integracion_id = $1 AND t.dia = $2 AND t.estado = 'cerrado' AND NOT p.anulado AND p.cobro_id IS NULL FOR UPDATE OF p`, [integ.id, dia]);
  const ids = pagos.map(p => p.id);
  const { rows: [co] } = await c.query(
    `INSERT INTO pos.cobro (integracion_id, dia, pagos, diferencia, motivo_diferencia) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [integ.id, dia, ids.length, j.estado === 'diferencia' ? j.diferencia : null, j.estado === 'diferencia' ? motivo : null]);
  const { rows: grupos } = await c.query(
    `SELECT m.cuenta_id, string_agg(DISTINCT m.nombre, ', ') AS medios, SUM(p.importe)::numeric(16,2)::text AS importe
       FROM pos.ticket_pago p JOIN pos.medio m ON m.id = p.medio_id WHERE p.id = ANY($1::uuid[]) GROUP BY m.cuenta_id`, [ids]);
  for (const g of grupos) {
    if (esCero(g.importe)) continue;
    const sale = g.importe.startsWith('-');
    await c.query(
      `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, pos_cobro_id) VALUES ($1,$2,'cobro',$3,$4,$5,$6)`,
      [dia, g.cuenta_id, sale ? 0 : g.importe, sale ? g.importe.slice(1) : 0, `Cobros ${integ.nombre} ${dia} · ${g.medios}`, co.id]);
  }
  await c.query('UPDATE pos.ticket_pago SET cobro_id = $1 WHERE id = ANY($2::uuid[])', [co.id, ids]);
  return { cobro_id: co.id, pagos: ids.length, movimientos: grupos.length, diferencia: j.estado === 'diferencia' ? j.diferencia : null };
}

r.post('/pos/jornadas/:integracion/:dia/cobros', h(async (req, res) => {
  if (!puede(req.usuario, 'finanzas')) throw new ErrorUsuario('Procesar cobros es de finanzas.', 403);
  const dia = fecha(req.params.dia, { campo: 'El día', requerido: true });
  const out = await enTransaccion(async c => procesarJornada(c, await integracion(c, req, req.params.integracion), dia, texto(req.body.motivo)));
  res.status(201).json({ ok: true, ...out });
}));

// Los días sin observaciones se procesan solos (decisión de Fer, 25/10/2026): medios todos asignados, lo cobrado
// igual a lo vendido y ninguna venta abierta al sincronizar. Lo que tiene algo de eso queda para revisar a mano.
// Cada día en su propia transacción: uno que falle no frena a los demás. Sólo con permiso de finanzas (la base lo
// vuelve a exigir para asentar en tesorería); sin él, los días quedan listos para que finanzas los procese.
async function procesarListos(req, integ, desde = null, hasta = null) {
  if (!puede(req.usuario, 'finanzas')) return null;
  const { rows } = await pool.query(
    `${JORNADA_SQL} WHERE j.integracion_id = $1 AND ($2::date IS NULL OR j.dia >= $2) AND ($3::date IS NULL OR j.dia <= $3)
      ORDER BY j.dia`, [integ.id, desde, hasta]);
  const procesados = [], revisar = [];
  for (const j of rows.map(estadoJornada)) {
    if (!j.pagos_pendientes) continue;
    if (j.estado !== 'listo' || j.abiertas) {
      revisar.push({ dia: j.dia, estado: j.estado, motivo: j.alertas.filter(a => a.tipo !== 'info').map(a => a.texto).join(' ') });
      continue;
    }
    try {
      const o = await enTransaccion(c => procesarJornada(c, integ, j.dia, null));
      procesados.push({ dia: j.dia, pagos: o.pagos, importe: j.por_cobrar });
    } catch (e) {
      if (!(e instanceof ErrorUsuario)) throw e;
      revisar.push({ dia: j.dia, estado: j.estado, motivo: e.message });
    }
  }
  return { procesados, revisar };
}

r.post('/pos/jornadas/:integracion/procesar', h(async (req, res) => {
  if (!puede(req.usuario, 'finanzas')) throw new ErrorUsuario('Procesar cobros es de finanzas.', 403);
  const integ = await integracion(pool, req, req.params.integracion);
  res.status(201).json({ ok: true, ...await procesarListos(req, integ) });
}));

// Compatibilidad: procesar los cobros "de una importación" es procesar cada día que trae, con las mismas reglas.
r.post('/pos/importaciones/:id/cobros', h(async (req, res) => {
  if (!puede(req.usuario, 'finanzas')) throw new ErrorUsuario('Procesar cobros es de finanzas.', 403);
  const out = await enTransaccion(async c => {
    const im = await importacion(c, req, req.params.id, true);
    if (im.estado !== 'recibida') throw new ErrorUsuario('La importación está anulada.');
    const integ = await integracion(c, req, im.integracion_id);
    const { rows: dias } = await c.query(
      `SELECT DISTINCT to_char(t.dia, 'YYYY-MM-DD') AS dia FROM pos.ticket t JOIN pos.ticket_pago p ON p.ticket_id = t.id
        WHERE t.importacion_id = $1 AND t.estado = 'cerrado' AND NOT p.anulado AND p.cobro_id IS NULL ORDER BY 1`, [im.id]);
    if (!dias.length) throw new ErrorUsuario('No hay cobros para procesar: ya se procesaron.');
    const hechos = [];
    for (const d of dias) hechos.push(await procesarJornada(c, integ, d.dia, texto(req.body.motivo)));
    return { pagos: hechos.reduce((s, x) => s + x.pagos, 0), movimientos: hechos.reduce((s, x) => s + x.movimientos, 0) };
  });
  res.status(201).json({ ok: true, ...out });
}));

// ── Anular una importación ───────────────────────────────────────────────────────────────────
// Se revierte lo que generó (stock y, si hubo, cobros) y se borran sus tickets, que son datos de
// recepción: así se puede volver a importar bien. Los movimientos quedan con su anulación.
r.post('/pos/importaciones/:id/anular', h(async (req, res) => {
  const motivo = texto(req.body.motivo, { campo: 'el motivo', requerido: true });
  await enTransaccion(async c => {
    const im = await importacion(c, req, req.params.id, true);
    if (!puede(req.usuario, 'finanzas')) exigirEncargadoDe(req, im.sede_id, im.sede);
    if (im.estado === 'anulada') throw new ErrorUsuario('La importación ya está anulada.');
    // Un cobro ya acreditado (conciliado con el extracto del procesador o liquidado en un lote) se deshace primero.
    const { rows: [ac] } = await c.query(
      `SELECT COUNT(*) FILTER (WHERE p.acreditado_linea_id IS NOT NULL)::int AS conciliados, COUNT(*) FILTER (WHERE p.lote_id IS NOT NULL)::int AS en_lote
         FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id WHERE t.importacion_id = $1`, [im.id]);
    if (ac.conciliados || ac.en_lote)
      throw new ErrorUsuario(`La importación tiene cobros acreditados (${ac.conciliados} conciliados con el extracto, ${ac.en_lote} en lotes de liquidación): `
        + 'no se puede anular. Los conciliados se deshacen desde Conciliación.');
    // Los cobros que incluyen pagos de esta importación (por día o de la importación): se revierten enteros, y
    // los pagos de otras importaciones de ese día vuelven a quedar pendientes.
    const { rows: cobros } = await c.query(
      `SELECT DISTINCT co.id FROM pos.cobro co
        WHERE co.estado = 'procesado' AND (co.importacion_id = $1 OR EXISTS (SELECT 1 FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id
                                                                              WHERE p.cobro_id = co.id AND t.importacion_id = $1))`, [im.id]);
    const idsCobro = cobros.map(x => x.id);
    if (cobros.length && !puede(req.usuario, 'finanzas'))
      throw new ErrorUsuario('La importación tiene cobros procesados: la anula alguien de finanzas.', 403);
    await c.query(
      `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, origen_id, destino_id, motivo, referencia, anula_a, pos_consumo_id)
       SELECT m.tipo, m.producto_id, m.lote_id, m.cantidad_base, m.destino_id, m.origen_id, 'Anula #' || m.id || ': ' || $2, m.referencia, m.id, m.pos_consumo_id
         FROM logic.movimiento m JOIN pos.consumo co ON co.id = m.pos_consumo_id
        WHERE co.importacion_id = $1 AND co.estado = 'procesado' AND m.anula_a IS NULL`, [im.id, motivo]);
    await c.query(
      `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, anula_a, pos_cobro_id)
       SELECT current_date, m.cuenta_id, 'anulacion', m.salida, m.entrada, 'Anula: ' || m.concepto || ' — ' || $2, m.id, m.pos_cobro_id
         FROM fin.movimiento_tes m WHERE m.pos_cobro_id = ANY($1::uuid[]) AND m.anula_a IS NULL`, [idsCobro, motivo]);
    await c.query(`UPDATE pos.consumo SET estado = 'anulado' WHERE importacion_id = $1`, [im.id]);
    await c.query(`UPDATE pos.cobro SET estado = 'anulado' WHERE id = ANY($1::uuid[])`, [idsCobro]);
    await c.query('UPDATE pos.ticket_pago SET cobro_id = NULL WHERE cobro_id = ANY($1::uuid[])', [idsCobro]);
    await c.query('DELETE FROM pos.ticket WHERE importacion_id = $1', [im.id]);
    await c.query(`UPDATE pos.importacion SET estado = 'anulada', anulado_en = now(), anulado_por = org.usuario_actual(), motivo_anulacion = $2
                    WHERE id = $1`, [im.id, motivo]);
  });
  res.json({ ok: true });
}));

// ── Equivalencias ────────────────────────────────────────────────────────────────────────────
r.get('/pos/integraciones/:id/articulos', h(async (req, res) => {
  const integ = await integracion(pool, req, req.params.id);
  const { rows } = await pool.query(
    `SELECT a.id, a.codigo_externo, a.nombre, a.plato_id, pl.nombre AS plato, a.sin_consumo,
            trim_scale(p.cantidad)::text AS pendiente, p.tickets
       FROM pos.articulo a LEFT JOIN logic.plato pl ON pl.id = a.plato_id
       LEFT JOIN pos.articulo_pendiente p ON p.articulo_id = a.id
      WHERE a.integracion_id = $1
      ORDER BY (a.plato_id IS NULL AND NOT a.sin_consumo) DESC, p.cantidad DESC NULLS LAST, a.nombre`, [integ.id]);
  res.json({ ok: true, articulos: rows });
}));

r.put('/pos/articulos/:id', h(async (req, res) => {
  const { rows: [a] } = await pool.query(
    `SELECT a.id, i.sede_id, s.nombre AS sede FROM pos.articulo a JOIN pos.integracion i ON i.id = a.integracion_id
       JOIN org.sede s ON s.id = i.sede_id WHERE a.id = $1::uuid`, [req.params.id]);
  if (!a) throw new ErrorUsuario('No existe ese artículo.', 404);
  if (!puede(req.usuario, 'catalogo')) exigirEncargadoDe(req, a.sede_id, a.sede);
  const sinConsumo = !!req.body.sin_consumo;
  await pool.query('UPDATE pos.articulo SET plato_id = $1, sin_consumo = $2 WHERE id = $3',
    [sinConsumo ? null : texto(req.body.plato_id), sinConsumo, a.id]);
  res.json({ ok: true });
}));

// Los medios con que el sistema nombra los pagos ("TARJETA DEBITO", "MP QR"), con el medio de pago global
// asignado y la cuenta que sale de él.
r.get('/pos/integraciones/:id/medios', h(async (req, res) => {
  const integ = await integracion(pool, req, req.params.id);
  const { rows } = await pool.query(
    `SELECT m.id, m.codigo_externo, m.nombre, m.medio_pago_id, m.cuenta_id, cu.nombre AS cuenta
       FROM pos.medio m LEFT JOIN fin.cuenta cu ON cu.id = m.cuenta_id
      WHERE m.integracion_id = $1 ORDER BY m.medio_pago_id IS NULL DESC, m.nombre`, [integ.id]);
  res.json({ ok: true, medios: rows });
}));

// El catálogo global de medios de pago, para asignarlos (procesador + tipo de operación, y el efectivo).
r.get('/pos/medios-pago', h(async (req, res) => {
  const { rows } = await pool.query(`${MEDIOS_SQL} WHERE mp.activo AND (pr.id IS NULL OR pr.activo)
                                      ORDER BY pr.nombre NULLS FIRST, mp.tipo_operacion`);
  res.json({ ok: true, medios: rows });
}));

// Asignar a un medio del sistema su medio de pago global: la cuenta sale de ahí (la del procesador, o la de
// efectivo del punto de venta). Se acepta todavía una cuenta directa, sin medio global, por compatibilidad.
r.put('/pos/medios/:id', h(async (req, res) => {
  const medioPago = texto(req.body.medio_pago_id);
  if (medioPago) {
    const { rows: [mp] } = await pool.query('SELECT 1 FROM fin.medio_pago WHERE id = $1::uuid AND activo', [medioPago]);
    if (!mp) throw new ErrorUsuario('Ese medio de pago no existe o está inactivo.');
    const { rowCount } = await pool.query('UPDATE pos.medio SET medio_pago_id = $1 WHERE id = $2::uuid', [medioPago, req.params.id]);
    if (!rowCount) throw new ErrorUsuario('No existe ese medio.', 404);
    return res.json({ ok: true });
  }
  const cuenta = texto(req.body.cuenta_id);
  if (cuenta) {
    const { rows: [cu] } = await pool.query('SELECT tipo FROM fin.cuenta WHERE id = $1::uuid AND activa', [cuenta]);
    if (!cu || cu.tipo === 'cartera') throw new ErrorUsuario('Elegí una caja, un banco o una cuenta de cobranza activa.');
  }
  const { rowCount } = await pool.query('UPDATE pos.medio SET medio_pago_id = NULL, cuenta_id = $1 WHERE id = $2::uuid', [cuenta, req.params.id]);
  if (!rowCount) throw new ErrorUsuario('No existe ese medio.', 404);
  res.json({ ok: true });
}));

// ── Cierre diario (decisiones de Fer, 26/10/2026) ────────────────────────────────────────────
// El estado de cada punto de venta en los últimos días, desde la central: si las ventas llegaron (la corrida
// automática o el archivo), si los cobros se procesaron, si el efectivo se rindió y si lo electrónico se acreditó.
// Lo que hay que hacer va arriba ("para resolver"), con su acción; el resto es el detalle por día. Sólo finanzas.
const ATRASO_DIAS = 3;   // lo electrónico sin acreditar a los 3 días (o un lote liquidado sin aparecer en el banco) es alerta
r.get('/pos/cierre', h(async (req, res) => {
  if (!puede(req.usuario, 'finanzas')) throw new ErrorUsuario('El cierre diario es de finanzas.', 403);
  const n = Math.min(60, Math.max(7, Number(req.query.dias) || 14));
  const { rows: integs } = await pool.query(
    `SELECT i.id, i.nombre, s.nombre AS sede, i.sistema, i.modo, i.sincroniza_auto, i.credenciales IS NOT NULL AS tiene_credenciales,
            i.cuenta_efectivo_id, ce.nombre AS cuenta_efectivo, COALESCE(sce.saldo, 0)::text AS efectivo_a_rendir,
            (SELECT row_to_json(c) FROM (SELECT c.fecha, c.automatica, c.ok, c.error, c.resultado, c.iniciada_en, c.terminada_en,
                                                to_char(c.desde, 'YYYY-MM-DD') AS desde, to_char(c.hasta, 'YYYY-MM-DD') AS hasta
                                           FROM pos.corrida c WHERE c.integracion_id = i.id ORDER BY c.iniciada_en DESC LIMIT 1) c) AS ultima_corrida,
            extract(hour FROM now())::int >= 5 AS paso_la_hora
       FROM pos.integracion i JOIN org.sede s ON s.id = i.sede_id
       LEFT JOIN fin.cuenta ce ON ce.id = i.cuenta_efectivo_id LEFT JOIN fin.saldo_cuenta sce ON sce.cuenta_id = ce.id
      WHERE i.activa AND s.activa AND ($1::uuid[] IS NULL OR i.sede_id = ANY($1)) ORDER BY s.nombre`, [sedesPos(req)]);
  const out = [];
  for (const i of integs) {
    const [{ rows: dias }, { rows: atrasos }, { rows: lotesSinBanco }] = await Promise.all([
      pool.query(
        `WITH d AS (SELECT generate_series(current_date - $2::int, current_date - 1, '1 day')::date AS dia),
         pg AS (
           SELECT t.dia, SUM(p.importe) FILTER (WHERE m.cuenta_id = $3) AS efectivo,
                  SUM(p.importe) FILTER (WHERE m.cuenta_id IS DISTINCT FROM $3) AS electronico,
                  SUM(p.importe) FILTER (WHERE m.cuenta_id IS DISTINCT FROM $3 AND (p.acreditado_linea_id IS NOT NULL OR (p.lote_id IS NOT NULL
                       AND EXISTS (SELECT 1 FROM fin.lote l JOIN fin.conciliacion k ON k.movimiento_id = l.movimiento_id WHERE l.id = p.lote_id)))) AS acreditado,
                  SUM(p.importe) FILTER (WHERE m.cuenta_id IS DISTINCT FROM $3 AND p.lote_id IS NOT NULL AND NOT EXISTS (
                       SELECT 1 FROM fin.lote l JOIN fin.conciliacion k ON k.movimiento_id = l.movimiento_id WHERE l.id = p.lote_id)) AS liquidado
             FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
             JOIN pos.importacion im ON im.id = t.importacion_id AND im.estado = 'recibida'
            WHERE t.integracion_id = $1 AND t.estado = 'cerrado' AND NOT p.anulado AND t.dia >= current_date - $2::int
            GROUP BY t.dia)
         SELECT to_char(d.dia, 'YYYY-MM-DD') AS dia, j.ventas, j.anuladas, j.vendido::text, j.cobrado::text, j.por_cobrar::text, j.pagos_pendientes,
                j.pagos_sin_asignar, j.pagos_procesados, COALESCE(sd.abiertas, j.abiertas, 0) AS abiertas, sd.dia IS NOT NULL AS sincronizado,
                COALESCE(pg.efectivo, 0)::text AS efectivo, COALESCE(pg.electronico, 0)::text AS electronico,
                COALESCE(pg.acreditado, 0)::text AS acreditado, COALESCE(pg.liquidado, 0)::text AS liquidado
           FROM d LEFT JOIN pos.jornada j ON j.integracion_id = $1 AND j.dia = d.dia
           LEFT JOIN pos.sincronizacion_dia sd ON sd.integracion_id = $1 AND sd.dia = d.dia
           LEFT JOIN pg ON pg.dia = d.dia
          ORDER BY d.dia DESC`, [i.id, n, i.cuenta_efectivo_id]),
      // Lo electrónico ya procesado que no llegó: por procesador, lo más viejo primero.
      pool.query(
        `SELECT pr.nombre AS procesador, pr.cuenta_acredita_id, COUNT(*)::int AS pagos, SUM(p.importe)::text AS importe,
                to_char(MIN(t.dia), 'YYYY-MM-DD') AS desde, (current_date - MIN(COALESCE(p.liquida_el, t.dia)))::int AS dias
           FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
           JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id JOIN fin.procesador pr ON pr.id = mp.procesador_id
          WHERE t.integracion_id = $1 AND t.estado = 'cerrado' AND NOT p.anulado AND p.cobro_id IS NOT NULL
            AND p.acreditado_linea_id IS NULL AND p.lote_id IS NULL AND current_date - COALESCE(p.liquida_el, t.dia) > $2
          GROUP BY pr.nombre, pr.cuenta_acredita_id ORDER BY MIN(t.dia)`, [i.id, ATRASO_DIAS]),
      pool.query(
        `SELECT DISTINCT pr.nombre AS procesador, pr.cuenta_acredita_id, to_char(l.fecha, 'YYYY-MM-DD') AS fecha, l.neto::text, (current_date - l.fecha)::int AS dias
           FROM fin.lote l JOIN fin.procesador pr ON pr.id = l.procesador_id JOIN pos.ticket_pago p ON p.lote_id = l.id JOIN pos.ticket t ON t.id = p.ticket_id
          WHERE t.integracion_id = $1 AND current_date - l.fecha > $2
            AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.movimiento_id = l.movimiento_id) ORDER BY 3`, [i.id, ATRASO_DIAS]),
    ]);
    // Efectivo a rendir por día: lo rendido cubre primero lo más viejo, así que lo que queda en la cuenta son los
    // días más recientes, hasta sumar el saldo.
    let falta = centavos(i.efectivo_a_rendir);
    for (const d of dias) {
      const e = centavos(d.efectivo);
      d.efectivo_pendiente = deCentavos(falta <= 0n || e === 0n ? 0n : falta >= e ? e : falta);
      falta -= e;
    }
    const pendEf = dias.filter(d => centavos(d.efectivo_pendiente) > 0n);
    // Para resolver: lo que pide una acción, cada cosa con lo que hace falta para resolverla.
    const tareas = [];
    const ult = i.ultima_corrida;
    if (i.modo === 'api' && i.sincroniza_auto) {
      if (ult && ult.ok === false) tareas.push({ tipo: 'corrida', nivel: 'mal', texto: `La última sincronización falló: ${ult.error}` });
      else if (i.paso_la_hora && !(ult && ult.automatica && ult.fecha === hoyIso())) tareas.push({ tipo: 'corrida', nivel: 'aviso', texto: 'La sincronización automática de hoy todavía no corrió.' });
    }
    // Por archivo: los días sin ventas desde la primera importada del período (antes, el punto de venta no existía o
    // no se usaba el sistema).
    const primero = dias.filter(d => d.ventas).map(d => d.dia).sort()[0];
    const sinVentas = dias.filter(d => !d.ventas && !d.sincronizado && primero && d.dia > primero);
    if (sinVentas.length && i.modo === 'archivo')
      tareas.push({ tipo: 'importar', nivel: 'aviso', dias: sinVentas.map(d => d.dia), texto: `Faltan importar las ventas de ${sinVentas.length} día(s).` });
    else if (!primero && i.modo === 'archivo')
      tareas.push({ tipo: 'importar', nivel: 'aviso', texto: `Todavía no hay ventas importadas de los últimos ${n} días.` });
    // Los días con el mismo problema van juntos, en un renglón: se resuelven igual (desde Procesar ventas).
    const porDia = (nivel, clase, filtro, texto) => {
      const ds = dias.filter(filtro);
      if (ds.length) tareas.push({ tipo: 'dia', clase, nivel, dias: ds.map(d => d.dia), texto: texto(ds) });
    };
    const cuadra = d => Math.abs(Number(d.cobrado) - Number(d.vendido)) < 0.01;
    const enDias = ds => ds.length === 1 ? '' : ` en ${ds.length} días`;
    porDia('mal', 'medios', d => d.ventas && d.pagos_sin_asignar, ds => `Hay cobros con un medio sin asignar${enDias(ds)}.`);
    porDia('mal', 'diferencia', d => d.ventas && !d.pagos_sin_asignar && d.pagos_pendientes && !cuadra(d), ds => `Lo cobrado no coincide con lo vendido${enDias(ds)}.`);
    porDia('aviso', 'abiertas', d => d.abiertas, ds => `${ds.reduce((a, d) => a + d.abiertas, 0)} venta(s) seguían abiertas: falta volver a traer ${ds.length === 1 ? 'el día' : 'esos días'}.`);
    porDia('aviso', 'listos', d => d.ventas && !d.pagos_sin_asignar && d.pagos_pendientes && cuadra(d) && !d.abiertas, ds => `Cobros listos para procesar${enDias(ds)}.`);
    if (centavos(i.efectivo_a_rendir) > 0n) tareas.push({ tipo: 'efectivo', nivel: pendEf.length > 2 ? 'mal' : 'aviso', importe: i.efectivo_a_rendir,
      desde: pendEf.length ? pendEf.at(-1).dia : null,
      texto: pendEf.length ? `Efectivo a rendir de ${pendEf.length} día(s).` : 'Efectivo a rendir de antes del período.' });
    for (const a of atrasos) tareas.push({ tipo: 'acreditacion', nivel: 'mal', cuenta_id: a.cuenta_acredita_id, importe: a.importe,
      texto: `${a.procesador}: ${a.pagos} cobro(s) sin acreditar desde el ${a.desde}.` });
    for (const l of lotesSinBanco) tareas.push({ tipo: 'acreditacion', nivel: 'mal', cuenta_id: l.cuenta_acredita_id, importe: l.neto,
      texto: `${l.procesador}: el lote del ${l.fecha} no apareció en el banco (hace ${l.dias} días).` });
    const { efectivo_a_rendir, ultima_corrida, paso_la_hora, ...resto } = i;
    out.push({ ...resto, efectivo_a_rendir, ultima_corrida, tareas, dias });
  }
  res.json({ ok: true, puntos: out });
}));
const hoyIso = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

// No se rinde (ni falta) más de lo que el punto de venta tiene a rendir: la cuenta quedaría en negativo. Con la cuenta
// bloqueada, para que dos rendiciones a la vez no pasen las dos.
async function alcanzaEfectivo(c, integ, imp, que) {
  await c.query('SELECT 1 FROM fin.cuenta WHERE id = $1 FOR UPDATE', [integ.cuenta_efectivo_id]);
  const { rows: [s] } = await c.query('SELECT COALESCE((SELECT saldo FROM fin.saldo_cuenta WHERE cuenta_id = $1), 0)::text AS saldo', [integ.cuenta_efectivo_id]);
  if (centavos(imp) > centavos(s.saldo))
    throw new ErrorUsuario(`${integ.nombre} tiene ${$p(s.saldo)} a rendir: no se puede ${que === 'rendir' ? 'rendir' : 'declarar un faltante por'} ${$p(imp)}.`);
}

// Rendir efectivo: lo que llegó a la central (caja o banco) sale de la cuenta a rendir del punto de venta. Se hace
// a mano, cuando la plata efectivamente ingresa (decisión de Fer). Montos en pesos enteros.
r.post('/pos/efectivo/:integracion/rendir', h(async (req, res) => {
  if (!puede(req.usuario, 'finanzas')) throw new ErrorUsuario('Rendir efectivo es de finanzas.', 403);
  const integ = await integracion(pool, req, req.params.integracion);
  if (!integ.cuenta_efectivo_id) throw new ErrorUsuario('El punto de venta no tiene cuenta de efectivo.');
  const destino = texto(req.body.destino_id, { campo: 'la cuenta donde entra', requerido: true });
  const imp = monto(req.body.importe, { campo: 'El importe', requerido: true, positivo: true });
  const dia = fecha(req.body.fecha, { campo: 'La fecha' });
  const { rows: [cu] } = await pool.query('SELECT tipo, activa FROM fin.cuenta WHERE id = $1::uuid', [destino]);
  if (!cu || !cu.activa || !['caja', 'banco'].includes(cu.tipo) || destino === integ.cuenta_efectivo_id) throw new ErrorUsuario('Elegí la caja o el banco donde entra el efectivo.');
  await enTransaccion(async c => {
    await alcanzaEfectivo(c, integ, imp, 'rendir');
    await c.query('SELECT fin.transferir($1::uuid, $2::uuid, $3::numeric, COALESCE($4::date, current_date), $5)',
      [integ.cuenta_efectivo_id, destino, imp, dia, `Rendición de efectivo · ${integ.nombre}` + (texto(req.body.concepto) ? ` · ${texto(req.body.concepto)}` : '')]);
  });
  res.status(201).json({ ok: true });
}));

// Diferencia de caja: lo que falta (o sobra) del efectivo del punto de venta, con su motivo. Deja la cuenta a rendir
// en lo que de verdad hay que rendir.
r.post('/pos/efectivo/:integracion/diferencia', h(async (req, res) => {
  if (!puede(req.usuario, 'finanzas')) throw new ErrorUsuario('La diferencia de caja es de finanzas.', 403);
  const integ = await integracion(pool, req, req.params.integracion);
  const motivo = texto(req.body.motivo, { campo: 'el motivo', requerido: true });
  const faltante = req.body.tipo !== 'sobrante';
  const imp = monto(req.body.importe, { campo: 'El importe', requerido: true, positivo: true });
  if (!integ.cuenta_efectivo_id) throw new ErrorUsuario('El punto de venta no tiene cuenta de efectivo.');
  await enTransaccion(async c => {
    if (faltante) await alcanzaEfectivo(c, integ, imp, 'faltante');
    await c.query(
      `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, gasto)
       VALUES (COALESCE($1::date, current_date), $2, $3, $4, $5, $6, 'otro')`,
      [fecha(req.body.fecha, { campo: 'La fecha' }), integ.cuenta_efectivo_id, faltante ? 'egreso' : 'ingreso', faltante ? 0 : imp, faltante ? imp : 0,
       `${faltante ? 'Faltante' : 'Sobrante'} de caja · ${integ.nombre}: ${motivo}`]);
  });
  res.status(201).json({ ok: true });
}));

Object.assign(r, { correrAutomaticas });
module.exports = r;
