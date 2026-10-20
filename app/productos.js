// API de productos, categorías y unidades: lo que necesita la pantalla de alta de productos.
//
// Las cantidades, temperaturas y costos viajan como TEXTO y llegan a la base como texto: Postgres
// los convierte a NUMERIC. Si pasaran por un Number de JavaScript serían float, y la decisión de
// no usar float en la base no serviría de nada.
const express = require('express');
const { pool } = require('./db');

const r = express.Router();

// ── Validación ───────────────────────────────────────────────────────────────────────────────
class ErrorUsuario extends Error {}

// Acepta coma o punto decimal (en Argentina se escribe "1,5"). Devuelve el texto normalizado o null.
function numero(v, { campo, negativo = false, requerido = false, positivo = false } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (requerido) throw new ErrorUsuario(`Falta ${campo}.`);
    return null;
  }
  const s = String(v).trim().replace(',', '.');
  const re = negativo ? /^-?\d+(\.\d+)?$/ : /^\d+(\.\d+)?$/;
  if (!re.test(s)) throw new ErrorUsuario(`${campo}: "${v}" no es un número válido.`);
  if (positivo && /^0+(\.0+)?$/.test(s)) throw new ErrorUsuario(`${campo} tiene que ser mayor que cero.`);
  return s;
}

function texto(v, { campo, requerido = false } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s && requerido) throw new ErrorUsuario(`Falta ${campo}.`);
  return s || null;
}

// Los errores de la base se traducen a algo que el encargado entienda. Los RAISE de nuestros
// triggers ya vienen redactados para una persona (P0001); el resto se nombra por la restricción.
function errorBase(e) {
  if (e instanceof ErrorUsuario) return e.message;
  if (e.code === 'P0001') return e.message;
  const c = e.constraint || '';
  if (e.code === '23505') {
    if (c === 'producto_codigo_key') return 'Ya existe un producto con ese código.';
    if (c === 'categoria_nombre_ux') return 'Ya existe una categoría con ese nombre.';
    if (c === 'presentacion_producto_id_nombre_key') return 'Hay dos presentaciones con el mismo nombre.';
  }
  if (e.code === '23503' && e.table === 'compra_item')
    return 'Una presentación que quitaste ya se usó en compras: no se puede borrar.';
  if (e.code === '23503') return 'Alguno de los datos elegidos ya no existe. Recargá la página.';
  if (e.code === '23514') return 'Algún valor está fuera de lo permitido (revisá temperaturas y cantidades).';
  if (e.code === '22P02') return 'Hay un dato con formato inválido.';
  return null;
}

// Envuelve un handler: errores del usuario -> 400 con mensaje; el resto sigue al manejador general.
const h = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (e) {
    const msg = errorBase(e);
    if (msg) return res.status(400).json({ ok: false, error: msg });
    next(e);
  }
};

async function enTransaccion(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Unidad de REFERENCIA para mostrar costos: la mayor de la magnitud del producto (kg, l, u). Un
// costo se guarda por unidad base, pero "$0,0012 el gramo" no lo lee nadie; "$1.200 el kilo" sí.
const UNIDAD_REF = `(SELECT r.codigo FROM logic.unidad r JOIN logic.unidad b ON b.magnitud = r.magnitud
                      WHERE b.codigo = p.unidad_base ORDER BY r.factor_si DESC LIMIT 1)`;
const COSTO_REF = `(SELECT trim_scale((p.costo_base * r.factor_si / b.factor_si)::numeric(16,4))::text
                      FROM logic.unidad r, logic.unidad b
                     WHERE r.codigo = ${UNIDAD_REF} AND b.codigo = p.unidad_base)`;

// ── Unidades y categorías ────────────────────────────────────────────────────────────────────
r.get('/unidades', h(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT codigo, nombre, magnitud, factor_si::text FROM logic.unidad ORDER BY magnitud, factor_si');
  res.json({ ok: true, unidades: rows });
}));

r.get('/categorias', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.activa, COUNT(p.id)::int AS productos
       FROM logic.categoria c LEFT JOIN logic.producto p ON p.categoria_id = c.id
      GROUP BY c.id ORDER BY c.nombre`);
  res.json({ ok: true, categorias: rows });
}));

r.post('/categorias', h(async (req, res) => {
  const nombre = texto(req.body.nombre, { campo: 'el nombre de la categoría', requerido: true });
  const { rows: [c] } = await pool.query(
    'INSERT INTO logic.categoria (nombre) VALUES ($1) RETURNING id, nombre, activa', [nombre]);
  res.status(201).json({ ok: true, categoria: c });
}));

// ── Productos ────────────────────────────────────────────────────────────────────────────────
r.get('/productos', h(async (req, res) => {
  const q = texto(req.query.q);
  const categoria = texto(req.query.categoria);
  const { rows } = await pool.query(
    `SELECT p.id, p.codigo, p.nombre, p.unidad_base, p.perecedero, p.activo,
            p.categoria_id, c.nombre AS categoria, ${COSTO_REF} AS costo, ${UNIDAD_REF} AS costo_unidad,
            trim_scale(COALESCE(s.cantidad, 0))::text AS stock
       FROM logic.producto p
       JOIN logic.categoria c ON c.id = p.categoria_id
       LEFT JOIN (SELECT producto_id, SUM(cantidad) AS cantidad FROM logic.stock GROUP BY producto_id) s
              ON s.producto_id = p.id
      WHERE ($1::text IS NULL OR p.nombre ILIKE '%' || $1 || '%' OR p.codigo ILIKE '%' || $1 || '%')
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
            trim_scale(stock_minimo)::text AS stock_minimo, activo,
            ${COSTO_REF} AS costo, ${UNIDAD_REF} AS costo_unidad,
            EXISTS (SELECT 1 FROM logic.movimiento m WHERE m.producto_id = p.id) AS tiene_movimientos
       FROM logic.producto p WHERE id = $1`, [req.params.id]);
  if (!p) return res.status(404).json({ ok: false, error: 'No existe ese producto.' });
  const [{ rows: presentaciones }, { rows: costos }] = await Promise.all([
    pool.query(
      `SELECT id, nombre, trim_scale(cantidad_base)::text AS cantidad_base, es_default FROM logic.presentacion
        WHERE producto_id = $1 ORDER BY nombre`, [p.id]),
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

function leerProducto(b) {
  const p = {
    codigo: texto(b.codigo, { campo: 'el código', requerido: true }).toUpperCase(),
    nombre: texto(b.nombre, { campo: 'el nombre', requerido: true }),
    categoria_id: texto(b.categoria_id, { campo: 'la categoría', requerido: true }),
    unidad_base: texto(b.unidad_base, { campo: 'la unidad base', requerido: true }),
    perecedero: !!b.perecedero,
    vida_util_dias: numero(b.vida_util_dias, { campo: 'Vida útil' }),
    temp_min: numero(b.temp_min, { campo: 'Temperatura mínima', negativo: true }),
    temp_max: numero(b.temp_max, { campo: 'Temperatura máxima', negativo: true }),
    stock_minimo: numero(b.stock_minimo, { campo: 'Stock mínimo' }),
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
  }));
  if (p.presentaciones.filter(x => x.es_default).length > 1)
    throw new ErrorUsuario('Sólo una presentación puede ser la habitual.');
  return p;
}

// Las presentaciones se cargan en la unidad que le resulte cómoda al usuario ("6 kg") y se
// guardan en la unidad base del producto (6000 g). La conversión la hace la base, en NUMERIC, y
// se niega si las magnitudes no coinciden: una caja no puede pesar 6 litros de un producto en g.
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

async function guardarPresentaciones(c, productoId, unidadBase, pres) {
  const conservar = pres.filter(x => x.id).map(x => x.id);
  await c.query(
    'DELETE FROM logic.presentacion WHERE producto_id = $1 AND NOT (id = ANY($2::uuid[]))',
    [productoId, conservar]);
  for (const x of pres) {
    const { rows: [conv] } = await c.query(
      `SELECT ($1::numeric * u.factor_si / b.factor_si)::numeric(16,4)::text AS base,
              u.magnitud = b.magnitud AS compatible
         FROM logic.unidad u, logic.unidad b WHERE u.codigo = $2 AND b.codigo = $3`,
      [x.cantidad, x.unidad, unidadBase]);
    if (!conv) throw new ErrorUsuario(`Unidad desconocida en "${x.nombre}".`);
    if (!conv.compatible)
      throw new ErrorUsuario(`"${x.nombre}" está en ${x.unidad}, que no se puede convertir a ${unidadBase}.`);
    if (/^0+(\.0+)?$/.test(conv.base))
      throw new ErrorUsuario(`"${x.nombre}" queda en cero al pasarla a ${unidadBase}.`);
    if (x.id) {
      const { rowCount } = await c.query(
        `UPDATE logic.presentacion SET nombre = $1, cantidad_base = $2, es_default = $3
          WHERE id = $4 AND producto_id = $5`,
        [x.nombre, conv.base, x.es_default, x.id, productoId]);
      if (!rowCount) throw new ErrorUsuario('Una presentación ya no existe. Recargá la página.');
    } else {
      await c.query(
        `INSERT INTO logic.presentacion (producto_id, nombre, cantidad_base, es_default)
         VALUES ($1, $2, $3, $4)`, [productoId, x.nombre, conv.base, x.es_default]);
    }
  }
}

r.post('/productos', h(async (req, res) => {
  const p = leerProducto(req.body);
  const id = await enTransaccion(async c => {
    const { rows: [n] } = await c.query(
      `INSERT INTO logic.producto (codigo, nombre, categoria_id, unidad_base, perecedero, vida_util_dias,
                                   temp_min, temp_max, stock_minimo, costo_base, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [p.codigo, p.nombre, p.categoria_id, p.unidad_base, p.perecedero, p.vida_util_dias,
       p.temp_min, p.temp_max, p.stock_minimo, await costoBase(c, p), p.activo]);
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
              vida_util_dias=$6, temp_min=$7, temp_max=$8, stock_minimo=$9, costo_base=$10, activo=$11
        WHERE id = $12`,
      [p.codigo, p.nombre, p.categoria_id, p.unidad_base, p.perecedero, p.vida_util_dias,
       p.temp_min, p.temp_max, p.stock_minimo, await costoBase(c, p), p.activo, req.params.id]);
    if (!rowCount) return false;
    await guardarPresentaciones(c, req.params.id, p.unidad_base, p.presentaciones);
    return true;
  });
  if (!ok) return res.status(404).json({ ok: false, error: 'No existe ese producto.' });
  res.json({ ok: true, id: req.params.id });
}));

module.exports = r;
