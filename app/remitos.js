// API de notas de pedido y remitos internos entre sedes.
//
// Circuito: el local arma una nota de pedido y la envía; el centro la convierte en remito (los
// lotes se eligen por FEFO del almacén que despacha), lo revisa y lo despacha. Despachar asienta
// los traslados al local en el momento. El local confirma lo que llegó: un faltante sale como
// merma atada al remito, con motivo; un sobrante entra como ajuste. Nada se reescribe.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, texto, fecha, h, enTransaccion, aBase } = require('./util');
const { rolEn, exigirOperarEn, exigirEncargadoDe, filtroSedes } = require('./auth');

const r = express.Router();

const nroPedido = n => 'NP-' + String(n).padStart(6, '0');
const nroRemito = n => 'RI-' + String(n).padStart(6, '0');
const limpiar = v => v === null || v === undefined ? null : String(v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

async function sede(c, id, nombreCampo) {
  const { rows: [s] } = await c.query('SELECT id, nombre, tipo, activa FROM org.sede WHERE id = $1::uuid', [id]);
  if (!s) throw new ErrorUsuario(`No existe ${nombreCampo}.`);
  if (!s.activa) throw new ErrorUsuario(`${s.nombre} está inactiva.`);
  return s;
}

async function unidadBase(c, productoId, i) {
  const { rows: [p] } = await c.query('SELECT unidad_base, perecedero, nombre FROM logic.producto WHERE id = $1::uuid', [productoId]);
  if (!p) throw new ErrorUsuario(`El producto del renglón ${i + 1} no existe.`);
  return p;
}

// ── FEFO ─────────────────────────────────────────────────────────────────────────────────────
// Qué lotes y ubicaciones del almacén cubren `cantidad`: primero lo que vence primero, sin lotes
// vencidos. La suma acumulada va en SQL, en NUMERIC (restar en JavaScript sería float).
async function fefo(c, productoId, almacenId, cantidad) {
  const { rows: lineas } = await c.query(
    `WITH d AS (
       SELECT ld.*, SUM(ld.cantidad) OVER (ORDER BY ld.vencimiento NULLS LAST, ld.lote, ld.ubicacion_id
                                           ROWS UNBOUNDED PRECEDING) AS acum
         FROM logic.lote_disponible ld
        WHERE ld.producto_id = $1 AND ld.almacen_id = $2
          AND (ld.vencimiento IS NULL OR ld.vencimiento >= current_date))
     SELECT lote_id, ubicacion_id, LEAST(cantidad, $3::numeric - (acum - cantidad))::numeric(16,4)::text AS tomar
       FROM d WHERE acum - cantidad < $3::numeric ORDER BY acum`,
    [productoId, almacenId, cantidad]);
  const { rows: [t] } = await c.query(
    'SELECT GREATEST($1::numeric - COALESCE(SUM(x), 0), 0)::numeric(16,4)::text AS faltante FROM unnest($2::numeric[]) x',
    [cantidad, lineas.map(l => l.tomar)]);
  return { lineas, faltante: t.faltante };
}
const esCero = v => /^0+(\.0+)?$/.test(String(v));

// ── Notas de pedido ──────────────────────────────────────────────────────────────────────────
r.get('/pedidos', h(async (req, res) => {
  const sedes = filtroSedes(req);
  const { rows } = await pool.query(
    `SELECT p.id, p.numero, p.estado, p.necesario_para, p.creado_en, p.enviado_en, p.creado_por,
            p.sede_id, s.nombre AS sede, p.proveedora_sede_id, sp.nombre AS proveedora,
            (SELECT COUNT(*)::int FROM logic.pedido_item i WHERE i.pedido_id = p.id) AS renglones,
            (SELECT r.id FROM logic.remito r WHERE r.pedido_id = p.id AND r.estado <> 'anulado') AS remito_id
       FROM logic.pedido p
       JOIN org.sede s ON s.id = p.sede_id
       JOIN org.sede sp ON sp.id = p.proveedora_sede_id
      WHERE ($1::uuid[] IS NULL OR p.sede_id = ANY($1) OR p.proveedora_sede_id = ANY($1))
        AND ($2::text IS NULL OR p.estado = $2)
      ORDER BY p.creado_en DESC LIMIT 300`, [sedes, texto(req.query.estado)]);
  res.json({ ok: true, pedidos: rows.map(p => ({ ...p, nro: nroPedido(p.numero) })) });
}));

async function leerPedidoDoc(c, req, id) {
  const { rows: [p] } = await c.query(
    `SELECT p.*, s.nombre AS sede, sp.nombre AS proveedora,
            (SELECT r.id FROM logic.remito r WHERE r.pedido_id = p.id AND r.estado <> 'anulado') AS remito_id
       FROM logic.pedido p JOIN org.sede s ON s.id = p.sede_id JOIN org.sede sp ON sp.id = p.proveedora_sede_id
      WHERE p.id = $1::uuid`, [id]);
  if (!p) throw new ErrorUsuario('No existe ese pedido.', 404);
  if (!rolEn(req.usuario, p.sede_id) && !rolEn(req.usuario, p.proveedora_sede_id))
    throw new ErrorUsuario('No tenés acceso a ese pedido.', 403);
  return p;
}

r.get('/pedidos/:id', h(async (req, res) => {
  const p = await leerPedidoDoc(pool, req, req.params.id);
  const { rows: items } = await pool.query(
    `SELECT i.id, i.producto_id, pr.codigo, pr.nombre AS producto, pr.unidad_base,
            trim_scale(i.cantidad_base)::text AS cantidad, i.notas
       FROM logic.pedido_item i JOIN logic.producto pr ON pr.id = i.producto_id
      WHERE i.pedido_id = $1 ORDER BY pr.nombre`, [p.id]);
  res.json({ ok: true, pedido: { ...p, nro: nroPedido(p.numero), items } });
}));

async function leerPedido(c, b) {
  const p = {
    sede_id: texto(b.sede_id, { campo: 'la sede que pide', requerido: true }),
    proveedora_sede_id: texto(b.proveedora_sede_id, { campo: 'a quién se le pide', requerido: true }),
    necesario_para: fecha(b.necesario_para, { campo: 'Necesario para' }),
    notas: texto(b.notas),
  };
  if (p.sede_id === p.proveedora_sede_id) throw new ErrorUsuario('Una sede no se hace un pedido a sí misma.');
  p.sede = await sede(c, p.sede_id, 'la sede que pide');
  await sede(c, p.proveedora_sede_id, 'la sede proveedora');
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new ErrorUsuario('El pedido no tiene renglones.');
  p.items = [];
  for (const [i, x] of items.entries()) {
    const productoId = texto(x.producto_id, { campo: `el producto del renglón ${i + 1}`, requerido: true });
    const cantidad = numero(x.cantidad, { campo: `Cantidad del renglón ${i + 1}`, requerido: true, positivo: true });
    const prod = await unidadBase(c, productoId, i);
    p.items.push({ producto_id: productoId, notas: texto(x.notas),
                   cantidad_base: await aBase(c, cantidad, texto(x.unidad), prod.unidad_base, `El renglón ${i + 1}`) });
  }
  return p;
}

async function guardarItemsPedido(c, id, items) {
  await c.query('DELETE FROM logic.pedido_item WHERE pedido_id = $1', [id]);
  for (const x of items)
    await c.query('INSERT INTO logic.pedido_item (pedido_id, producto_id, cantidad_base, notas) VALUES ($1,$2,$3,$4)',
      [id, x.producto_id, x.cantidad_base, x.notas]);
}

r.post('/pedidos', h(async (req, res) => {
  const id = await enTransaccion(async c => {
    const p = await leerPedido(c, req.body);
    exigirOperarEn(req, p.sede_id, p.sede.nombre);
    const { rows: [n] } = await c.query(
      `INSERT INTO logic.pedido (sede_id, proveedora_sede_id, necesario_para, notas) VALUES ($1,$2,$3,$4) RETURNING id`,
      [p.sede_id, p.proveedora_sede_id, p.necesario_para, p.notas]);
    await guardarItemsPedido(c, n.id, p.items);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

r.put('/pedidos/:id', h(async (req, res) => {
  await enTransaccion(async c => {
    const ant = await leerPedidoDoc(c, req, req.params.id);
    if (ant.estado !== 'borrador') throw new ErrorUsuario('El pedido ya fue enviado: no se edita.');
    exigirOperarEn(req, ant.sede_id, ant.sede);
    const p = await leerPedido(c, { ...req.body, sede_id: ant.sede_id });
    await c.query('UPDATE logic.pedido SET proveedora_sede_id=$1, necesario_para=$2, notas=$3 WHERE id=$4',
      [p.proveedora_sede_id, p.necesario_para, p.notas, ant.id]);
    await guardarItemsPedido(c, ant.id, p.items);
  });
  res.json({ ok: true, id: req.params.id });
}));

r.post('/pedidos/:id/enviar', h(async (req, res) => {
  await enTransaccion(async c => {
    const p = await leerPedidoDoc(c, req, req.params.id);
    exigirOperarEn(req, p.sede_id, p.sede);
    if (p.estado !== 'borrador') throw new ErrorUsuario(`El pedido ya está ${p.estado}.`);
    await c.query(`UPDATE logic.pedido SET estado = 'enviado', enviado_en = now(), enviado_por = org.usuario_actual()
                    WHERE id = $1`, [p.id]);
  });
  res.json({ ok: true });
}));

// Anula quien pidió, o el encargado de quien provee (un pedido que no se va a cumplir).
r.post('/pedidos/:id/anular', h(async (req, res) => {
  await enTransaccion(async c => {
    const p = await leerPedidoDoc(c, req, req.params.id);
    if (!['borrador', 'enviado'].includes(p.estado))
      throw new ErrorUsuario(p.estado === 'remitido' ? 'El pedido ya tiene remito: anulá el remito primero.' : `El pedido ya está ${p.estado}.`);
    if (!['admin', 'encargado', 'operador'].includes(rolEn(req.usuario, p.sede_id)))
      exigirEncargadoDe(req, p.proveedora_sede_id, p.proveedora);
    await c.query(`UPDATE logic.pedido SET estado = 'anulado' WHERE id = $1`, [p.id]);
  });
  res.json({ ok: true });
}));

r.delete('/pedidos/:id', h(async (req, res) => {
  await enTransaccion(async c => {
    const p = await leerPedidoDoc(c, req, req.params.id);
    exigirOperarEn(req, p.sede_id, p.sede);
    await c.query('DELETE FROM logic.pedido WHERE id = $1', [p.id]);
  });
  res.json({ ok: true });
}));

// ── Remitos ──────────────────────────────────────────────────────────────────────────────────
r.get('/remitos', h(async (req, res) => {
  const sedes = filtroSedes(req);
  const { rows } = await pool.query(
    `SELECT r.id, r.numero, r.estado, r.creado_en, r.enviado_en, r.recibido_en,
            r.origen_sede_id, so.nombre AS origen, r.destino_sede_id, sd.nombre AS destino,
            p.numero AS pedido_numero,
            (SELECT COUNT(*)::int FROM logic.remito_item i WHERE i.remito_id = r.id) AS renglones,
            (SELECT bool_or(i.cantidad_recibida IS DISTINCT FROM i.cantidad_base)
               FROM logic.remito_item i WHERE i.remito_id = r.id) AND r.estado = 'recibido' AS con_diferencias
       FROM logic.remito r
       JOIN org.sede so ON so.id = r.origen_sede_id
       JOIN org.sede sd ON sd.id = r.destino_sede_id
       LEFT JOIN logic.pedido p ON p.id = r.pedido_id
      WHERE ($1::uuid[] IS NULL OR r.origen_sede_id = ANY($1) OR r.destino_sede_id = ANY($1))
        AND ($2::text IS NULL OR r.estado = $2)
      ORDER BY r.creado_en DESC LIMIT 300`, [sedes, texto(req.query.estado)]);
  res.json({ ok: true, remitos: rows.map(x => ({ ...x, nro: nroRemito(x.numero),
                                                  pedido: x.pedido_numero && nroPedido(x.pedido_numero) })) });
}));

// Las ubicaciones de la sede de destino, para elegir dónde entra la mercadería. Quien despacha no
// tiene por qué ver el stock del local, pero sí sus ubicaciones.
r.get('/remitos/destinos', h(async (req, res) => {
  const s = texto(req.query.sede, { campo: 'la sede de destino', requerido: true });
  const { rows } = await pool.query(
    `SELECT u.id, a.nombre AS almacen, u.nombre, u.tipo FROM logic.ubicacion u JOIN logic.almacen a ON a.id = u.almacen_id
      WHERE a.sede_id = $1::uuid AND a.activo AND u.activa ORDER BY a.nombre, u.nombre`, [s]);
  res.json({ ok: true, ubicaciones: rows });
}));

async function leerRemitoDoc(c, req, id, bloquear = false) {
  const { rows: [x] } = await c.query(
    `SELECT r.*, so.nombre AS origen, sd.nombre AS destino, a.nombre AS origen_almacen,
            ua.nombre || ' · ' || u.nombre AS destino_ubicacion, p.numero AS pedido_numero
       FROM logic.remito r
       JOIN org.sede so ON so.id = r.origen_sede_id
       JOIN org.sede sd ON sd.id = r.destino_sede_id
       JOIN logic.almacen a ON a.id = r.origen_almacen_id
       JOIN logic.ubicacion u ON u.id = r.destino_ubicacion_id
       JOIN logic.almacen ua ON ua.id = u.almacen_id
       LEFT JOIN logic.pedido p ON p.id = r.pedido_id
      WHERE r.id = $1::uuid ${bloquear ? 'FOR UPDATE OF r' : ''}`, [id]);
  if (!x) throw new ErrorUsuario('No existe ese remito.', 404);
  if (!rolEn(req.usuario, x.origen_sede_id) && !rolEn(req.usuario, x.destino_sede_id))
    throw new ErrorUsuario('No tenés acceso a ese remito.', 403);
  return x;
}

async function itemsRemito(c, id) {
  const { rows } = await c.query(
    `SELECT i.id, i.producto_id, pr.codigo, pr.nombre AS producto, pr.unidad_base, pr.perecedero,
            i.lote_id, l.codigo AS lote, l.vencimiento, i.origen_ubicacion_id, u.nombre AS origen_ubicacion,
            trim_scale(i.cantidad_base)::text AS cantidad, trim_scale(i.cantidad_recibida)::text AS recibida,
            trim_scale(i.cantidad_recibida - i.cantidad_base)::text AS diferencia, i.motivo_diferencia,
            trim_scale(pi.cantidad_base)::text AS pedido, i.pedido_item_id
       FROM logic.remito_item i
       JOIN logic.producto pr ON pr.id = i.producto_id
       JOIN logic.ubicacion u ON u.id = i.origen_ubicacion_id
       LEFT JOIN logic.lote l ON l.id = i.lote_id
       LEFT JOIN logic.pedido_item pi ON pi.id = i.pedido_item_id
      WHERE i.remito_id = $1 ORDER BY pr.nombre, l.vencimiento NULLS LAST`, [id]);
  return rows;
}

r.get('/remitos/:id', h(async (req, res) => {
  const x = await leerRemitoDoc(pool, req, req.params.id);
  const items = await itemsRemito(pool, x.id);
  // Lo pedido que no se mandó: se ve en el remito para que el local sepa qué no le llega.
  let sin_enviar = [];
  if (x.pedido_id) ({ rows: sin_enviar } = await pool.query(
    `SELECT pr.nombre AS producto, pr.unidad_base, trim_scale(pi.cantidad_base)::text AS pedido,
            trim_scale(COALESCE(SUM(i.cantidad_base), 0))::text AS enviado
       FROM logic.pedido_item pi JOIN logic.producto pr ON pr.id = pi.producto_id
       LEFT JOIN logic.remito_item i ON i.pedido_item_id = pi.id AND i.remito_id = $2
      WHERE pi.pedido_id = $1 GROUP BY pi.id, pr.nombre, pr.unidad_base
     HAVING COALESCE(SUM(i.cantidad_base), 0) < pi.cantidad_base ORDER BY pr.nombre`, [x.pedido_id, x.id]));
  res.json({ ok: true, remito: { ...x, nro: nroRemito(x.numero), pedido: x.pedido_numero && nroPedido(x.pedido_numero),
    items, sin_enviar,
    puede: { despachar: !!['admin', 'encargado', 'operador'].includes(rolEn(req.usuario, x.origen_sede_id)),
             recibir: !!['admin', 'encargado', 'operador'].includes(rolEn(req.usuario, x.destino_sede_id)),
             anular_enviado: !!['admin', 'encargado'].includes(rolEn(req.usuario, x.origen_sede_id)) } } });
}));

// Renglones del remito: con lote y ubicación elegidos, tal cual; sin ellos, se reparten por FEFO
// en el almacén que despacha. Si no alcanza, se dice qué falta en vez de mandar menos callado.
async function armarRenglones(c, origenAlmacen, items, conFaltantes) {
  const out = [], faltan = [];
  for (const [i, x] of items.entries()) {
    const productoId = texto(x.producto_id, { campo: `el producto del renglón ${i + 1}`, requerido: true });
    const cantidad = numero(x.cantidad, { campo: `Cantidad del renglón ${i + 1}`, requerido: true, positivo: true });
    const prod = await unidadBase(c, productoId, i);
    const base = x.en_base ? cantidad : await aBase(c, cantidad, texto(x.unidad), prod.unidad_base, `El renglón ${i + 1}`);
    const lote = texto(x.lote_id), ubic = texto(x.origen_ubicacion_id);
    if (ubic && (lote || !prod.perecedero)) {
      out.push({ producto_id: productoId, lote_id: lote, origen_ubicacion_id: ubic, cantidad_base: base,
                 pedido_item_id: texto(x.pedido_item_id) });
      continue;
    }
    const f = await fefo(c, productoId, origenAlmacen, base);
    for (const l of f.lineas)
      out.push({ producto_id: productoId, lote_id: l.lote_id, origen_ubicacion_id: l.ubicacion_id, cantidad_base: l.tomar,
                 pedido_item_id: texto(x.pedido_item_id) });
    if (!esCero(f.faltante)) faltan.push(`${prod.nombre} (faltan ${limpiar(f.faltante)} ${prod.unidad_base})`);
  }
  if (faltan.length && !conFaltantes)
    throw new ErrorUsuario('No alcanza el stock del almacén que despacha: ' + faltan.join(', ') + '.');
  return { renglones: out, faltan };
}

async function guardarRenglones(c, remitoId, renglones) {
  await c.query('DELETE FROM logic.remito_item WHERE remito_id = $1', [remitoId]);
  for (const x of renglones)
    await c.query(
      `INSERT INTO logic.remito_item (remito_id, producto_id, lote_id, origen_ubicacion_id, cantidad_base, pedido_item_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [remitoId, x.producto_id, x.lote_id, x.origen_ubicacion_id, x.cantidad_base, x.pedido_item_id]);
}

async function leerCabecera(c, b) {
  const origenAlmacen = texto(b.origen_almacen_id, { campo: 'el almacén que despacha', requerido: true });
  const { rows: [a] } = await c.query(
    `SELECT a.id, a.sede_id, s.nombre AS sede FROM logic.almacen a JOIN org.sede s ON s.id = a.sede_id
      WHERE a.id = $1::uuid AND a.activo AND s.activa`, [origenAlmacen]);
  if (!a) throw new ErrorUsuario('El almacén que despacha no existe o está inactivo.');
  const destinoSede = texto(b.destino_sede_id, { campo: 'la sede de destino', requerido: true });
  if (destinoSede === a.sede_id) throw new ErrorUsuario('El destino es la misma sede: para eso es un traslado común.');
  await sede(c, destinoSede, 'la sede de destino');
  let destinoUbic = texto(b.destino_ubicacion_id);
  if (!destinoUbic) {
    // Sin ubicación elegida: la primera activa del local. La puede cambiar quien recibe con un traslado.
    const { rows: [u] } = await c.query(
      `SELECT u.id FROM logic.ubicacion u JOIN logic.almacen al ON al.id = u.almacen_id
        WHERE al.sede_id = $1::uuid AND al.activo AND u.activa ORDER BY al.nombre, u.nombre LIMIT 1`, [destinoSede]);
    if (!u) throw new ErrorUsuario('La sede de destino no tiene ninguna ubicación activa donde recibir.');
    destinoUbic = u.id;
  }
  return { origen_almacen_id: a.id, origen_sede_id: a.sede_id, origen: a.sede, destino_sede_id: destinoSede,
           destino_ubicacion_id: destinoUbic, notas: texto(b.notas) };
}

r.post('/remitos', h(async (req, res) => {
  const id = await enTransaccion(async c => {
    const cab = await leerCabecera(c, req.body);
    exigirOperarEn(req, cab.origen_sede_id, cab.origen);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) throw new ErrorUsuario('El remito no tiene renglones.');
    const { renglones } = await armarRenglones(c, cab.origen_almacen_id, items, false);
    const { rows: [n] } = await c.query(
      `INSERT INTO logic.remito (origen_sede_id, origen_almacen_id, destino_sede_id, destino_ubicacion_id, notas)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [cab.origen_sede_id, cab.origen_almacen_id, cab.destino_sede_id, cab.destino_ubicacion_id, cab.notas]);
    await guardarRenglones(c, n.id, renglones);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

r.put('/remitos/:id', h(async (req, res) => {
  await enTransaccion(async c => {
    const ant = await leerRemitoDoc(c, req, req.params.id, true);
    if (ant.estado !== 'borrador') throw new ErrorUsuario('El remito ya fue despachado: no se edita.');
    exigirOperarEn(req, ant.origen_sede_id, ant.origen);
    const cab = await leerCabecera(c, { ...req.body, destino_sede_id: req.body.destino_sede_id || ant.destino_sede_id });
    if (cab.origen_sede_id !== ant.origen_sede_id) throw new ErrorUsuario('El remito no cambia de sede de origen.');
    if (ant.pedido_id && cab.destino_sede_id !== ant.destino_sede_id)
      throw new ErrorUsuario('El remito sale de un pedido: el destino es la sede que pidió.');
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) throw new ErrorUsuario('El remito no tiene renglones.');
    const { renglones } = await armarRenglones(c, cab.origen_almacen_id, items, false);
    await c.query('UPDATE logic.remito SET origen_almacen_id=$1, destino_sede_id=$2, destino_ubicacion_id=$3, notas=$4 WHERE id=$5',
      [cab.origen_almacen_id, cab.destino_sede_id, cab.destino_ubicacion_id, cab.notas, ant.id]);
    await guardarRenglones(c, ant.id, renglones);
  });
  res.json({ ok: true, id: req.params.id });
}));

r.delete('/remitos/:id', h(async (req, res) => {
  await enTransaccion(async c => {
    const x = await leerRemitoDoc(c, req, req.params.id, true);
    exigirOperarEn(req, x.origen_sede_id, x.origen);
    if (x.estado !== 'borrador') throw new ErrorUsuario('Sólo se borra un remito en borrador; uno despachado se anula.');
    await c.query('DELETE FROM logic.remito WHERE id = $1', [x.id]);
    if (x.pedido_id) await c.query(`UPDATE logic.pedido SET estado = 'enviado' WHERE id = $1 AND estado = 'remitido'`, [x.pedido_id]);
  });
  res.json({ ok: true });
}));

// Del pedido al remito: un renglón por lote, por FEFO. Lo que no alcanza no frena: se arma con lo
// que hay y se avisa qué queda sin mandar (es lo normal con un pedido; el remito se puede editar).
r.post('/pedidos/:id/remito', h(async (req, res) => {
  const out = await enTransaccion(async c => {
    const p = await leerPedidoDoc(c, req, req.params.id);
    if (p.estado !== 'enviado') throw new ErrorUsuario(p.estado === 'remitido' ? 'El pedido ya tiene remito.' : `El pedido está ${p.estado}.`);
    await c.query('SELECT 1 FROM logic.pedido WHERE id = $1 FOR UPDATE', [p.id]);
    const cab = await leerCabecera(c, { ...req.body, destino_sede_id: p.sede_id });
    if (cab.origen_sede_id !== p.proveedora_sede_id)
      throw new ErrorUsuario(`El pedido es para ${p.proveedora}: despachalo desde un almacén de esa sede.`);
    exigirOperarEn(req, cab.origen_sede_id, cab.origen);
    const { rows: items } = await c.query(
      'SELECT id AS pedido_item_id, producto_id, cantidad_base::text AS cantidad FROM logic.pedido_item WHERE pedido_id = $1', [p.id]);
    const { renglones, faltan } = await armarRenglones(c, cab.origen_almacen_id, items.map(x => ({ ...x, en_base: true })), true);
    if (!renglones.length) throw new ErrorUsuario('No hay stock de nada de lo pedido en ese almacén.');
    const { rows: [n] } = await c.query(
      `INSERT INTO logic.remito (origen_sede_id, origen_almacen_id, destino_sede_id, destino_ubicacion_id, pedido_id, notas)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [cab.origen_sede_id, cab.origen_almacen_id, cab.destino_sede_id, cab.destino_ubicacion_id, p.id,
       cab.notas || `Pedido ${nroPedido(p.numero)}`]);
    await guardarRenglones(c, n.id, renglones);
    await c.query(`UPDATE logic.pedido SET estado = 'remitido' WHERE id = $1`, [p.id]);
    return { id: n.id, faltan };
  });
  res.status(201).json({ ok: true, ...out });
}));

// ── Despachar ────────────────────────────────────────────────────────────────────────────────
// Con los productos bloqueados, se verifica que cada lote tenga en su ubicación lo que el remito
// dice (el stock puede haber cambiado desde que se armó) y se asientan los traslados al local.
r.post('/remitos/:id/enviar', h(async (req, res) => {
  await enTransaccion(async c => {
    const x = await leerRemitoDoc(c, req, req.params.id, true);
    exigirOperarEn(req, x.origen_sede_id, x.origen);
    if (x.estado !== 'borrador') throw new ErrorUsuario(`El remito ya está ${x.estado}.`);
    await c.query(
      `SELECT logic.bloquear_stock(producto_id) FROM
         (SELECT DISTINCT producto_id FROM logic.remito_item WHERE remito_id = $1 ORDER BY producto_id) t`, [x.id]);
    const { rows: cortos } = await c.query(
      `SELECT pr.nombre, l.codigo AS lote, u.nombre AS ubicacion, pr.unidad_base,
              trim_scale(SUM(i.cantidad_base))::text AS pide, trim_scale(COALESCE(MAX(s.cantidad), 0))::text AS hay
         FROM logic.remito_item i
         JOIN logic.producto pr ON pr.id = i.producto_id
         JOIN logic.ubicacion u ON u.id = i.origen_ubicacion_id
         LEFT JOIN logic.lote l ON l.id = i.lote_id
         LEFT JOIN logic.stock s ON s.producto_id = i.producto_id AND s.ubicacion_id = i.origen_ubicacion_id
                                AND s.lote_id IS NOT DISTINCT FROM i.lote_id
        WHERE i.remito_id = $1
        GROUP BY pr.nombre, l.codigo, u.nombre, pr.unidad_base, i.producto_id, i.origen_ubicacion_id, i.lote_id
       HAVING SUM(i.cantidad_base) > COALESCE(MAX(s.cantidad), 0)`, [x.id]);
    if (cortos.length)
      throw new ErrorUsuario('El stock cambió desde que se armó el remito: ' +
        cortos.map(k => `${k.nombre}${k.lote ? ' lote ' + k.lote : ''} en ${k.ubicacion} (pide ${limpiar(k.pide)}, hay ${limpiar(k.hay)} ${k.unidad_base})`).join('; ') +
        '. Editá el remito.');
    const ref = nroRemito(x.numero);
    await c.query(
      `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, origen_id, destino_id, remito_id, referencia, motivo)
       SELECT 'traslado', i.producto_id, i.lote_id, i.cantidad_base, i.origen_ubicacion_id, $2, $1, $3, 'Remito ' || $3 || ' a ' || $4
         FROM logic.remito_item i WHERE i.remito_id = $1`, [x.id, x.destino_ubicacion_id, ref, x.destino]);
    await c.query(`UPDATE logic.remito SET estado = 'enviado', enviado_en = now(), enviado_por = org.usuario_actual() WHERE id = $1`, [x.id]);
  });
  res.json({ ok: true });
}));

// ── Recibir ──────────────────────────────────────────────────────────────────────────────────
// El local confirma renglón por renglón. Sin dato, se toma que llegó lo despachado. Una diferencia
// necesita motivo: un faltante sale de la ubicación de destino como merma del remito; un sobrante
// entra como ajuste. Así el remito cierra y la diferencia queda explicada y firmada.
r.post('/remitos/:id/recibir', h(async (req, res) => {
  const porItem = new Map((Array.isArray(req.body.items) ? req.body.items : []).map(i => [i.id, i]));
  const out = await enTransaccion(async c => {
    const x = await leerRemitoDoc(c, req, req.params.id, true);
    exigirOperarEn(req, x.destino_sede_id, x.destino);
    if (x.estado !== 'enviado') throw new ErrorUsuario(x.estado === 'borrador' ? 'El remito todavía no se despachó.' : `El remito ya está ${x.estado}.`);
    const items = await itemsRemito(c, x.id);
    const ref = nroRemito(x.numero);
    let diferencias = 0;
    for (const it of items) {
      const dato = porItem.get(it.id) || {};
      const recibida = numero(dato.recibida, { campo: `Recibido de ${it.producto}` }) ?? it.cantidad;
      const motivo = texto(dato.motivo);
      const { rows: [d] } = await c.query(
        `SELECT ($1::numeric - $2::numeric)::numeric(16,4)::text AS dif, sign($1::numeric - $2::numeric)::int AS signo,
                abs($1::numeric - $2::numeric)::numeric(16,4)::text AS abs`, [recibida, it.cantidad]);
      if (d.signo !== 0) {
        diferencias++;
        if (!motivo) throw new ErrorUsuario(`${it.producto}${it.lote ? ' lote ' + it.lote : ''}: hay diferencia, falta el motivo.`);
        if (d.signo < 0)
          await c.query(
            `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, origen_id, remito_id, referencia, motivo)
             VALUES ('merma', $1, $2, $3, $4, $5, $6, $7)`,
            [it.producto_id, it.lote_id, d.abs, x.destino_ubicacion_id, x.id, ref, `Faltante del remito ${ref}: ${motivo}`]);
        else
          await c.query(
            `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, destino_id, remito_id, referencia, motivo)
             VALUES ('ajuste', $1, $2, $3, $4, $5, $6, $7)`,
            [it.producto_id, it.lote_id, d.abs, x.destino_ubicacion_id, x.id, ref, `Sobrante del remito ${ref}: ${motivo}`]);
      }
      await c.query('UPDATE logic.remito_item SET cantidad_recibida = $1, motivo_diferencia = $2 WHERE id = $3',
        [recibida, d.signo !== 0 ? motivo : null, it.id]);
    }
    await c.query(`UPDATE logic.remito SET estado = 'recibido', recibido_en = now(), recibido_por = org.usuario_actual() WHERE id = $1`, [x.id]);
    return { diferencias };
  });
  res.json({ ok: true, ...out });
}));

// ── Anular ───────────────────────────────────────────────────────────────────────────────────
// En borrador, lo anula quien despacha. Despachado y sin recibir, sólo el encargado de origen: se
// asientan los traslados de vuelta (la mercadería vuelve a su ubicación de origen). Recibido no
// se anula: se arma un remito de devolución.
r.post('/remitos/:id/anular', h(async (req, res) => {
  const motivo = texto(req.body.motivo, { campo: 'el motivo de la anulación', requerido: true });
  await enTransaccion(async c => {
    const x = await leerRemitoDoc(c, req, req.params.id, true);
    if (x.estado === 'recibido') throw new ErrorUsuario('El remito ya se recibió: para devolver mercadería, armá un remito en sentido contrario.');
    if (x.estado === 'anulado') throw new ErrorUsuario('El remito ya está anulado.');
    if (x.estado === 'enviado') {
      exigirEncargadoDe(req, x.origen_sede_id, x.origen);
      const ref = nroRemito(x.numero);
      await c.query(
        `INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, origen_id, destino_id, remito_id, referencia, motivo)
         SELECT 'traslado', i.producto_id, i.lote_id, i.cantidad_base, $2, i.origen_ubicacion_id, $1, $3, $4
           FROM logic.remito_item i WHERE i.remito_id = $1`,
        [x.id, x.destino_ubicacion_id, ref, `Anulación del remito ${ref}: ${motivo}`]);
    } else {
      exigirOperarEn(req, x.origen_sede_id, x.origen);
    }
    await c.query(`UPDATE logic.remito SET estado = 'anulado', anulado_en = now(), anulado_por = org.usuario_actual(),
                          motivo_anulacion = $2 WHERE id = $1`, [x.id, motivo]);
    if (x.pedido_id) await c.query(`UPDATE logic.pedido SET estado = 'enviado' WHERE id = $1 AND estado = 'remitido'`, [x.pedido_id]);
  });
  res.json({ ok: true });
}));

module.exports = r;
