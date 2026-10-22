// API de productos y categorías: lo que necesita la pantalla de productos.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, texto, h, enTransaccion, aBase, UNIDAD_REF, enRef } = require('./util');
const gs1 = require('./gs1');
const COSTO_REF = enRef('p.costo_base');

const r = express.Router();

// ── Categorías ───────────────────────────────────────────────────────────────────────────────
// El prefijo arma el SKU automático (LAC-0001). Vacío al crear: lo sugiere la base desde el nombre.
r.get('/categorias', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.prefijo, c.activa, COUNT(p.id)::int AS productos,
            logic.siguiente_sku(c.id) AS siguiente_sku
       FROM logic.categoria c LEFT JOIN logic.producto p ON p.categoria_id = c.id
      GROUP BY c.id ORDER BY c.nombre`);
  res.json({ ok: true, categorias: rows });
}));

function leerCategoria(b) {
  const prefijo = (texto(b.prefijo) || '').toUpperCase() || null;
  if (prefijo && !/^[A-Z0-9]{2,6}$/.test(prefijo))
    throw new ErrorUsuario('El prefijo va de 2 a 6 letras o números, sin espacios ni acentos.');
  return { nombre: texto(b.nombre, { campo: 'el nombre de la categoría', requerido: true }), prefijo,
           activa: b.activa === undefined ? true : !!b.activa };
}

r.post('/categorias', h(async (req, res) => {
  const c = leerCategoria(req.body);
  const { rows: [n] } = await pool.query(
    'INSERT INTO logic.categoria (nombre, prefijo) VALUES ($1, $2) RETURNING id, nombre, prefijo, activa', [c.nombre, c.prefijo]);
  res.status(201).json({ ok: true, categoria: n });
}));

// Cambiar el prefijo no toca los SKU que ya existen: sólo los que se generen de ahí en más.
r.put('/categorias/:id', h(async (req, res) => {
  const c = leerCategoria(req.body);
  if (!c.prefijo) throw new ErrorUsuario('Falta el prefijo.');
  const { rows: [n] } = await pool.query(
    `UPDATE logic.categoria SET nombre = $1, prefijo = $2, activa = $3 WHERE id = $4
     RETURNING id, nombre, prefijo, activa`, [c.nombre, c.prefijo, c.activa, req.params.id]);
  if (!n) return res.status(404).json({ ok: false, error: 'No existe esa categoría.' });
  res.json({ ok: true, categoria: n });
}));

// ── Productos ────────────────────────────────────────────────────────────────────────────────
r.get('/productos', h(async (req, res) => {
  const q = texto(req.query.q);
  const categoria = texto(req.query.categoria);
  const { rows } = await pool.query(
    `SELECT p.id, p.codigo, p.nombre, p.unidad_base, p.perecedero, p.vida_util_dias, p.activo,
            p.categoria_id, c.nombre AS categoria, ${COSTO_REF} AS costo, ${UNIDAD_REF} AS costo_unidad,
            trim_scale(p.alicuota_iva)::text AS alicuota_iva,
            trim_scale(COALESCE(s.cantidad, 0))::text AS stock,
            (SELECT g.gtin FROM logic.gtin g WHERE g.producto_id = p.id AND g.presentacion_id IS NULL) AS gtin,
            (SELECT (extract(epoch FROM f.actualizado_en) * 1000)::bigint::text
               FROM logic.producto_foto f WHERE f.producto_id = p.id) AS foto_v
       FROM logic.producto p
       JOIN logic.categoria c ON c.id = p.categoria_id
       LEFT JOIN (SELECT producto_id, SUM(cantidad) AS cantidad FROM logic.stock GROUP BY producto_id) s
              ON s.producto_id = p.id
      WHERE ($1::text IS NULL OR p.nombre ILIKE '%' || $1 || '%' OR p.codigo ILIKE '%' || $1 || '%'
             OR EXISTS (SELECT 1 FROM logic.gtin g WHERE g.producto_id = p.id AND g.gtin LIKE '%' || $1 || '%'))
        AND ($2::uuid IS NULL OR p.categoria_id = $2)
        AND ($3 OR p.activo)
      ORDER BY p.nombre
      LIMIT 500`,
    [q, categoria, req.query.inactivos === '1']);
  res.json({ ok: true, productos: rows });
}));

r.get('/productos/:id', h(async (req, res) => {
  const { rows: [p] } = await pool.query(
    `SELECT id, codigo, nombre, categoria_id, unidad_base, perecedero, vida_util_dias,
            trim_scale(temp_min)::text AS temp_min, trim_scale(temp_max)::text AS temp_max,
            trim_scale(stock_minimo)::text AS stock_minimo, activo, trim_scale(alicuota_iva)::text AS alicuota_iva,
            ${COSTO_REF} AS costo, ${UNIDAD_REF} AS costo_unidad,
            EXISTS (SELECT 1 FROM logic.movimiento m WHERE m.producto_id = p.id) AS tiene_movimientos,
            (SELECT g.gtin FROM logic.gtin g WHERE g.producto_id = p.id AND g.presentacion_id IS NULL) AS gtin,
            (extract(epoch FROM f.actualizado_en) * 1000)::bigint::text AS foto_v, f.origen AS foto_origen,
            f.atribucion AS foto_atribucion, f.fuente_url AS foto_fuente
       FROM logic.producto p LEFT JOIN logic.producto_foto f ON f.producto_id = p.id
      WHERE p.id = $1`, [req.params.id]);
  if (!p) return res.status(404).json({ ok: false, error: 'No existe ese producto.' });
  const [{ rows: presentaciones }, { rows: costos }] = await Promise.all([
    pool.query(
      `SELECT pr.id, pr.nombre, trim_scale(pr.cantidad_base)::text AS cantidad_base, pr.es_default,
              g.gtin, g.origen AS gtin_origen
         FROM logic.presentacion pr LEFT JOIN logic.gtin g ON g.presentacion_id = pr.id
        WHERE pr.producto_id = $1 ORDER BY pr.nombre`, [p.id]),
    pool.query(
      `SELECT h.cambiado_en, h.origen, h.registrado_por,
              trim_scale((h.costo_anterior * r.factor_si / b.factor_si)::numeric(16,4))::text AS costo_anterior,
              trim_scale((h.costo_nuevo    * r.factor_si / b.factor_si)::numeric(16,4))::text AS costo_nuevo
         FROM logic.costo_historial h, logic.unidad r, logic.unidad b
        WHERE h.producto_id = $1 AND r.codigo = $2 AND b.codigo = $3
        ORDER BY h.cambiado_en DESC LIMIT 10`, [p.id, p.costo_unidad, p.unidad_base]),
  ]);
  res.json({ ok: true, producto: { ...p, presentaciones, costos } });
}));

// El GTIN se acepta de 8, 12, 13 o 14 dígitos y se guarda en 14. Un dígito verificador que no
// cierra casi siempre es un error de tipeo o de lectura: se rechaza en vez de guardarlo.
function leerGtin(v, nombre) {
  const s = texto(v);
  if (!s) return null;
  const g = gs1.normalizarGtin(s.replace(/\s/g, ''));
  if (!g) throw new ErrorUsuario(`El GTIN de "${nombre}" no es válido (revisá los dígitos).`);
  return g;
}

// Al crear, el SKU vacío lo genera la base con el prefijo de la categoría; al editar es obligatorio.
function leerProducto(b, { nuevo = false } = {}) {
  const p = {
    codigo: (texto(b.codigo, { campo: 'el SKU', requerido: !nuevo }) || '').toUpperCase() || null,
    nombre: texto(b.nombre, { campo: 'el nombre', requerido: true }),
    categoria_id: texto(b.categoria_id, { campo: 'la categoría', requerido: true }),
    unidad_base: texto(b.unidad_base, { campo: 'la unidad base', requerido: true }),
    perecedero: !!b.perecedero,
    vida_util_dias: numero(b.vida_util_dias, { campo: 'Vida útil' }),
    temp_min: numero(b.temp_min, { campo: 'Temperatura mínima', negativo: true }),
    temp_max: numero(b.temp_max, { campo: 'Temperatura máxima', negativo: true }),
    stock_minimo: numero(b.stock_minimo, { campo: 'Stock mínimo' }),
    // '' = exento o no gravado; sin el campo, 21 (lo más común).
    alicuota_iva: b.alicuota_iva === undefined ? '21' : (texto(b.alicuota_iva) || '').replace(',', '.') || null,
    costo: numero(b.costo, { campo: 'Costo' }),
    costo_unidad: texto(b.costo_unidad),
    activo: b.activo === undefined ? true : !!b.activo,
  };
  if (p.vida_util_dias !== null && !/^\d+$/.test(p.vida_util_dias))
    throw new ErrorUsuario('La vida útil va en días enteros.');
  const pres = Array.isArray(b.presentaciones) ? b.presentaciones : [];
  p.presentaciones = pres.map((x, i) => ({
    id: texto(x.id),
    nombre: texto(x.nombre, { campo: `el nombre de la presentación ${i + 1}`, requerido: true }),
    cantidad: numero(x.cantidad, { campo: `Cantidad de "${x.nombre || i + 1}"`, requerido: true, positivo: true }),
    unidad: texto(x.unidad) || p.unidad_base,
    es_default: !!x.es_default,
    gtin: leerGtin(x.gtin, x.nombre || i + 1),
    gtin_interno: !!x.gtin_interno,
  }));
  if (p.presentaciones.filter(x => x.es_default).length > 1)
    throw new ErrorUsuario('Sólo una presentación puede ser la habitual.');
  return p;
}

// Costo cargado por la unidad que eligió el usuario -> costo por unidad base, en NUMERIC.
async function costoBase(c, p) {
  if (p.costo === null) return null;
  const { rows: [r] } = await c.query(
    `SELECT ($1::numeric * b.factor_si / u.factor_si)::numeric(16,6)::text AS base,
            u.magnitud = b.magnitud AS compatible
       FROM logic.unidad u, logic.unidad b WHERE u.codigo = $2 AND b.codigo = $3`,
    [p.costo, p.costo_unidad || p.unidad_base, p.unidad_base]);
  if (!r || !r.compatible) throw new ErrorUsuario('El costo está en una unidad que no corresponde al producto.');
  return r.base;
}

// Las presentaciones se cargan en la unidad que le resulte cómoda al usuario ("6 kg") y se
// guardan en la unidad base del producto (6000 g).
async function guardarPresentaciones(c, productoId, unidadBase, pres) {
  const conservar = pres.filter(x => x.id).map(x => x.id);
  await c.query(
    'DELETE FROM logic.presentacion WHERE producto_id = $1 AND NOT (id = ANY($2::uuid[]))',
    [productoId, conservar]);
  for (const x of pres) {
    const base = await aBase(c, x.cantidad, x.unidad, unidadBase, `"${x.nombre}"`);
    let presId = x.id;
    if (x.id) {
      const { rowCount } = await c.query(
        `UPDATE logic.presentacion SET nombre = $1, cantidad_base = $2, es_default = $3
          WHERE id = $4 AND producto_id = $5`,
        [x.nombre, base, x.es_default, x.id, productoId]);
      if (!rowCount) throw new ErrorUsuario('Una presentación ya no existe. Recargá la página.');
    } else {
      ({ rows: [{ id: presId }] } = await c.query(
        `INSERT INTO logic.presentacion (producto_id, nombre, cantidad_base, es_default)
         VALUES ($1, $2, $3, $4) RETURNING id`, [productoId, x.nombre, base, x.es_default]));
    }
    await guardarGtin(c, productoId, presId, x);
  }
}

// GTIN de una presentación: el del fabricante que se cargó o escaneó, o uno interno (040…) para
// los empaques propios. Si no cambió, no se toca: un GTIN interno ya impreso en etiquetas no
// puede cambiar por volver a guardar el formulario.
async function guardarGtin(c, productoId, presId, x) {
  const { rows: [ant] } = await c.query('SELECT gtin, origen FROM logic.gtin WHERE presentacion_id = $1', [presId]);
  if (x.gtin_interno && !x.gtin) {
    if (ant && ant.origen === 'interno') return;
    if (ant) await c.query('DELETE FROM logic.gtin WHERE presentacion_id = $1', [presId]);
    await c.query(`INSERT INTO logic.gtin (gtin, producto_id, presentacion_id, origen)
                   VALUES (logic.nuevo_gtin_interno(), $1, $2, 'interno')`, [productoId, presId]);
    return;
  }
  if (ant && ant.gtin === x.gtin) return;
  if (ant) await c.query('DELETE FROM logic.gtin WHERE presentacion_id = $1', [presId]);
  if (!x.gtin) return;
  const { rows: [otro] } = await c.query(
    `SELECT p.nombre FROM logic.gtin g JOIN logic.producto p ON p.id = g.producto_id WHERE g.gtin = $1`, [x.gtin]);
  if (otro) throw new ErrorUsuario(`El GTIN ${x.gtin} ya está asignado a "${otro.nombre}".`);
  // Los internos los numera la secuencia: uno tipeado a mano chocaría tarde o temprano con ella.
  if (x.gtin.slice(1, 3) === '04')
    throw new ErrorUsuario(`${x.gtin} es un código de uso interno (040-049): no es de un fabricante. Para un empaque propio, usá "generar interno".`);
  await c.query(`INSERT INTO logic.gtin (gtin, producto_id, presentacion_id, origen) VALUES ($1,$2,$3,'fabricante')`,
    [x.gtin, productoId, presId]);
}

r.post('/productos', h(async (req, res) => {
  const p = leerProducto(req.body, { nuevo: true });
  const id = await enTransaccion(async c => {
    const { rows: [n] } = await c.query(
      `INSERT INTO logic.producto (codigo, nombre, categoria_id, unidad_base, perecedero, vida_util_dias,
                                   temp_min, temp_max, stock_minimo, costo_base, activo, alicuota_iva)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [p.codigo, p.nombre, p.categoria_id, p.unidad_base, p.perecedero, p.vida_util_dias,
       p.temp_min, p.temp_max, p.stock_minimo, await costoBase(c, p), p.activo, p.alicuota_iva]);
    await guardarPresentaciones(c, n.id, p.unidad_base, p.presentaciones);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

r.put('/productos/:id', h(async (req, res) => {
  const p = leerProducto(req.body);
  const ok = await enTransaccion(async c => {
    // El costo cambiado desde esta pantalla queda en el historial como 'manual' (lo pone el
    // trigger por defecto); el que cambia por una compra lo marcará la recepción de compras.
    const { rowCount } = await c.query(
      `UPDATE logic.producto SET codigo=$1, nombre=$2, categoria_id=$3, unidad_base=$4, perecedero=$5,
              vida_util_dias=$6, temp_min=$7, temp_max=$8, stock_minimo=$9, costo_base=$10, activo=$11, alicuota_iva=$13
        WHERE id = $12`,
      [p.codigo, p.nombre, p.categoria_id, p.unidad_base, p.perecedero, p.vida_util_dias,
       p.temp_min, p.temp_max, p.stock_minimo, await costoBase(c, p), p.activo, req.params.id, p.alicuota_iva]);
    if (!rowCount) return false;
    await guardarPresentaciones(c, req.params.id, p.unidad_base, p.presentaciones);
    return true;
  });
  if (!ok) return res.status(404).json({ ok: false, error: 'No existe ese producto.' });
  res.json({ ok: true, id: req.params.id });
}));

module.exports = r;
