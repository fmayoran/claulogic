// API de identificación: lectura de códigos (GS1, SKU o lote), ficha de trazabilidad de un lote
// y datos para imprimir etiquetas con QR GS1 Digital Link o EAN-13.
const express = require('express');
const bwipjs = require('bwip-js');
const { pool } = require('./db');
const gs1 = require('./gs1');
const { ErrorUsuario, texto, h } = require('./util');

const r = express.Router();

// La URL pública del sistema, que es lo que va dentro de cada QR. Si no está configurada, la del
// pedido (detrás de Traefik llega como https gracias a `trust proxy`).
const baseUrl = req => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

const PRODUCTO = `p.id, p.codigo AS sku, p.nombre, p.unidad_base, p.perecedero, p.vida_util_dias`;

async function porGtin(gtin) {
  const { rows: [g] } = await pool.query(
    `SELECT g.gtin, g.origen, ${PRODUCTO},
            pr.id AS presentacion_id, pr.nombre AS presentacion, trim_scale(pr.cantidad_base)::text AS cantidad_base
       FROM logic.gtin g
       JOIN logic.producto p ON p.id = g.producto_id
       LEFT JOIN logic.presentacion pr ON pr.id = g.presentacion_id
      WHERE g.gtin = $1`, [gtin]);
  return g;
}

async function lotePorCodigo(productoId, codigo) {
  const { rows: [l] } = await pool.query(
    'SELECT id, codigo, vencimiento FROM logic.lote WHERE producto_id = $1 AND codigo = $2', [productoId, codigo]);
  return l || null;
}

// ── Lectura ──────────────────────────────────────────────────────────────────────────────────
// Lo que devuelve sirve para completar formularios: el producto, la presentación (si el código
// era de un empaque, con cuánto contiene), el lote si ya existe, y lo leído del código aunque el
// lote todavía no exista (es lo que pasa al recibir mercadería).
r.get('/gs1/leer', h(async (req, res) => {
  const codigo = texto(req.query.codigo, { campo: 'el código', requerido: true });
  let lectura;
  try { lectura = gs1.leer(codigo); }
  catch (e) { throw new ErrorUsuario(e.message); }

  if (lectura.formato === 'texto') {
    // No es GS1: puede ser un SKU o un código de lote.
    const { rows: [p] } = await pool.query(`SELECT ${PRODUCTO} FROM logic.producto p WHERE upper(p.codigo) = upper($1)`, [lectura.texto]);
    if (p) return res.json({ ok: true, lectura, producto: p });
    const { rows: lotes } = await pool.query(
      `SELECT l.id AS lote_id, l.codigo AS lote_codigo, l.vencimiento AS lote_vencimiento, ${PRODUCTO}
         FROM logic.lote l JOIN logic.producto p ON p.id = l.producto_id WHERE l.codigo = $1`, [lectura.texto]);
    if (lotes.length === 1) {
      const { lote_id, lote_codigo, lote_vencimiento, ...prod } = lotes[0];
      return res.json({ ok: true, lectura, producto: prod, lote: { id: lote_id, codigo: lote_codigo, vencimiento: lote_vencimiento } });
    }
    if (lotes.length > 1) throw new ErrorUsuario(`Hay ${lotes.length} productos con un lote "${lectura.texto}": escaneá el código del producto.`);
    throw new ErrorUsuario(`"${lectura.texto}" no es un código GS1 ni coincide con ningún SKU o lote.`);
  }

  const g = await porGtin(lectura.gtin);
  if (!g) return res.json({ ok: true, lectura, desconocido: true });
  const { gtin, origen, presentacion_id, presentacion, cantidad_base, ...producto } = g;
  const lote = lectura.lote ? await lotePorCodigo(producto.id, lectura.lote) : null;
  res.json({ ok: true, lectura, producto, origen,
             presentacion: presentacion_id ? { id: presentacion_id, nombre: presentacion, cantidad_base } : null,
             lote });
}));

// Para el Digital Link: de GTIN + código de lote al id del lote.
r.get('/lotes/buscar', h(async (req, res) => {
  const gtin = gs1.normalizarGtin(texto(req.query.gtin, { campo: 'el GTIN', requerido: true }));
  if (!gtin) throw new ErrorUsuario('GTIN inválido.');
  const g = await porGtin(gtin);
  if (!g) return res.status(404).json({ ok: false, error: 'Ningún producto tiene ese GTIN.' });
  const lote = req.query.lote ? await lotePorCodigo(g.id, req.query.lote) : null;
  res.json({ ok: true, producto_id: g.id, producto: g.nombre, unidad_base: g.unidad_base, lote_id: lote && lote.id });
}));

// ── Ficha de trazabilidad ────────────────────────────────────────────────────────────────────
// Hacia atrás: de qué compra (proveedor, remito) o de qué producción (con qué lotes) salió.
// Hacia adelante: en qué producciones se usó y qué lotes de elaborado salieron. Es lo que hay que
// poder contestar en minutos el día que hay un problema sanitario con una partida.
r.get('/lotes/:id', h(async (req, res) => {
  const { rows: [l] } = await pool.query(
    `SELECT l.id, l.codigo, l.vencimiento, l.recibido_en, l.notas, pv.nombre AS proveedor,
            p.id AS producto_id, p.codigo AS sku, p.nombre, p.unidad_base, p.perecedero, g.gtin
       FROM logic.lote l
       JOIN logic.producto p ON p.id = l.producto_id
       LEFT JOIN logic.proveedor pv ON pv.id = l.proveedor_id
       LEFT JOIN logic.gtin g ON g.producto_id = p.id AND g.presentacion_id IS NULL
      WHERE l.id = $1`, [req.params.id]);
  if (!l) return res.status(404).json({ ok: false, error: 'No existe ese lote.' });
  const [compra, produccion, stock, movimientos, usos] = await Promise.all([
    pool.query(
      `SELECT c.id, c.numero, c.fecha, c.recibida_en, pv.nombre AS proveedor
         FROM logic.movimiento m
         JOIN logic.compra_item ci ON ci.id = m.compra_item_id
         JOIN logic.compra c ON c.id = ci.compra_id
         JOIN logic.proveedor pv ON pv.id = c.proveedor_id
        WHERE m.lote_id = $1 AND m.tipo = 'compra' LIMIT 1`, [l.id]),
    pool.query(
      `SELECT pr.id, pr.fecha, re.nombre AS receta,
              COALESCE(json_agg(json_build_object(
                'producto', ip.nombre, 'unidad_base', ip.unidad_base, 'lote_id', il.id, 'lote', il.codigo,
                'vencimiento', il.vencimiento, 'cantidad', trim_scale(m.cantidad_base)::text)
                ORDER BY ip.nombre) FILTER (WHERE m.id IS NOT NULL), '[]') AS consumos
         FROM logic.produccion pr
         JOIN logic.receta re ON re.id = pr.receta_id
         LEFT JOIN logic.movimiento m ON m.produccion_id = pr.id AND m.tipo = 'consumo'
         LEFT JOIN logic.producto ip ON ip.id = m.producto_id
         LEFT JOIN logic.lote il ON il.id = m.lote_id
        WHERE pr.lote_salida_id = $1
        GROUP BY pr.id, re.nombre`, [l.id]),
    pool.query(
      `SELECT u.nombre AS ubicacion, a.nombre AS almacen, trim_scale(s.cantidad)::text AS cantidad
         FROM logic.stock s JOIN logic.ubicacion u ON u.id = s.ubicacion_id JOIN logic.almacen a ON a.id = u.almacen_id
        WHERE s.lote_id = $1 ORDER BY a.nombre, u.nombre`, [l.id]),
    pool.query(
      `SELECT id, ocurrido_en, tipo, sentido, trim_scale(cantidad_base)::text AS cantidad,
              origen, origen_almacen, destino, destino_almacen, motivo, referencia, anula_a, anulado_por
         FROM logic.historial_movimiento WHERE lote_id = $1 ORDER BY ocurrido_en, id`, [l.id]),
    pool.query(
      `SELECT pr.id, pr.fecha, re.nombre AS receta, ep.nombre AS elaborado, el.id AS lote_id, el.codigo AS lote,
              el.vencimiento, trim_scale(SUM(m.cantidad_base))::text AS cantidad
         FROM logic.movimiento m
         JOIN logic.produccion pr ON pr.id = m.produccion_id
         JOIN logic.receta re ON re.id = pr.receta_id
         JOIN logic.producto ep ON ep.id = re.producto_id
         LEFT JOIN logic.lote el ON el.id = pr.lote_salida_id
        WHERE m.lote_id = $1 AND m.tipo = 'consumo'
        GROUP BY pr.id, re.nombre, ep.nombre, el.id ORDER BY pr.fecha`, [l.id]),
  ]);
  res.json({ ok: true, lote: {
    ...l, url: l.gtin ? gs1.digitalLink(baseUrl(req), { gtin: l.gtin, lote: l.codigo, vencimiento: l.vencimiento }) : null,
    compra: compra.rows[0] || null, produccion: produccion.rows[0] || null,
    stock: stock.rows, movimientos: movimientos.rows, usado_en: usos.rows,
  } });
}));

// ── Etiquetas ────────────────────────────────────────────────────────────────────────────────
// El SVG se arma en el servidor (bwip-js): así la etiqueta no depende de una librería en el
// navegador y el código que se imprime es exactamente el que la app sabe leer.
function svg(opciones) {
  try { return bwipjs.toSVG(opciones); }
  catch (e) { throw new ErrorUsuario('No se pudo generar el código: ' + e.message); }
}

// Etiqueta de lote: QR con GS1 Digital Link (GTIN interno del producto + lote + vencimiento).
// La zona de silencio del QR son 4 módulos por lado; en bwip `padding` va en medios módulos.
r.get('/etiquetas/lote/:id', h(async (req, res) => {
  const { rows: [l] } = await pool.query(
    `SELECT l.codigo AS lote, l.vencimiento, p.nombre, p.codigo AS sku, g.gtin
       FROM logic.lote l
       JOIN logic.producto p ON p.id = l.producto_id
       JOIN logic.gtin g ON g.producto_id = p.id AND g.presentacion_id IS NULL
      WHERE l.id = $1`, [req.params.id]);
  if (!l) return res.status(404).json({ ok: false, error: 'No existe ese lote.' });
  const datos = { gtin: l.gtin, lote: l.lote, vencimiento: l.vencimiento };
  const url = gs1.digitalLink(baseUrl(req), datos);
  res.json({ ok: true, etiqueta: { ...l, url, legible: gs1.legible(datos),
    svg: svg({ bcid: 'qrcode', text: url, eclevel: 'M', padding: 8, backgroundcolor: 'FFFFFF' }) } });
}));

// Etiqueta de producto (góndola, estantería): EAN-13 con el GTIN interno y QR Digital Link.
r.get('/etiquetas/producto/:id', h(async (req, res) => {
  const { rows: [p] } = await pool.query(
    `SELECT p.nombre, p.codigo AS sku, g.gtin
       FROM logic.producto p JOIN logic.gtin g ON g.producto_id = p.id AND g.presentacion_id IS NULL
      WHERE p.id = $1`, [req.params.id]);
  if (!p) return res.status(404).json({ ok: false, error: 'No existe ese producto.' });
  res.json({ ok: true, etiqueta: { ...p, gtin13: p.gtin.slice(1),
    // La zona de silencio (margen blanco a los costados) es parte del símbolo: sin ella los
    // lectores no encuentran el comienzo de las barras. Va en el propio SVG.
    svg: svg({ bcid: 'ean13', text: p.gtin.slice(1), includetext: true, textsize: 9, height: 12,
               paddingleft: 11, paddingright: 7, backgroundcolor: 'FFFFFF' }),
    qr: svg({ bcid: 'qrcode', text: gs1.digitalLink(baseUrl(req), { gtin: p.gtin }), eclevel: 'M', padding: 8, backgroundcolor: 'FFFFFF' }) } });
}));

module.exports = r;
