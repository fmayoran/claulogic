// Proceso de abastecimiento: un asistente que lleva una compra del pedido al pago (pedido → recepción →
// comprobante → pago) y la bandeja de lo que quedó a mitad de camino.
//
// No es un sistema aparte: cada paso guarda en las tablas de siempre (logic.compra, fin.comprobante,
// órdenes de pago), así que lo hecho acá se ve en las pantallas de Compras y Facturas y al revés.
// La bandeja tampoco se guarda: se deduce del estado de las compras y los comprobantes, como el stock.
// Los productos se cargan una sola vez: los renglones de la compra arman los de la factura.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, texto, fecha, h, enTransaccion, aBase, UNIDAD_REF, enRef } = require('./util');
const { puede, exigir } = require('./auth');
const { leerCompra, guardarItems, recibirCompra } = require('./compras');
const { leerComprobante, insertarComprobante, actualizarComprobante, comprasConRenglones } = require('./finanzas');

const r = express.Router();
const veCompras = u => u.es_admin || u.finanzas || (u.roles || []).some(x => x.tipo === 'centro');

// ── Bandeja ──────────────────────────────────────────────────────────────────────────────────
// Etapa de cada compra abierta y el paso del asistente donde se retoma (pedido → recepción →
// comprobante → pago): pedido sin terminar → pedido · esperando mercadería → recepción · falta el
// comprobante o sin registrar → comprobante · por pagar → pago.
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
      x.estado === 'borrador' ? ['Pedido sin terminar', 'pedido']
      : x.estado === 'pedida' ? ['Esperando mercadería', 'recepcion']
      : !x.comprobante_id ? ['Falta el comprobante', 'comprobante']
      : x.comprobante_estado === 'borrador' ? ['Comprobante sin registrar', 'comprobante']
      : ['Por pagar', 'pago'];
    return { compra_id: x.compra_id, proveedor: x.proveedor, fecha: x.fecha, numero: x.numero, renglones: x.renglones,
      etapa, paso, vencimiento: etapa === 'Por pagar' ? x.vencimiento : null,
      importe: fin ? (etapa === 'Por pagar' ? x.pendiente : x.comprobante_total || x.total_compra) : null };
  });
  // La lista de compras: lo que hace falta y todavía no se pidió.
  const { rows: [lista] } = await pool.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE proveedor_id IS NULL)::int AS sin_prov, min(creado_en)::date AS desde
       FROM logic.necesidad WHERE estado = 'pendiente'`);
  if (lista.n) pendientes.unshift({ lista: true, proveedor: 'Lista de compras', etapa: 'Por pedir', paso: 'lista', fecha: lista.desde,
    renglones: lista.n, numero: lista.sin_prov ? `${lista.sin_prov} sin proveedor` : null });
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

// Corregir proveedor o productos mientras la mercadería no se recibió. Si ya hay un borrador de factura,
// se rehace con los productos nuevos y su misma cabecera (o la que venga en el pedido).
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
    const cabAnt = borr ? (await cn.query(
      `SELECT letra, punto_venta::text, numero::text, fecha::text, vencimiento::text FROM fin.comprobante WHERE id = $1`, [borr.id])).rows[0] : null;
    // Los renglones de la factura apuntan a los de la compra: se sueltan antes de rehacerlos.
    if (borr) await cn.query('DELETE FROM fin.comprobante_item WHERE comprobante_id = $1', [borr.id]);
    await cn.query('UPDATE logic.compra SET proveedor_id = $1, numero = COALESCE($2, numero), fecha = COALESCE($3::date, fecha), notas = COALESCE($4, notas) WHERE id = $5',
      [co.proveedor_id, co.numero, co.fecha, co.notas, req.params.id]);
    await guardarItems(cn, req.params.id, co.items);
    const usar = cab || (borr && cabAnt);
    return { comprobante_id: usar ? await guardarComprobante(cn, req.params.id, co.proveedor_id, usar, co.fecha || ant.fecha) : null };
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

// ── Lista de compras ─────────────────────────────────────────────────────────────────────────
// Lo que hace falta comprar en el centro, antes de saber a quién (logic.necesidad). Cada renglón se
// asigna a un proveedor —se sugiere el de la última compra, con su precio— y "generar pedidos" arma una
// compra por proveedor, que sigue el proceso de abastecimiento.

// Stock del producto en las sedes de tipo centro: contra eso se compara el mínimo.
const STOCK_CENTRO = `(SELECT s.producto_id, SUM(s.cantidad) AS cantidad FROM logic.stock s
                        JOIN logic.ubicacion u ON u.id = s.ubicacion_id JOIN logic.almacen a ON a.id = u.almacen_id
                        JOIN org.sede se ON se.id = a.sede_id WHERE se.tipo = 'centro' GROUP BY s.producto_id)`;
// Último costo por unidad base de cada proveedor para cada producto (de las compras recibidas con precio).
const ULTIMOS = `SELECT DISTINCT ON (ci.producto_id, co.proveedor_id) ci.producto_id, co.proveedor_id, co.fecha, ci.costo_base
                   FROM logic.compra_item ci JOIN logic.compra co ON co.id = ci.compra_id
                  WHERE co.estado = 'recibida' AND ci.costo_base IS NOT NULL
                  ORDER BY ci.producto_id, co.proveedor_id, co.fecha DESC, co.recibida_en DESC`;

async function leerNecesidad(cn, b) {
  const x = { producto_id: texto(b.producto_id, { campo: 'el producto', requerido: true }), presentacion_id: texto(b.presentacion_id),
    unidad: texto(b.unidad), cantidad: numero(b.cantidad, { campo: 'La cantidad', requerido: true, positivo: true }),
    proveedor_id: texto(b.proveedor_id), notas: texto(b.notas) };
  const { rows: [p] } = await cn.query('SELECT nombre, unidad_base FROM logic.producto WHERE id = $1::uuid', [x.producto_id]);
  if (!p) throw new ErrorUsuario('No existe ese producto.');
  if (x.presentacion_id) {
    const { rows: [pr] } = await cn.query(`SELECT ($1::numeric * cantidad_base)::numeric(16,4)::text AS base FROM logic.presentacion
      WHERE id = $2::uuid AND producto_id = $3::uuid`, [x.cantidad, x.presentacion_id, x.producto_id]);
    if (!pr) throw new ErrorUsuario('La presentación no corresponde al producto.');
    x.cantidad_base = pr.base; x.unidad = null;
  } else {
    x.unidad = x.unidad || p.unidad_base;
    x.cantidad_base = await aBase(cn, x.cantidad, x.unidad, p.unidad_base, p.nombre);
  }
  return x;
}

r.get('/abastecimiento/lista', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT n.id, n.producto_id, p.codigo, p.nombre, p.unidad_base, n.presentacion_id, pr.nombre AS presentacion, n.unidad,
            trim_scale(n.cantidad)::text AS cantidad, trim_scale(n.cantidad_base)::text AS cantidad_base,
            n.proveedor_id, n.origen, n.notas, n.creado_en, n.creado_por,
            trim_scale(COALESCE(st.cantidad, 0))::text AS stock_centro, trim_scale(p.stock_minimo)::text AS stock_minimo
       FROM logic.necesidad n JOIN logic.producto p ON p.id = n.producto_id
       LEFT JOIN logic.presentacion pr ON pr.id = n.presentacion_id
       LEFT JOIN ${STOCK_CENTRO} st ON st.producto_id = n.producto_id
      WHERE n.estado = 'pendiente' ORDER BY p.nombre, n.creado_en`);
  // Proveedores que vendieron cada producto, del más reciente al más viejo: el primero es el sugerido.
  const { rows: ult } = await pool.query(
    `SELECT u.producto_id, u.proveedor_id, pv.nombre AS proveedor, u.fecha, u.costo_base::text AS costo_base,
            ${enRef('u.costo_base')} AS costo_ref, ${UNIDAD_REF} AS unidad_ref
       FROM (${ULTIMOS}) u JOIN logic.proveedor pv ON pv.id = u.proveedor_id JOIN logic.producto p ON p.id = u.producto_id
      WHERE u.producto_id = ANY($1::uuid[]) ORDER BY u.producto_id, u.fecha DESC`, [[...new Set(rows.map(x => x.producto_id))]]);
  const anteriores = {};
  for (const u of ult) (anteriores[u.producto_id] ||= []).push(u);
  res.json({ ok: true, lista: rows.map(x => ({ ...x, anteriores: anteriores[x.producto_id] || [] })) });
}));

r.post('/abastecimiento/lista', h(async (req, res) => {
  const id = await enTransaccion(async cn => {
    const x = await leerNecesidad(cn, req.body);
    // Sin proveedor elegido, el de la última compra del producto.
    const { rows: [n] } = await cn.query(
      `INSERT INTO logic.necesidad (producto_id, presentacion_id, unidad, cantidad, cantidad_base, proveedor_id, notas)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6::uuid, (SELECT u.proveedor_id FROM (${ULTIMOS}) u WHERE u.producto_id = $1 ORDER BY u.fecha DESC LIMIT 1)), $7)
       RETURNING id`, [x.producto_id, x.presentacion_id, x.unidad, x.cantidad, x.cantidad_base, x.proveedor_id, x.notas]);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

r.put('/abastecimiento/lista/:id', h(async (req, res) => {
  await enTransaccion(async cn => {
    const x = await leerNecesidad(cn, req.body);
    const { rowCount } = await cn.query(
      `UPDATE logic.necesidad SET producto_id = $1, presentacion_id = $2, unidad = $3, cantidad = $4, cantidad_base = $5,
              proveedor_id = $6, notas = $7 WHERE id = $8::uuid AND estado = 'pendiente'`,
      [x.producto_id, x.presentacion_id, x.unidad, x.cantidad, x.cantidad_base, x.proveedor_id, x.notas, req.params.id]);
    if (!rowCount) throw new ErrorUsuario('Ese renglón ya no está en la lista (¿ya se pidió?).');
  });
  res.json({ ok: true });
}));

r.delete('/abastecimiento/lista/:id', h(async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM logic.necesidad WHERE id = $1::uuid AND estado = 'pendiente'`, [req.params.id]);
  if (!rowCount) throw new ErrorUsuario('Ese renglón ya no está en la lista.');
  res.json({ ok: true });
}));

// "Sumar lo que está bajo el mínimo": lo que falta para llegar al mínimo en el centro, de los productos
// que no están ya en la lista. Con el proveedor de la última compra.
r.post('/abastecimiento/lista/minimos', h(async (req, res) => {
  const { rowCount } = await pool.query(
    `INSERT INTO logic.necesidad (producto_id, unidad, cantidad, cantidad_base, proveedor_id, origen)
     SELECT p.id, ref.codigo, ((p.stock_minimo - COALESCE(st.cantidad, 0)) * b.factor_si / ref.factor_si)::numeric(16,4),
            p.stock_minimo - COALESCE(st.cantidad, 0),
            (SELECT u.proveedor_id FROM (${ULTIMOS}) u WHERE u.producto_id = p.id ORDER BY u.fecha DESC LIMIT 1), 'minimo'
       FROM logic.producto p LEFT JOIN ${STOCK_CENTRO} st ON st.producto_id = p.id
       -- En la unidad de referencia (kg, l): "50 kg" y no "50000 g", que es como se compra.
       JOIN logic.unidad b ON b.codigo = p.unidad_base
       JOIN logic.unidad ref ON ref.magnitud = b.magnitud AND ref.es_referencia
      WHERE p.activo AND p.stock_minimo > 0 AND COALESCE(st.cantidad, 0) < p.stock_minimo
        AND NOT EXISTS (SELECT 1 FROM logic.necesidad n WHERE n.producto_id = p.id AND n.estado = 'pendiente')`);
  res.json({ ok: true, agregados: rowCount });
}));

// Un pedido por proveedor con lo que ya tiene proveedor asignado (o sólo los renglones elegidos). El
// precio se propone con el último costo de ese proveedor; se corrige al recibir.
r.post('/abastecimiento/lista/pedidos', h(async (req, res) => {
  const ids = Array.isArray(req.body.ids) && req.body.ids.length ? req.body.ids.map(String) : null;
  const pedidos = await enTransaccion(async cn => {
    const { rows } = await cn.query(
      `SELECT n.*, pv.nombre AS proveedor,
              (SELECT round(u.costo_base * n.cantidad_base) FROM (${ULTIMOS}) u
                WHERE u.producto_id = n.producto_id AND u.proveedor_id = n.proveedor_id)::text AS precio_estimado
         FROM logic.necesidad n JOIN logic.proveedor pv ON pv.id = n.proveedor_id
        WHERE n.estado = 'pendiente' AND n.proveedor_id IS NOT NULL AND ($1::uuid[] IS NULL OR n.id = ANY($1::uuid[]))
        ORDER BY pv.nombre, n.creado_en FOR UPDATE OF n`, [ids]);
    if (!rows.length) throw new ErrorUsuario('No hay productos con proveedor asignado para pedir.');
    const porProv = new Map();
    for (const x of rows) (porProv.get(x.proveedor_id) || porProv.set(x.proveedor_id, []).get(x.proveedor_id)).push(x);
    const hechos = [];
    for (const [prov, items] of porProv) {
      const { rows: [co] } = await cn.query(
        `INSERT INTO logic.compra (proveedor_id, fecha, notas, estado) VALUES ($1, current_date, 'Desde la lista de compras', 'pedida') RETURNING id`, [prov]);
      await guardarItems(cn, co.id, items.map(x => ({ producto_id: x.producto_id, presentacion_id: x.presentacion_id, unidad: x.unidad,
        cantidad: x.cantidad, precio_total: x.precio_estimado })));
      await cn.query(`UPDATE logic.necesidad SET estado = 'pedida', compra_id = $1 WHERE id = ANY($2::uuid[])`, [co.id, items.map(x => x.id)]);
      hechos.push({ compra_id: co.id, proveedor: items[0].proveedor, renglones: items.length });
    }
    return hechos;
  });
  res.status(201).json({ ok: true, pedidos });
}));

// ── Recibir con entregas parciales ───────────────────────────────────────────────────────────
// Cada renglón trae lo recibido (en la misma presentación o unidad del pedido). La compra queda con lo
// que llegó de verdad —que es lo que el proveedor factura—: se ajustan cantidad y precio en proporción
// y lo que no llegó se quita. Lo que faltó vuelve a la lista de compras si así se pide ("faltante").
r.post('/abastecimiento/:id/recibir', h(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  await enTransaccion(async cn => {
    const { rows: [co] } = await cn.query(
      `SELECT c.id, c.estado, c.proveedor_id, c.fecha::text, to_char(c.fecha, 'DD/MM/YYYY') AS fecha_txt, pv.nombre AS proveedor FROM logic.compra c
         JOIN logic.proveedor pv ON pv.id = c.proveedor_id WHERE c.id = $1::uuid FOR UPDATE OF c`, [req.params.id]);
    if (!co) throw new ErrorUsuario('No existe esa compra.', 404);
    if (!['borrador', 'pedida'].includes(co.estado)) throw new ErrorUsuario(`La compra ya está ${co.estado}.`);
    const { rows: renglones } = await cn.query(
      `SELECT ci.id, ci.producto_id, ci.presentacion_id, trim_scale(ci.cantidad)::text AS cantidad, p.nombre, p.unidad_base,
              CASE WHEN ci.presentacion_id IS NULL THEN (SELECT u.codigo FROM logic.unidad u JOIN logic.unidad b ON b.codigo = p.unidad_base
                    WHERE u.magnitud = b.magnitud AND u.factor_si / b.factor_si = ci.cantidad_base / ci.cantidad
                    ORDER BY u.es_referencia DESC LIMIT 1) END AS unidad
         FROM logic.compra_item ci JOIN logic.producto p ON p.id = ci.producto_id WHERE ci.compra_id = $1`, [co.id]);
    const pedido = new Map(renglones.map(x => [x.id, x]));
    const cambios = [];
    for (const x of items) {
      const ren = pedido.get(x.id);
      if (!ren || x.recibido === undefined || x.recibido === null || String(x.recibido).trim() === '') continue;
      const recibido = numero(x.recibido, { campo: `Lo recibido de "${ren.nombre}"` });
      const { rows: [cmp] } = await cn.query('SELECT $1::numeric = $2::numeric AS igual, $1::numeric < $2::numeric AS menos', [recibido, ren.cantidad]);
      if (!cmp.igual) cambios.push({ ren, recibido, menos: cmp.menos, faltante: x.faltante === 'lista' });
    }
    if (cambios.length) {
      const { rows: [reg] } = await cn.query(
        `SELECT c.id FROM fin.comprobante_compra x JOIN fin.comprobante c ON c.id = x.comprobante_id
          WHERE x.compra_id = $1 AND c.estado = 'registrado' LIMIT 1`, [co.id]);
      if (reg) throw new ErrorUsuario('El comprobante de esta compra ya está registrado por lo pedido: recibí lo pedido, o anulá el comprobante y cargalo por lo que llegó.');
      const { rows: [borr] } = await cn.query(
        `SELECT c.id, c.letra, c.punto_venta::text, c.numero::text, c.fecha::text, c.vencimiento::text FROM fin.comprobante_compra x
           JOIN fin.comprobante c ON c.id = x.comprobante_id WHERE x.compra_id = $1 AND c.estado = 'borrador' LIMIT 1`, [co.id]);
      if (borr) await cn.query('DELETE FROM fin.comprobante_item WHERE comprobante_id = $1', [borr.id]);
      for (const { ren, recibido, menos, faltante } of cambios) {
        if (menos && faltante) {
          const falta = (await cn.query('SELECT ($1::numeric - $2::numeric)::text AS f', [ren.cantidad, recibido])).rows[0].f;
          const x = await leerNecesidad(cn, { producto_id: ren.producto_id, presentacion_id: ren.presentacion_id, unidad: ren.unidad, cantidad: falta });
          await cn.query(`INSERT INTO logic.necesidad (producto_id, presentacion_id, unidad, cantidad, cantidad_base, origen, notas)
                          VALUES ($1,$2,$3,$4,$5,'faltante',$6)`,
            [x.producto_id, x.presentacion_id, x.unidad, x.cantidad, x.cantidad_base, `No lo entregó ${co.proveedor} (pedido del ${co.fecha_txt})`]);
        }
        if (/^0+(\.0+)?$/.test(recibido)) await cn.query('DELETE FROM logic.compra_item WHERE id = $1', [ren.id]);
        else await cn.query(
          `UPDATE logic.compra_item SET cantidad_base = (cantidad_base * $1::numeric / cantidad)::numeric(16,4),
                  precio_total = round(precio_total * $1::numeric / cantidad), cantidad = $1::numeric WHERE id = $2`, [recibido, ren.id]);
      }
      const { rows: [quedan] } = await cn.query('SELECT count(*)::int AS n FROM logic.compra_item WHERE compra_id = $1', [co.id]);
      if (!quedan.n) throw new ErrorUsuario('No llegó nada: dejá el pedido esperando, o anulalo en Compras si ya no viene.');
      if (borr) await guardarComprobante(cn, co.id, co.proveedor_id, borr, co.fecha);
    }
    await recibirCompra(cn, co.id, { items }, req.usuario);
  });
  res.json({ ok: true });
}));

module.exports = r;
