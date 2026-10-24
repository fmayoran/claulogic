// Proceso de abastecimiento: un asistente que lleva una compra del pedido al pago (proveedor y
// comprobante → productos → recepción → factura y pago) y la bandeja de lo que quedó a mitad de camino.
//
// No es un sistema aparte: cada paso guarda en las tablas de siempre (logic.compra, fin.comprobante,
// órdenes de pago), así que lo hecho acá se ve en las pantallas de Compras y Facturas y al revés.
// La bandeja tampoco se guarda: se deduce del estado de las compras y los comprobantes, como el stock.
// Los productos se cargan una sola vez: los renglones de la compra arman los de la factura.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, texto, fecha, h, enTransaccion } = require('./util');
const { puede, exigir } = require('./auth');
const { leerCompra, guardarItems } = require('./compras');
const { leerComprobante, insertarComprobante, actualizarComprobante, comprasConRenglones } = require('./finanzas');

const r = express.Router();
const veCompras = u => u.es_admin || u.finanzas || (u.roles || []).some(x => x.tipo === 'centro');

// ── Bandeja ──────────────────────────────────────────────────────────────────────────────────
// Etapa de cada compra abierta y el paso del asistente donde se retoma:
//   carga sin terminar (borrador) → productos · esperando mercadería (pedida) → recepción ·
//   falta la factura / factura sin registrar / por pagar (recibida) → factura y pago.
// Más las facturas por pagar que no vienen de una compra (cargadas directo en Facturas).
r.get('/abastecimiento/pendientes', h(async (req, res) => {
  if (!veCompras(req.usuario)) return res.json({ ok: true, pendientes: [] });
  const fin = puede(req.usuario, 'finanzas');
  const { rows } = await pool.query(
    `SELECT co.id AS compra_id, co.estado, co.fecha, co.numero, pv.nombre AS proveedor,
            (SELECT count(*) FROM logic.compra_item ci WHERE ci.compra_id = co.id)::int AS renglones,
            (SELECT SUM(ci.precio_total) FROM logic.compra_item ci WHERE ci.compra_id = co.id)::text AS total_compra,
            cmp.id AS comprobante_id, cmp.estado AS comprobante_estado, cmp.total::text AS comprobante_total,
            cp.pendiente::text AS pendiente, cmp.vencimiento
       FROM logic.compra co
       JOIN logic.proveedor pv ON pv.id = co.proveedor_id
       LEFT JOIN LATERAL (SELECT c.* FROM fin.comprobante_compra x JOIN fin.comprobante c ON c.id = x.comprobante_id
                           WHERE x.compra_id = co.id AND c.estado <> 'anulado' ORDER BY c.creado_en DESC LIMIT 1) cmp ON true
       LEFT JOIN fin.comprobante_pendiente cp ON cp.comprobante_id = cmp.id
      WHERE co.estado IN ('borrador','pedida')
         OR (co.estado = 'recibida' AND (cmp.id IS NULL OR cmp.estado = 'borrador' OR cp.pendiente >= 1))
      ORDER BY co.fecha, co.creado_en`);
  const pendientes = rows.map(x => {
    const [etapa, paso] =
      x.estado === 'borrador' ? ['Carga sin terminar', 'productos']
      : x.estado === 'pedida' ? ['Esperando mercadería', 'recepcion']
      : !x.comprobante_id ? ['Falta la factura', 'pago']
      : x.comprobante_estado === 'borrador' ? ['Factura sin registrar', 'pago']
      : ['Por pagar', 'pago'];
    return { compra_id: x.compra_id, proveedor: x.proveedor, fecha: x.fecha, numero: x.numero, renglones: x.renglones,
      etapa, paso, vencimiento: etapa === 'Por pagar' ? x.vencimiento : null,
      importe: fin ? (etapa === 'Por pagar' ? x.pendiente : x.comprobante_total || x.total_compra) : null };
  });
  // Facturas por pagar cargadas directo, sin compra: se pagan desde Facturas.
  if (fin) {
    const { rows: directas } = await pool.query(
      `SELECT cp.comprobante_id, pv.nombre AS proveedor, cp.fecha, cp.vencimiento, cp.pendiente::text AS pendiente,
              CASE cp.tipo WHEN 'factura' THEN 'FC' ELSE 'ND' END || ' ' || cp.letra || ' ' ||
              lpad(cp.punto_venta::text, 5, '0') || '-' || lpad(cp.numero::text, 8, '0') AS numero
         FROM fin.comprobante_pendiente cp JOIN logic.proveedor pv ON pv.id = cp.proveedor_id
        WHERE cp.pendiente >= 1 AND NOT EXISTS (SELECT 1 FROM fin.comprobante_compra x WHERE x.comprobante_id = cp.comprobante_id)
        ORDER BY cp.vencimiento`);
    for (const d of directas) pendientes.push({ comprobante_id: d.comprobante_id, proveedor: d.proveedor, fecha: d.fecha,
      numero: d.numero, etapa: 'Por pagar', paso: 'pago', vencimiento: d.vencimiento, importe: d.pendiente, directa: true });
  }
  res.json({ ok: true, pendientes });
}));

// ── Compra y factura en un solo paso ─────────────────────────────────────────────────────────
// Cabecera del comprobante que viene del asistente (sin renglones: salen de la compra).
function leerCabecera(b) {
  if (!b) return null;
  return { letra: (texto(b.letra) || 'A').toUpperCase(), punto_venta: texto(b.punto_venta), numero: texto(b.numero),
           fecha: fecha(b.fecha, { campo: 'La fecha del comprobante' }), vencimiento: fecha(b.vencimiento, { campo: 'Vencimiento' }) };
}
const nroDe = c => c && c.numero ? `${c.letra} ${String(c.punto_venta || 0).padStart(5, '0')}-${String(c.numero).padStart(8, '0')}` : null;

// Arma o actualiza el comprobante en borrador de la compra con sus renglones. Los renglones son los de
// la compra (mismos productos, cantidades y precios); la alícuota, la habitual de cada producto.
async function guardarComprobante(cn, compraId, proveedorId, cab, fechaCompra) {
  const [compra] = await comprasConRenglones(cn, compraId, { porId: true });
  const discrimina = ['A', 'M'].includes(cab.letra);
  const c = leerComprobante({ proveedor_id: proveedorId, tipo: 'factura', letra: cab.letra, punto_venta: cab.punto_venta,
    numero: cab.numero, fecha: cab.fecha || fechaCompra, vencimiento: cab.vencimiento, compras: [compraId], tributos: [],
    items: compra.items.map(i => ({ ...i, alicuota: discrimina ? (i.alicuota ?? '') : '' })) });
  const { rows: [ya] } = await cn.query(
    `SELECT c.id, c.estado FROM fin.comprobante_compra x JOIN fin.comprobante c ON c.id = x.comprobante_id
      WHERE x.compra_id = $1 AND c.estado <> 'anulado' ORDER BY c.creado_en DESC LIMIT 1`, [compraId]);
  if (ya && ya.estado !== 'borrador') throw new ErrorUsuario('La factura de esta compra ya está registrada: si hay que corregirla, se hace desde Facturas.');
  return ya ? (await actualizarComprobante(cn, ya.id, c), ya.id) : insertarComprobante(cn, c);
}

// Nuevo: la compra (pedida: esperando mercadería o recién llegada) y, si ya está la factura, su borrador.
r.post('/abastecimiento', h(async (req, res) => {
  const b = req.body, cab = leerCabecera(b.comprobante);
  if (cab) exigir(req, 'finanzas');
  const co = leerCompra({ ...b, numero: b.numero || (cab && nroDe(cab)) });
  const ids = await enTransaccion(async cn => {
    const { rows: [n] } = await cn.query(
      `INSERT INTO logic.compra (proveedor_id, numero, fecha, notas, estado)
       VALUES ($1,$2,COALESCE($3::date, current_date),$4,'pedida') RETURNING id, fecha::text`,
      [co.proveedor_id, co.numero, co.fecha, co.notas]);
    await guardarItems(cn, n.id, co.items);
    const comprobante = cab ? await guardarComprobante(cn, n.id, co.proveedor_id, cab, n.fecha) : null;
    return { id: n.id, comprobante_id: comprobante };
  });
  res.status(201).json({ ok: true, ...ids });
}));

// Corregir proveedor, comprobante o productos mientras la mercadería no se recibió. Sin cabecera de
// comprobante, el borrador que hubiera se borra ("todavía no llegó la factura").
r.put('/abastecimiento/:id', h(async (req, res) => {
  const b = req.body, cab = leerCabecera(b.comprobante);
  const co = leerCompra({ ...b, numero: b.numero || (cab && nroDe(cab)) });
  const out = await enTransaccion(async cn => {
    const { rows: [ant] } = await cn.query('SELECT estado, fecha::text FROM logic.compra WHERE id = $1::uuid FOR UPDATE', [req.params.id]);
    if (!ant) throw new ErrorUsuario('No existe esa compra.', 404);
    if (!['borrador', 'pedida'].includes(ant.estado)) throw new ErrorUsuario('La mercadería ya se recibió: los productos no se cambian.');
    const { rows: [borr] } = await cn.query(
      `SELECT c.id, c.estado FROM fin.comprobante_compra x JOIN fin.comprobante c ON c.id = x.comprobante_id
        WHERE x.compra_id = $1 AND c.estado <> 'anulado' ORDER BY c.creado_en DESC LIMIT 1`, [req.params.id]);
    if (borr && borr.estado !== 'borrador') throw new ErrorUsuario('La factura de esta compra ya está registrada: corregila desde Facturas.');
    if (borr || cab) exigir(req, 'finanzas');
    // Los renglones de la factura apuntan a los de la compra: se sueltan antes de rehacerlos.
    if (borr) await cn.query('DELETE FROM fin.comprobante_item WHERE comprobante_id = $1', [borr.id]);
    await cn.query('UPDATE logic.compra SET proveedor_id = $1, numero = $2, fecha = COALESCE($3::date, fecha), notas = $4 WHERE id = $5',
      [co.proveedor_id, co.numero, co.fecha, co.notas, req.params.id]);
    await guardarItems(cn, req.params.id, co.items);
    if (cab) return { comprobante_id: await guardarComprobante(cn, req.params.id, co.proveedor_id, cab, co.fecha || ant.fecha) };
    if (borr) {
      await cn.query('DELETE FROM fin.comprobante_compra WHERE comprobante_id = $1', [borr.id]);
      await cn.query('DELETE FROM fin.comprobante WHERE id = $1', [borr.id]);
    }
    return { comprobante_id: null };
  });
  res.json({ ok: true, id: req.params.id, ...out });
}));

// La factura llega después de la mercadería: se arma desde la compra recibida.
r.post('/abastecimiento/:id/comprobante', h(async (req, res) => {
  const cab = leerCabecera(req.body);
  const id = await enTransaccion(async cn => {
    const { rows: [co] } = await cn.query('SELECT proveedor_id, estado, fecha::text FROM logic.compra WHERE id = $1::uuid', [req.params.id]);
    if (!co) throw new ErrorUsuario('No existe esa compra.', 404);
    if (co.estado === 'anulada') throw new ErrorUsuario('La compra está anulada.');
    return guardarComprobante(cn, req.params.id, co.proveedor_id, cab, co.fecha);
  });
  res.status(201).json({ ok: true, comprobante_id: id });
}));

module.exports = r;
