// API de compras: carga, estados y recepción. Recibir es lo que mueve stock: por cada renglón
// crea el lote (si el producto es perecedero), asienta el movimiento de entrada y registra la
// decisión sobre el costo vigente.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, monto, texto, fecha, h, enTransaccion, aBase, crearLote, UNIDAD_REF, enRef } = require('./util');
const { puede } = require('./auth');

// Las compras las hace y las recibe el centro: un usuario que sólo tiene rol en locales no las ve.
const veCompras = u => u.es_admin || u.finanzas || (u.roles || []).some(x => x.tipo === 'centro');

const r = express.Router();

r.get('/compras', h(async (req, res) => {
  if (!veCompras(req.usuario)) return res.json({ ok: true, compras: [] });
  const { rows } = await pool.query(
    `SELECT c.id, c.numero, c.fecha, c.estado, c.recibida_en, pr.nombre AS proveedor,
            COUNT(ci.id)::int AS renglones, SUM(ci.precio_total)::text AS total
       FROM logic.compra c
       JOIN logic.proveedor pr ON pr.id = c.proveedor_id
       LEFT JOIN logic.compra_item ci ON ci.compra_id = c.id
      WHERE ($1::text IS NULL OR c.estado = $1)
      GROUP BY c.id, pr.nombre
      ORDER BY c.fecha DESC, c.creado_en DESC LIMIT 300`, [texto(req.query.estado)]);
  res.json({ ok: true, compras: rows });
}));

r.get('/compras/:id', h(async (req, res) => {
  if (!veCompras(req.usuario)) return res.status(403).json({ ok: false, error: 'Las compras son del centro.' });
  const { rows: [c] } = await pool.query(
    `SELECT c.id, c.proveedor_id, pr.nombre AS proveedor, c.numero, c.fecha, c.estado, c.notas, c.recibida_en
       FROM logic.compra c JOIN logic.proveedor pr ON pr.id = c.proveedor_id WHERE c.id = $1`, [req.params.id]);
  if (!c) return res.status(404).json({ ok: false, error: 'No existe esa compra.' });
  // Costo de la compra y costo vigente, los dos en la unidad de referencia: es la comparación
  // sobre la que se decide al recibir.
  const { rows: items } = await pool.query(
    `SELECT ci.id, ci.producto_id, p.codigo, p.nombre AS producto, p.unidad_base, p.perecedero, p.vida_util_dias,
            ci.presentacion_id, pres.nombre AS presentacion,
            trim_scale(ci.cantidad)::text AS cantidad, trim_scale(ci.cantidad_base)::text AS cantidad_base,
            ci.precio_total::text, ${UNIDAD_REF} AS unidad_ref,
            ${enRef('ci.costo_base')} AS costo_compra, ${enRef('p.costo_base')} AS costo_vigente,
            CASE WHEN p.costo_base > 0 AND ci.costo_base IS NOT NULL
                 THEN round((ci.costo_base / p.costo_base - 1) * 100, 1)::text END AS variacion_pct,
            ci.costo_decision, l.id AS lote_id, l.codigo AS lote, l.vencimiento, u.nombre AS ubicacion
       FROM logic.compra_item ci
       JOIN logic.producto p ON p.id = ci.producto_id
       LEFT JOIN logic.presentacion pres ON pres.id = ci.presentacion_id
       LEFT JOIN logic.movimiento m ON m.compra_item_id = ci.id AND m.anula_a IS NULL
       LEFT JOIN logic.lote l ON l.id = m.lote_id
       LEFT JOIN logic.ubicacion u ON u.id = m.destino_id
      WHERE ci.compra_id = $1 ORDER BY p.nombre`, [c.id]);
  res.json({ ok: true, compra: { ...c, items } });
}));

function leerCompra(b) {
  const c = {
    proveedor_id: texto(b.proveedor_id, { campo: 'el proveedor', requerido: true }),
    numero: texto(b.numero),
    fecha: fecha(b.fecha, { campo: 'Fecha' }),
    notas: texto(b.notas),
  };
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new ErrorUsuario('La compra no tiene renglones.');
  c.items = items.map((x, i) => ({
    producto_id: texto(x.producto_id, { campo: `el producto del renglón ${i + 1}`, requerido: true }),
    presentacion_id: texto(x.presentacion_id),
    unidad: texto(x.unidad),
    cantidad: numero(x.cantidad, { campo: `Cantidad del renglón ${i + 1}`, requerido: true, positivo: true }),
    precio_total: monto(x.precio_total, { campo: `Precio del renglón ${i + 1}` }),
  }));
  return c;
}

// Cada renglón se compra en una presentación ("3 cajas x6") o en una unidad suelta ("12 kg"), y
// se guarda también en unidad base, que es lo que va a entrar al stock.
async function guardarItems(c, compraId, items) {
  await c.query('DELETE FROM logic.compra_item WHERE compra_id = $1', [compraId]);
  for (const [i, x] of items.entries()) {
    const { rows: [p] } = await c.query('SELECT unidad_base FROM logic.producto WHERE id = $1', [x.producto_id]);
    if (!p) throw new ErrorUsuario(`El producto del renglón ${i + 1} no existe.`);
    let base;
    if (x.presentacion_id) {
      const { rows: [pr] } = await c.query(
        `SELECT ($1::numeric * cantidad_base)::numeric(16,4)::text AS base FROM logic.presentacion
          WHERE id = $2 AND producto_id = $3`, [x.cantidad, x.presentacion_id, x.producto_id]);
      if (!pr) throw new ErrorUsuario(`La presentación del renglón ${i + 1} no corresponde al producto.`);
      base = pr.base;
    } else {
      base = await aBase(c, x.cantidad, x.unidad, p.unidad_base, `El renglón ${i + 1}`);
    }
    await c.query(
      `INSERT INTO logic.compra_item (compra_id, producto_id, presentacion_id, cantidad, cantidad_base, precio_total)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [compraId, x.producto_id, x.presentacion_id, x.cantidad, base, x.precio_total]);
  }
}

r.post('/compras', h(async (req, res) => {
  const b = leerCompra(req.body);
  const id = await enTransaccion(async c => {
    const { rows: [n] } = await c.query(
      `INSERT INTO logic.compra (proveedor_id, numero, fecha, notas)
       VALUES ($1,$2,COALESCE($3::date, current_date),$4) RETURNING id`,
      [b.proveedor_id, b.numero, b.fecha, b.notas]);
    await guardarItems(c, n.id, b.items);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

// Los triggers de la base frenan la edición de una compra recibida o anulada.
r.put('/compras/:id', h(async (req, res) => {
  const b = leerCompra(req.body);
  const ok = await enTransaccion(async c => {
    const { rowCount } = await c.query(
      `UPDATE logic.compra SET proveedor_id=$1, numero=$2, fecha=COALESCE($3::date, fecha), notas=$4
        WHERE id=$5 AND estado IN ('borrador','pedida')`,
      [b.proveedor_id, b.numero, b.fecha, b.notas, req.params.id]);
    if (!rowCount) return false;
    await guardarItems(c, req.params.id, b.items);
    return true;
  });
  if (!ok) throw new ErrorUsuario('La compra no existe o ya no se puede editar.');
  res.json({ ok: true, id: req.params.id });
}));

r.post('/compras/:id/estado', h(async (req, res) => {
  const estado = texto(req.body.estado, { campo: 'el estado', requerido: true });
  if (!['borrador', 'pedida', 'anulada'].includes(estado))
    throw new ErrorUsuario('Para pasarla a recibida, usá la recepción.');
  const { rowCount } = await pool.query('UPDATE logic.compra SET estado = $1 WHERE id = $2', [estado, req.params.id]);
  if (!rowCount) return res.status(404).json({ ok: false, error: 'No existe esa compra.' });
  res.json({ ok: true });
}));

r.delete('/compras/:id', h(async (req, res) => {
  const { rowCount } = await pool.query(
    "DELETE FROM logic.compra WHERE id = $1 AND estado IN ('borrador','pedida')", [req.params.id]);
  if (!rowCount) throw new ErrorUsuario('Sólo se borra una compra en borrador o pedida. Una recibida se conserva.');
  res.json({ ok: true });
}));

// ── Recepción ────────────────────────────────────────────────────────────────────────────────
// Se recibe la compra entera de una vez. Por renglón: a qué ubicación va, el lote (código y
// vencimiento, para perecederos) y si su costo reemplaza al vigente. La decisión es explícita:
// un renglón con precio sin decisión no se recibe.
r.post('/compras/:id/recibir', h(async (req, res) => {
  const b = req.body;
  const porItem = new Map((Array.isArray(b.items) ? b.items : []).map(x => [x.id, x]));
  const ubicacionDefault = texto(b.ubicacion_id);
  await enTransaccion(async c => {
    const { rows: [compra] } = await c.query(
      'SELECT id, estado, proveedor_id, numero FROM logic.compra WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!compra) throw new ErrorUsuario('No existe esa compra.');
    if (!['borrador', 'pedida'].includes(compra.estado)) throw new ErrorUsuario(`La compra ya está ${compra.estado}.`);
    const { rows: items } = await c.query(
      `SELECT ci.id, ci.producto_id, ci.cantidad_base, ci.costo_base, p.nombre, p.perecedero
         FROM logic.compra_item ci JOIN logic.producto p ON p.id = ci.producto_id
        WHERE ci.compra_id = $1`, [compra.id]);
    if (!items.length) throw new ErrorUsuario('La compra no tiene renglones.');

    for (const it of items) {
      const x = porItem.get(it.id) || {};
      const ubicacion = texto(x.ubicacion_id) || ubicacionDefault;
      if (!ubicacion) throw new ErrorUsuario(`Falta a qué ubicación va "${it.nombre}".`);
      let loteId = null;
      if (it.perecedero) {
        const l = await crearLote(c, {
          producto_id: it.producto_id, codigo: texto(x.lote_codigo),
          vencimiento: fecha(x.vencimiento, { campo: `Vencimiento de "${it.nombre}"` }),
          proveedor_id: compra.proveedor_id, costo_base: it.costo_base,
        });
        loteId = l.id;
      }
      await c.query(
        `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, destino_id, referencia, compra_item_id, motivo)
         VALUES ('compra', $1, $2, $3, $4, $5, $6, 'Recepción de compra')`,
        [it.producto_id, loteId, it.cantidad_base, ubicacion, compra.numero, it.id]);

      if (it.costo_base !== null) {
        if (x.actualizar_costo === undefined || x.actualizar_costo === null)
          throw new ErrorUsuario(`Falta decidir si el costo de "${it.nombre}" actualiza el vigente.`);
        // Recibir lo hace quien está en el depósito; mover el costo vigente es una decisión del catálogo.
        if (x.actualizar_costo && !puede(req.usuario, 'catalogo'))
          throw new ErrorUsuario(`Actualizar el costo de "${it.nombre}" lo decide el encargado del centro. Recibí manteniendo el costo vigente.`, 403);
        const decision = x.actualizar_costo ? 'actualizado' : 'mantenido';
        if (x.actualizar_costo) {
          // El trigger de costo lee este contexto y asienta el cambio como origen 'compra'.
          await c.query(`SELECT set_config('logic.costo_origen', 'compra', true),
                                set_config('logic.compra_item', $1, true)`, [it.id]);
          await c.query('UPDATE logic.producto SET costo_base = $1 WHERE id = $2', [it.costo_base, it.producto_id]);
        }
        await c.query('UPDATE logic.compra_item SET costo_decision = $1 WHERE id = $2', [decision, it.id]);
      }
    }
    await c.query(`SELECT set_config('logic.costo_origen', '', true), set_config('logic.compra_item', '', true)`);
    await c.query("UPDATE logic.compra SET estado = 'recibida', recibida_en = now() WHERE id = $1", [compra.id]);
  });
  res.json({ ok: true });
}));

module.exports = r;
