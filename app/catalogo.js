// Catálogo externo: datos básicos de un GTIN de fabricante tomados de Open Food Facts, para
// precompletar el alta de un producto. Es una sugerencia que el encargado revisa: nunca se guarda
// sola en el producto.
//
// Open Food Facts es una base abierta cargada por la comunidad: tiene bien cubiertos los productos
// masivos de góndola y casi nada de envases institucionales o frescos. Si no responde a tiempo se
// sigue sin datos, como si no existiera.
const express = require('express');
const { pool } = require('./db');
const gs1 = require('./gs1');
const { ErrorUsuario, h } = require('./util');

const r = express.Router();

const FUENTE = 'openfoodfacts';
const ESPERA_MS = 3000;
// Un código no encontrado se vuelve a consultar a los 30 días; uno encontrado, a los 180.
const VIGENCIA = { true: '180 days', false: '30 days' };
// Open Food Facts pide identificar la aplicación. Va la URL pública, no datos de una persona.
const AGENTE = 'ClauLogic/1.0 (+https://claulogic.clausina.ar)';

// "500 g", "1,5 l", "6 x 1 l" (se toma el total si está, si no el último), "250cc".
const UNIDADES = { g: 'g', gr: 'g', grs: 'g', gramos: 'g', kg: 'kg', ml: 'ml', cc: 'ml', l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l' };
function leerContenido(p) {
  const u = UNIDADES[String(p.product_quantity_unit || '').toLowerCase()];
  if (u && /^\d+(\.\d+)?$/.test(String(p.product_quantity))) return { cantidad: String(p.product_quantity), unidad: u };
  const m = String(p.quantity || '').toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(kg|grs|gramos|gr|g|ml|cc|lts|litros|litro|lt|l)\b/);
  if (!m) return { cantidad: null, unidad: null };
  return { cantidad: m[1].replace(',', '.'), unidad: UNIDADES[m[2]] };
}

async function consultar(gtin) {
  // Open Food Facts indexa por el código tal como está impreso: EAN-13 sin el cero de relleno.
  const codigo = gtin.startsWith('0') ? gtin.slice(1) : gtin;
  const campos = 'product_name,product_name_es,brands,quantity,product_quantity,product_quantity_unit,categories_tags_es,categories_tags';
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${codigo}.json?fields=${campos}`,
    { headers: { 'User-Agent': AGENTE }, signal: AbortSignal.timeout(ESPERA_MS) });
  if (res.status === 404) return { encontrado: false };
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const p = j.status === 1 && j.product;
  const nombre = p && (p.product_name_es || p.product_name || '').trim();
  if (!nombre) return { encontrado: false };
  const marca = (p.brands || '').split(',')[0].trim() || null;
  const cats = p.categories_tags_es || p.categories_tags || [];
  return { encontrado: true, nombre, marca, contenido: (p.quantity || '').trim() || null,
           ...leerContenido(p), categoria: cats.length ? cats[cats.length - 1].replace(/^\w\w:/, '') : null };
}

r.get('/catalogo/:gtin', h(async (req, res) => {
  const gtin = gs1.normalizarGtin(req.params.gtin);
  if (!gtin) throw new ErrorUsuario('GTIN inválido.');
  const { rows: [c] } = await pool.query(
    `SELECT encontrado, nombre, marca, contenido, trim_scale(cantidad)::text AS cantidad, unidad, categoria
       FROM logic.catalogo_externo
      WHERE gtin = $1 AND consultado_en > now() - CASE WHEN encontrado THEN $2 ELSE $3 END::interval`,
    [gtin, VIGENCIA.true, VIGENCIA.false]);
  if (c) return res.json({ ok: true, fuente: FUENTE, catalogo: c.encontrado ? c : null });

  let d;
  // Sin respuesta de afuera no se guarda nada: la próxima vez se vuelve a intentar.
  try { d = await consultar(gtin); }
  catch (e) { return res.json({ ok: true, fuente: FUENTE, catalogo: null, sin_respuesta: true }); }
  await pool.query(
    `INSERT INTO logic.catalogo_externo (gtin, fuente, encontrado, nombre, marca, contenido, cantidad, unidad, categoria)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (gtin) DO UPDATE SET fuente = EXCLUDED.fuente, encontrado = EXCLUDED.encontrado,
       nombre = EXCLUDED.nombre, marca = EXCLUDED.marca, contenido = EXCLUDED.contenido, cantidad = EXCLUDED.cantidad,
       unidad = EXCLUDED.unidad, categoria = EXCLUDED.categoria, consultado_en = now()`,
    [gtin, FUENTE, d.encontrado, d.nombre, d.marca, d.contenido, d.cantidad, d.unidad, d.categoria]);
  res.json({ ok: true, fuente: FUENTE, catalogo: d.encontrado ? d : null });
}));

module.exports = r;
