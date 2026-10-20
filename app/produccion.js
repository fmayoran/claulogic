// API de recetas y producción. Producir consume los ingredientes POR LOTE (FEFO: primero lo que
// vence primero) y da de alta el elaborado con su propio lote y su costo. Que el consumo quede por
// lote es lo que permite contestar "este elaborado, ¿con qué partidas se hizo?".
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, texto, fecha, h, enTransaccion, aBase, crearLote } = require('./util');

const r = express.Router();

// ── Recetas ──────────────────────────────────────────────────────────────────────────────────
r.get('/recetas', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT re.id, re.nombre, re.vigente, re.producto_id, p.nombre AS elaborado, p.unidad_base,
            trim_scale(re.rinde_base)::text AS rinde, COUNT(ri.id)::int AS ingredientes
       FROM logic.receta re
       JOIN logic.producto p ON p.id = re.producto_id
       LEFT JOIN logic.receta_item ri ON ri.receta_id = re.id
      WHERE ($1 OR re.vigente)
      GROUP BY re.id, p.nombre, p.unidad_base ORDER BY re.vigente DESC, re.nombre`,
    [req.query.todas === '1']);
  res.json({ ok: true, recetas: rows });
}));

r.get('/recetas/:id', h(async (req, res) => {
  const { rows: [re] } = await pool.query(
    `SELECT re.id, re.nombre, re.producto_id, p.unidad_base, trim_scale(re.rinde_base)::text AS rinde,
            re.instrucciones, re.vigente
       FROM logic.receta re JOIN logic.producto p ON p.id = re.producto_id WHERE re.id = $1`, [req.params.id]);
  if (!re) return res.status(404).json({ ok: false, error: 'No existe esa receta.' });
  const { rows: items } = await pool.query(
    `SELECT ri.id, ri.producto_id, p.nombre AS producto, p.unidad_base,
            trim_scale(ri.cantidad_base)::text AS cantidad, trim_scale(ri.merma_pct)::text AS merma_pct
       FROM logic.receta_item ri JOIN logic.producto p ON p.id = ri.producto_id
      WHERE ri.receta_id = $1 ORDER BY p.nombre`, [re.id]);
  res.json({ ok: true, receta: { ...re, items } });
}));

function leerReceta(b) {
  const re = {
    nombre: texto(b.nombre, { campo: 'el nombre de la receta', requerido: true }),
    producto_id: texto(b.producto_id, { campo: 'el producto que elabora', requerido: true }),
    rinde: numero(b.rinde, { campo: 'El rinde', requerido: true, positivo: true }),
    rinde_unidad: texto(b.rinde_unidad),
    instrucciones: texto(b.instrucciones),
    vigente: b.vigente === undefined ? true : !!b.vigente,
  };
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new ErrorUsuario('La receta no tiene ingredientes.');
  re.items = items.map((x, i) => {
    const it = {
      producto_id: texto(x.producto_id, { campo: `el ingrediente ${i + 1}`, requerido: true }),
      cantidad: numero(x.cantidad, { campo: `Cantidad del ingrediente ${i + 1}`, requerido: true, positivo: true }),
      unidad: texto(x.unidad),
      merma_pct: numero(x.merma_pct, { campo: `Merma del ingrediente ${i + 1}` }) || '0',
    };
    if (Number(it.merma_pct) >= 100) throw new ErrorUsuario(`La merma del ingrediente ${i + 1} tiene que ser menor a 100%.`);
    if (it.producto_id === re.producto_id) throw new ErrorUsuario('Una receta no puede usar como ingrediente lo que elabora.');
    return it;
  });
  return re;
}

async function unidadBase(c, productoId, nombre) {
  const { rows: [p] } = await c.query('SELECT unidad_base FROM logic.producto WHERE id = $1', [productoId]);
  if (!p) throw new ErrorUsuario(`No existe ${nombre}.`);
  return p.unidad_base;
}

async function guardarReceta(c, id, re) {
  const rinde = await aBase(c, re.rinde, re.rinde_unidad, await unidadBase(c, re.producto_id, 'el elaborado'), 'El rinde');
  if (id) {
    const { rowCount } = await c.query(
      'UPDATE logic.receta SET nombre=$1, producto_id=$2, rinde_base=$3, instrucciones=$4, vigente=$5 WHERE id=$6',
      [re.nombre, re.producto_id, rinde, re.instrucciones, re.vigente, id]);
    if (!rowCount) throw new ErrorUsuario('No existe esa receta.');
    await c.query('DELETE FROM logic.receta_item WHERE receta_id = $1', [id]);
  } else {
    ({ rows: [{ id }] } = await c.query(
      'INSERT INTO logic.receta (nombre, producto_id, rinde_base, instrucciones, vigente) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [re.nombre, re.producto_id, rinde, re.instrucciones, re.vigente]));
  }
  for (const [i, x] of re.items.entries()) {
    const ub = await unidadBase(c, x.producto_id, `el ingrediente ${i + 1}`);
    const cant = await aBase(c, x.cantidad, x.unidad, ub, `El ingrediente ${i + 1}`);
    await c.query('INSERT INTO logic.receta_item (receta_id, producto_id, cantidad_base, merma_pct) VALUES ($1,$2,$3,$4)',
      [id, x.producto_id, cant, x.merma_pct]);
  }
  return id;
}

r.post('/recetas', h(async (req, res) => {
  const re = leerReceta(req.body);
  const id = await enTransaccion(c => guardarReceta(c, null, re));
  res.status(201).json({ ok: true, id });
}));

r.put('/recetas/:id', h(async (req, res) => {
  const re = leerReceta(req.body);
  await enTransaccion(c => guardarReceta(c, req.params.id, re));
  res.json({ ok: true, id: req.params.id });
}));

// ── Plan de producción (FEFO) ────────────────────────────────────────────────────────────────
// Para producir `cantidad` (en unidad base del elaborado) con la receta, desde los lotes del
// almacén: cuánto hace falta de cada ingrediente y de qué lote y ubicación sale.
//
// La merma se suma sobre lo que pide la receta: si la receta usa 1 kg de papa limpia y la merma
// es 23%, hay que sacar 1 / (1 - 0,23) = 1,3 kg del stock.
//
// La asignación se hace en SQL con suma acumulada, en NUMERIC: restar cantidades en JavaScript
// sería volver al float que la base evita. No se proponen lotes vencidos.
async function plan(c, recetaId, cantidad, almacenId) {
  const { rows: [re] } = await c.query(
    `SELECT re.id, re.nombre, re.producto_id, re.rinde_base, p.nombre AS elaborado, p.unidad_base
       FROM logic.receta re JOIN logic.producto p ON p.id = re.producto_id WHERE re.id = $1`, [recetaId]);
  if (!re) throw new ErrorUsuario('No existe esa receta.');
  const { rows: ingredientes } = await c.query(
    `SELECT ri.producto_id, p.nombre AS producto, p.unidad_base, p.perecedero, p.costo_base,
            (ri.cantidad_base * $2::numeric / re.rinde_base / (1 - ri.merma_pct / 100))::numeric(16,4) AS necesario
       FROM logic.receta_item ri
       JOIN logic.receta re ON re.id = ri.receta_id
       JOIN logic.producto p ON p.id = ri.producto_id
      WHERE ri.receta_id = $1 ORDER BY p.nombre`, [recetaId, cantidad]);
  for (const ing of ingredientes) {
    const { rows: lotes } = await c.query(
      `WITH d AS (
         SELECT ld.*, SUM(ld.cantidad) OVER (ORDER BY ld.vencimiento NULLS LAST, ld.lote, ld.ubicacion_id
                                             ROWS UNBOUNDED PRECEDING) AS acum
           FROM logic.lote_disponible ld
          WHERE ld.producto_id = $1 AND ld.almacen_id = $2
            AND (ld.vencimiento IS NULL OR ld.vencimiento >= current_date))
       SELECT lote_id, lote, vencimiento, ubicacion_id, ubicacion, costo_lote,
              trim_scale(cantidad)::text AS disponible,
              LEAST(cantidad, $3::numeric - (acum - cantidad))::numeric(16,4) AS tomar
         FROM d WHERE acum - cantidad < $3::numeric
        ORDER BY acum`,
      [ing.producto_id, almacenId, ing.necesario]);
    const { rows: [t] } = await c.query(
      `SELECT GREATEST($1::numeric - COALESCE(SUM(x), 0), 0)::numeric(16,4) AS faltante,
              -- Costo del consumo: el del lote; si el lote no tiene, el vigente del producto.
              SUM(x * COALESCE(cl, $2::numeric)) AS costo, bool_or(COALESCE(cl, $2::numeric) IS NULL) AS sin_costo
         FROM unnest($3::numeric[], $4::numeric[]) AS u(x, cl)`,
      [ing.necesario, ing.costo_base, lotes.map(l => l.tomar), lotes.map(l => l.costo_lote)]);
    Object.assign(ing, {
      lotes, faltante: t.faltante, costo: t.costo,
      sin_costo: t.sin_costo || ing.costo_base === null && !lotes.length,
    });
  }
  return { receta: re, ingredientes };
}

// Lo que se manda al navegador: números como texto sin ceros de más.
const limpiar = v => v === null || v === undefined ? null : String(v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

function vistaPlan(p) {
  return {
    receta: { id: p.receta.id, nombre: p.receta.nombre, elaborado: p.receta.elaborado, unidad_base: p.receta.unidad_base },
    ingredientes: p.ingredientes.map(i => ({
      producto_id: i.producto_id, producto: i.producto, unidad_base: i.unidad_base,
      necesario: limpiar(i.necesario), faltante: limpiar(i.faltante),
      lotes: i.lotes.map(l => ({ lote: l.lote, vencimiento: l.vencimiento, ubicacion: l.ubicacion,
                                 disponible: l.disponible, tomar: limpiar(l.tomar) })),
    })),
    faltantes: p.ingredientes.some(i => Number(i.faltante) > 0),
  };
}

async function leerPedido(c, q) {
  const recetaId = texto(q.receta_id, { campo: 'la receta', requerido: true });
  const almacenId = texto(q.almacen_id, { campo: 'el almacén de donde salen los ingredientes', requerido: true });
  const cantidad = numero(q.cantidad, { campo: 'La cantidad a producir', requerido: true, positivo: true });
  const { rows: [re] } = await c.query(
    'SELECT p.unidad_base FROM logic.receta re JOIN logic.producto p ON p.id = re.producto_id WHERE re.id = $1', [recetaId]);
  if (!re) throw new ErrorUsuario('No existe esa receta.');
  return { recetaId, almacenId, cantidad: await aBase(c, cantidad, texto(q.unidad), re.unidad_base, 'La cantidad a producir') };
}

r.get('/produccion/plan', h(async (req, res) => {
  const ped = await leerPedido(pool, req.query);
  res.json({ ok: true, plan: vistaPlan(await plan(pool, ped.recetaId, ped.cantidad, ped.almacenId)) });
}));

// ── Producir ─────────────────────────────────────────────────────────────────────────────────
// El plan se vuelve a calcular adentro de la transacción, con los ingredientes bloqueados: el que
// se mostró en pantalla puede haber quedado viejo. Si falta algo, no se produce: un consumo sin
// lote de dónde salir rompería la trazabilidad.
r.post('/producciones', h(async (req, res) => {
  const b = req.body;
  const destino = texto(b.ubicacion_id, { campo: 'la ubicación donde se guarda lo elaborado', requerido: true });
  const out = await enTransaccion(async c => {
    const ped = await leerPedido(c, b);
    // Locks en orden fijo: dos producciones que comparten ingredientes no se bloquean en cruz.
    await c.query(
      `SELECT logic.bloquear_stock(producto_id) FROM
         (SELECT DISTINCT producto_id FROM logic.receta_item WHERE receta_id = $1 ORDER BY producto_id) t`,
      [ped.recetaId]);
    const p = await plan(c, ped.recetaId, ped.cantidad, ped.almacenId);
    const faltan = p.ingredientes.filter(i => Number(i.faltante) > 0);
    if (faltan.length)
      throw new ErrorUsuario('No alcanza el stock de: ' +
        faltan.map(i => `${i.producto} (faltan ${limpiar(i.faltante)} ${i.unidad_base})`).join(', ') + '.');

    const { rows: [{ costo_total, sin_costo }] } = await c.query(
      `SELECT round(SUM(x), 2) AS costo_total, bool_or(x IS NULL) AS sin_costo FROM unnest($1::numeric[]) x`,
      [p.ingredientes.map(i => i.costo)]);
    const costoTotal = sin_costo || p.ingredientes.some(i => i.sin_costo) ? null : costo_total;

    const { rows: [prod] } = await c.query(
      `INSERT INTO logic.produccion (receta_id, cantidad_base, ubicacion_id, almacen_id, costo_total, notas)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ped.recetaId, ped.cantidad, destino, ped.almacenId, costoTotal, texto(b.notas)]);

    const { rows: [el] } = await c.query('SELECT perecedero FROM logic.producto WHERE id = $1', [p.receta.producto_id]);
    let loteId = null, loteCodigo = null;
    if (el.perecedero) {
      const { rows: [{ cu }] } = await c.query('SELECT ($1::numeric / $2::numeric)::numeric(16,6) AS cu',
        [costoTotal, ped.cantidad]);
      const l = await crearLote(c, {
        producto_id: p.receta.producto_id, codigo: texto(b.lote_codigo),
        vencimiento: fecha(b.vencimiento, { campo: 'Vencimiento' }), costo_base: cu,
        notas: 'Producción de ' + p.receta.nombre,
      });
      loteId = l.id; loteCodigo = l.codigo;
      await c.query('UPDATE logic.produccion SET lote_salida_id = $1 WHERE id = $2', [loteId, prod.id]);
    }

    for (const ing of p.ingredientes)
      for (const l of ing.lotes)
        await c.query(
          `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, origen_id, produccion_id, motivo)
           VALUES ('consumo', $1, $2, $3, $4, $5, $6)`,
          [ing.producto_id, l.lote_id, l.tomar, l.ubicacion_id, prod.id, 'Producción de ' + p.receta.nombre]);
    await c.query(
      `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, destino_id, produccion_id, motivo)
       VALUES ('produccion', $1, $2, $3, $4, $5, $6)`,
      [p.receta.producto_id, loteId, ped.cantidad, destino, prod.id, 'Producción de ' + p.receta.nombre]);
    return { id: prod.id, lote: loteCodigo, costo_total: costoTotal };
  });
  res.status(201).json({ ok: true, ...out });
}));

r.get('/producciones', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pr.id, pr.fecha, re.nombre AS receta, p.nombre AS elaborado, p.unidad_base,
            trim_scale(pr.cantidad_base)::text AS cantidad, l.codigo AS lote, l.vencimiento,
            pr.costo_total::text, u.nombre AS ubicacion, a.nombre AS almacen
       FROM logic.produccion pr
       JOIN logic.receta re ON re.id = pr.receta_id
       JOIN logic.producto p ON p.id = re.producto_id
       LEFT JOIN logic.lote l ON l.id = pr.lote_salida_id
       LEFT JOIN logic.ubicacion u ON u.id = pr.ubicacion_id
       LEFT JOIN logic.almacen a ON a.id = u.almacen_id
      ORDER BY pr.fecha DESC LIMIT 200`);
  res.json({ ok: true, producciones: rows });
}));

// Trazabilidad: con qué lotes de cada ingrediente se hizo una producción.
r.get('/producciones/:id', h(async (req, res) => {
  const { rows: consumos } = await pool.query(
    `SELECT p.nombre AS producto, p.unidad_base, l.codigo AS lote, l.vencimiento, pv.nombre AS proveedor,
            u.nombre AS ubicacion, trim_scale(m.cantidad_base)::text AS cantidad
       FROM logic.movimiento m
       JOIN logic.producto p ON p.id = m.producto_id
       LEFT JOIN logic.lote l ON l.id = m.lote_id
       LEFT JOIN logic.proveedor pv ON pv.id = l.proveedor_id
       LEFT JOIN logic.ubicacion u ON u.id = m.origen_id
      WHERE m.produccion_id = $1 AND m.tipo = 'consumo' ORDER BY p.nombre, l.vencimiento`, [req.params.id]);
  res.json({ ok: true, consumos });
}));

module.exports = r;
