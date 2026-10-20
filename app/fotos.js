// Fotos de producto: una por producto, con su miniatura para las listas. Propia (sacada o subida
// desde el celular, achicada en el navegador) o copiada de Open Food Facts con su atribución.
const express = require('express');
const { pool } = require('./db');
const gs1 = require('./gs1');
const { ErrorUsuario, h } = require('./util');

const r = express.Router();

const MAX_FOTO = 1048576, MAX_MINI = 65536;
const ATRIBUCION_OFF = 'Open Food Facts (CC BY-SA)';
// Sólo se descarga de acá: la URL sale de la caché del catálogo, nunca del navegador, y además
// se exige el host. Así el servidor no puede usarse para pedir cualquier dirección.
const HOST_OFF = 'images.openfoodfacts.org';

// El tipo se decide por el contenido, no por lo que diga quien sube el archivo: sólo imágenes
// de mapa de bits. Un SVG o un HTML servido desde la app podría ejecutar código en ella.
function tipoImagen(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function decodificar(b64, max, campo) {
  if (typeof b64 !== 'string' || !b64) throw new ErrorUsuario(`Falta ${campo}.`);
  const b = Buffer.from(b64, 'base64');
  if (!tipoImagen(b)) throw new ErrorUsuario(`${campo}: no es una imagen JPEG, PNG o WebP.`);
  if (b.length > max) throw new ErrorUsuario(`${campo} es demasiado grande.`);
  return b;
}

async function guardar(productoId, f) {
  const { rowCount } = await pool.query(
    `INSERT INTO logic.producto_foto (producto_id, datos, miniatura, origen, atribucion, fuente_url)
     SELECT id, $2, $3, $4, $5, $6 FROM logic.producto WHERE id = $1
     ON CONFLICT (producto_id) DO UPDATE SET datos = EXCLUDED.datos, miniatura = EXCLUDED.miniatura,
       origen = EXCLUDED.origen, atribucion = EXCLUDED.atribucion, fuente_url = EXCLUDED.fuente_url,
       actualizado_en = now()`,
    [productoId, f.datos, f.miniatura, f.origen, f.atribucion || null, f.fuente_url || null]);
  if (!rowCount) throw new ErrorUsuario('No existe ese producto.');
}

async function descargar(url, max) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== HOST_OFF) throw new Error('origen de imagen no permitido');
  // Su servidor de imágenes puede tardar varios segundos en el saludo TLS: se le da margen.
  const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const b = Buffer.from(await res.arrayBuffer());
  if (b.length > max || !tipoImagen(b)) throw new Error('imagen inválida');
  return b;
}

// La URL lleva ?v=<versión>: cuando la foto cambia, cambia la URL, así que se puede cachear para siempre.
r.get('/productos/:id/foto', h(async (req, res) => {
  const col = req.query.mini ? 'miniatura' : 'datos';
  const { rows: [f] } = await pool.query(`SELECT ${col} AS b FROM logic.producto_foto WHERE producto_id = $1`, [req.params.id]);
  if (!f) return res.status(404).json({ ok: false, error: 'Ese producto no tiene foto.' });
  res.set({ 'Content-Type': tipoImagen(f.b), 'X-Content-Type-Options': 'nosniff',
            'Cache-Control': req.query.v ? 'private, max-age=31536000, immutable' : 'no-cache' });
  res.send(f.b);
}));

r.put('/productos/:id/foto', h(async (req, res) => {
  await guardar(req.params.id, { origen: 'propia',
    datos: decodificar(req.body.datos, MAX_FOTO, 'La foto'),
    miniatura: decodificar(req.body.miniatura, MAX_MINI, 'La miniatura') });
  res.json({ ok: true });
}));

// Copia la foto que Open Food Facts tiene para un GTIN ya consultado. Normalmente ya está bajada
// en la caché (la trajo la vista previa); si no, se descarga ahora.
r.post('/productos/:id/foto/catalogo', h(async (req, res) => {
  const gtin = gs1.normalizarGtin(String(req.body.gtin || ''));
  if (!gtin) throw new ErrorUsuario('GTIN inválido.');
  const { rows: [c] } = await pool.query(
    'SELECT imagen_url, miniatura_url, imagen, miniatura FROM logic.catalogo_externo WHERE gtin = $1 AND encontrado', [gtin]);
  if (!c || !c.imagen_url) throw new ErrorUsuario('Open Food Facts no tiene foto para ese código.');
  let datos = c.imagen, miniatura = c.miniatura;
  if (!datos || !miniatura) {
    try { [datos, miniatura] = await bajarCatalogo(gtin, c); }
    catch (e) { throw new ErrorUsuario('No se pudo descargar la foto de Open Food Facts. Probá de nuevo más tarde.'); }
  }
  await guardar(req.params.id, { origen: 'openfoodfacts', datos, miniatura, atribucion: ATRIBUCION_OFF,
    fuente_url: `https://world.openfoodfacts.org/product/${gtin.replace(/^0/, '')}` });
  res.json({ ok: true });
}));

r.delete('/productos/:id/foto', h(async (req, res) => {
  await pool.query('DELETE FROM logic.producto_foto WHERE producto_id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Baja la foto y la miniatura de un GTIN del catálogo y las deja en la caché.
async function bajarCatalogo(gtin, c) {
  const par = await Promise.all([descargar(c.imagen_url, MAX_FOTO), descargar(c.miniatura_url || c.imagen_url, MAX_MINI)]);
  await pool.query('UPDATE logic.catalogo_externo SET imagen = $2, miniatura = $3 WHERE gtin = $1', [gtin, ...par]);
  return par;
}

module.exports = r;
module.exports.bajarCatalogo = bajarCatalogo;
