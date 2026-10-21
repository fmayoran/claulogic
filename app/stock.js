// API de stock: consulta, lotes, ajustes por conteo, egresos y traslados, histórico y anulación.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, texto, fecha, h, enTransaccion, aBase, crearLote } = require('./util');

const { exigirEncargadoDe, filtroSedes } = require('./auth');
const r = express.Router();

// ── Consulta de stock ────────────────────────────────────────────────────────────────────────
// Detalle por producto, lote y ubicación. Incluye negativos: hoy se permiten, y esconderlos sería
// esconder justo lo que hay que mirar.
r.get('/stock', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.producto_id, p.codigo, p.nombre AS producto, p.unidad_base, p.perecedero, c.nombre AS categoria,
            s.lote_id, l.codigo AS lote, l.vencimiento, (l.vencimiento - current_date) AS dias_para_vencer,
            s.ubicacion_id, u.nombre AS ubicacion, u.tipo, a.id AS almacen_id, a.nombre AS almacen,
            a.sede_id, se.nombre AS sede, trim_scale(s.cantidad)::text AS cantidad
       FROM logic.stock s
       JOIN logic.producto  p ON p.id = s.producto_id
       JOIN logic.categoria c ON c.id = p.categoria_id
       JOIN logic.ubicacion u ON u.id = s.ubicacion_id
       JOIN logic.almacen   a ON a.id = u.almacen_id
       JOIN org.sede       se ON se.id = a.sede_id
       LEFT JOIN logic.lote l ON l.id = s.lote_id
      WHERE ($1::uuid IS NULL OR a.id = $1)
        AND ($6::uuid[] IS NULL OR a.sede_id = ANY($6))
        AND ($2::uuid IS NULL OR u.id = $2)
        AND ($3::uuid IS NULL OR p.id = $3)
        AND ($4::text IS NULL OR p.nombre ILIKE '%' || $4 || '%' OR p.codigo ILIKE '%' || $4 || '%')
        AND ($5::int  IS NULL OR l.vencimiento <= current_date + $5)
      ORDER BY p.nombre, l.vencimiento NULLS LAST, a.nombre, u.nombre
      LIMIT 2000`,
    [texto(req.query.almacen), texto(req.query.ubicacion), texto(req.query.producto),
     texto(req.query.q), numero(req.query.vence_dias, { campo: 'Días' }), filtroSedes(req)]);
  res.json({ ok: true, stock: rows });
}));

// Resumen por producto: lo que mira el encargado para saber qué pedir y qué usar primero.
r.get('/stock/productos', h(async (req, res) => {
  // Se suma sólo lo de las sedes que el usuario ve (la vista stock_producto suma el grupo entero).
  // El mínimo es uno solo por producto: con varias sedes, comparar contra él es orientativo.
  const { rows } = await pool.query(
    `WITH s AS (
       SELECT st.producto_id, st.lote_id, st.cantidad
         FROM logic.stock st JOIN logic.ubicacion u ON u.id = st.ubicacion_id JOIN logic.almacen a ON a.id = u.almacen_id
        WHERE $3::uuid[] IS NULL OR a.sede_id = ANY($3)),
     sp AS (
       SELECT p.id AS producto_id, p.codigo, p.nombre, p.unidad_base, p.stock_minimo, p.categoria_id,
              COALESCE(SUM(s.cantidad), 0) AS cantidad,
              MIN(l.vencimiento) FILTER (WHERE s.cantidad > 0) AS vence_primero
         FROM logic.producto p LEFT JOIN s ON s.producto_id = p.id LEFT JOIN logic.lote l ON l.id = s.lote_id
        WHERE p.activo GROUP BY p.id)
     SELECT sp.producto_id, sp.codigo, sp.nombre, sp.unidad_base, trim_scale(sp.cantidad)::text AS cantidad,
            trim_scale(sp.stock_minimo)::text AS stock_minimo, sp.vence_primero,
            sp.stock_minimo IS NOT NULL AND sp.cantidad < sp.stock_minimo AS bajo_minimo, c.nombre AS categoria
       FROM sp JOIN logic.categoria c ON c.id = sp.categoria_id
      WHERE ($1::text IS NULL OR sp.nombre ILIKE '%' || $1 || '%' OR sp.codigo ILIKE '%' || $1 || '%')
        AND (NOT $2 OR (sp.stock_minimo IS NOT NULL AND sp.cantidad < sp.stock_minimo))
      ORDER BY bajo_minimo DESC, sp.nombre`,
    [texto(req.query.q), req.query.bajo_minimo === '1', filtroSedes(req)]);
  res.json({ ok: true, productos: rows });
}));

// Lotes de un producto, con lo que queda de cada uno. Para elegir lote en ajustes y egresos.
r.get('/lotes', h(async (req, res) => {
  const producto = texto(req.query.producto, { campo: 'el producto', requerido: true });
  const { rows } = await pool.query(
    `SELECT l.id, l.codigo, l.vencimiento, trim_scale(COALESCE(SUM(s.cantidad), 0))::text AS cantidad
       FROM logic.lote l
       LEFT JOIN (logic.stock s JOIN logic.ubicacion u ON u.id = s.ubicacion_id JOIN logic.almacen a ON a.id = u.almacen_id)
              ON s.lote_id = l.id AND ($2::uuid[] IS NULL OR a.sede_id = ANY($2))
      WHERE l.producto_id = $1
      GROUP BY l.id ORDER BY l.vencimiento NULLS LAST, l.recibido_en`, [producto, filtroSedes(req)]);
  res.json({ ok: true, lotes: rows });
}));

// Lote elegido o lote nuevo. Un ajuste positivo de un perecedero puede necesitar uno que no existe.
async function resolverLote(c, b, productoId) {
  if (b.lote_id) return texto(b.lote_id);
  if (b.lote_nuevo) {
    const l = await crearLote(c, {
      producto_id: productoId,
      codigo: texto(b.lote_nuevo.codigo),
      vencimiento: fecha(b.lote_nuevo.vencimiento, { campo: 'Vencimiento' }),
    });
    return l.id;
  }
  return null;
}

async function producto(c, id) {
  const { rows: [p] } = await c.query('SELECT id, unidad_base, perecedero FROM logic.producto WHERE id = $1', [id]);
  if (!p) throw new ErrorUsuario('No existe ese producto.');
  return p;
}

// ── Ajustes ──────────────────────────────────────────────────────────────────────────────────
// Se manda lo CONTADO; la diferencia la calcula y la asienta la base (logic.ajustar_stock).
r.post('/ajustes', h(async (req, res) => {
  const b = req.body;
  const productoId = texto(b.producto_id, { campo: 'el producto', requerido: true });
  const ubicacion = texto(b.ubicacion_id, { campo: 'la ubicación', requerido: true });
  const contada = numero(b.contada, { campo: 'La cantidad contada', requerido: true });
  const motivo = texto(b.motivo, { campo: 'el motivo del ajuste', requerido: true });
  const out = await enTransaccion(async c => {
    const p = await producto(c, productoId);
    const loteId = await resolverLote(c, b, p.id);
    // Cero no se convierte (aBase rechaza el cero a propósito, para cantidades que mueven stock).
    const enBase = /^0+(\.0+)?$/.test(contada) ? '0' : await aBase(c, contada, texto(b.unidad), p.unidad_base, 'La cantidad contada');
    const { rows: [{ id }] } = await c.query('SELECT logic.ajustar_stock($1, $2, $3, $4, $5) AS id',
      [p.id, ubicacion, enBase, motivo, loteId]);
    const { rows: [a] } = await c.query(
      `SELECT id, trim_scale(cantidad_sistema)::text AS sistema, trim_scale(cantidad_contada)::text AS contada,
              trim_scale(diferencia)::text AS diferencia, movimiento_id FROM logic.ajuste WHERE id = $1`, [id]);
    return a;
  });
  res.status(201).json({ ok: true, ajuste: out });
}));

r.get('/ajustes', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.ocurrido_en, p.nombre AS producto, p.unidad_base, l.codigo AS lote,
            u.nombre AS ubicacion, al.nombre AS almacen,
            trim_scale(a.cantidad_sistema)::text AS sistema, trim_scale(a.cantidad_contada)::text AS contada,
            trim_scale(a.diferencia)::text AS diferencia, a.motivo, a.registrado_por
       FROM logic.ajuste a
       JOIN logic.producto p ON p.id = a.producto_id
       JOIN logic.ubicacion u ON u.id = a.ubicacion_id
       JOIN logic.almacen al ON al.id = u.almacen_id
       LEFT JOIN logic.lote l ON l.id = a.lote_id
      WHERE ($1::uuid IS NULL OR a.producto_id = $1)
        AND ($2::uuid[] IS NULL OR al.sede_id = ANY($2))
      ORDER BY a.ocurrido_en DESC LIMIT 100`, [texto(req.query.producto), filtroSedes(req)]);
  res.json({ ok: true, ajustes: rows });
}));

// ── Egresos y traslados manuales ─────────────────────────────────────────────────────────────
// Las entradas no van por acá: entran por compra, por producción o por ajuste, que es donde
// queda escrito de dónde salió la mercadería.
const EGRESOS = ['merma', 'vencimiento', 'consumo', 'venta'];

r.post('/movimientos', h(async (req, res) => {
  const b = req.body;
  const tipo = texto(b.tipo, { campo: 'el tipo', requerido: true });
  if (![...EGRESOS, 'traslado'].includes(tipo)) throw new ErrorUsuario('Tipo de movimiento inválido.');
  const productoId = texto(b.producto_id, { campo: 'el producto', requerido: true });
  const origen = texto(b.origen_id, { campo: 'la ubicación de origen', requerido: true });
  const destino = tipo === 'traslado' ? texto(b.destino_id, { campo: 'la ubicación de destino', requerido: true }) : null;
  if (origen === destino) throw new ErrorUsuario('El origen y el destino son la misma ubicación.');
  const cantidad = numero(b.cantidad, { campo: 'La cantidad', requerido: true, positivo: true });
  const motivo = texto(b.motivo);
  if (tipo === 'merma' && !motivo) throw new ErrorUsuario('Una merma necesita motivo.');
  const id = await enTransaccion(async c => {
    const p = await producto(c, productoId);
    const enBase = await aBase(c, cantidad, texto(b.unidad), p.unidad_base, 'La cantidad');
    const { rows: [m] } = await c.query(
      `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, origen_id, destino_id, motivo, referencia)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tipo, p.id, texto(b.lote_id), enBase, origen, destino, motivo, texto(b.referencia)]);
    return m.id;
  });
  res.status(201).json({ ok: true, id });
}));

// ── Histórico ────────────────────────────────────────────────────────────────────────────────
r.get('/movimientos', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT h.id, h.ocurrido_en, h.tipo, h.sentido, h.producto_id, h.producto_codigo, h.producto, h.categoria,
            h.unidad_base, h.lote, h.vencimiento, trim_scale(h.cantidad_base)::text AS cantidad,
            h.origen, h.origen_almacen, h.destino, h.destino_almacen, h.motivo, h.referencia,
            h.registrado_por, h.anula_a, h.anulado_por,
            m.compra_item_id IS NOT NULL AS de_compra, m.produccion_id IS NOT NULL AS de_produccion,
            m.remito_id, rm.numero AS remito_numero
       FROM logic.historial_movimiento h
       JOIN logic.movimiento m ON m.id = h.id
       LEFT JOIN logic.remito rm ON rm.id = m.remito_id
      WHERE ($1::date IS NULL OR h.ocurrido_en >= $1::date)
        AND ($7::uuid[] IS NULL OR EXISTS (SELECT 1 FROM logic.ubicacion u JOIN logic.almacen a ON a.id = u.almacen_id
                                            WHERE a.sede_id = ANY($7) AND u.id IN (h.origen_id, h.destino_id)))
        AND ($2::date IS NULL OR h.ocurrido_en <  $2::date + 1)
        AND ($3::uuid IS NULL OR h.producto_id = $3)
        AND ($4::text IS NULL OR h.tipo = $4)
        AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM logic.ubicacion u
                                          WHERE u.almacen_id = $5 AND u.id IN (h.origen_id, h.destino_id)))
        AND ($6::text IS NULL OR h.producto ILIKE '%' || $6 || '%' OR h.producto_codigo ILIKE '%' || $6 || '%'
                              OR h.lote ILIKE '%' || $6 || '%' OR h.referencia ILIKE '%' || $6 || '%')
      ORDER BY h.ocurrido_en DESC, h.id DESC
      LIMIT 500`,
    [fecha(req.query.desde, { campo: 'Desde' }), fecha(req.query.hasta, { campo: 'Hasta' }),
     texto(req.query.producto), texto(req.query.tipo), texto(req.query.almacen), texto(req.query.q), filtroSedes(req)]);
  res.json({ ok: true, movimientos: rows });
}));

// ── Anulación ────────────────────────────────────────────────────────────────────────────────
// No se borra: se asienta el movimiento inverso con anula_a, y quedan los dos. Los movimientos de
// una compra o una producción no se anulan sueltos: dejarían el documento contando otra historia.
r.post('/movimientos/:id/anular', h(async (req, res) => {
  const motivo = texto(req.body.motivo, { campo: 'el motivo de la anulación', requerido: true });
  const id = await enTransaccion(async c => {
    const { rows: [m] } = await c.query('SELECT * FROM logic.movimiento WHERE id = $1', [req.params.id]);
    if (!m) throw new ErrorUsuario('No existe ese movimiento.');
    if (m.anula_a) throw new ErrorUsuario('Es una anulación: no se anula una anulación. Registrá el movimiento de nuevo.');
    if (m.compra_item_id || m.produccion_id || m.remito_id || m.pos_consumo_id)
      throw new ErrorUsuario('Es parte de una compra, una producción, un remito o las ventas de un POS: no se anula suelto.');
    // Anular es de encargado, en cada sede que el movimiento toca.
    const { rows: sedes } = await c.query(
      `SELECT DISTINCT s.id, s.nombre FROM logic.ubicacion u JOIN logic.almacen a ON a.id = u.almacen_id
         JOIN org.sede s ON s.id = a.sede_id WHERE u.id IN ($1, $2)`, [m.origen_id, m.destino_id]);
    for (const s of sedes) exigirEncargadoDe(req, s.id, s.nombre);
    const { rows: [n] } = await c.query(
      `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, origen_id, destino_id,
                                     motivo, referencia, anula_a)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [m.tipo, m.producto_id, m.lote_id, m.cantidad_base, m.destino_id, m.origen_id,
       'Anula #' + m.id + ': ' + motivo, m.referencia, m.id]);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

module.exports = r;
