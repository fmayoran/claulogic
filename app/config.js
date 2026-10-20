// API de configuración: unidades, almacenes con sus ubicaciones, y proveedores.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, texto, h, enTransaccion } = require('./util');

const r = express.Router();

// ── Unidades ─────────────────────────────────────────────────────────────────────────────────
const SISTEMA = ['g', 'kg', 'ml', 'l', 'u'];   // las mismas que protege el trigger logic.unidad_fija
r.get('/unidades', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.codigo, u.nombre, u.magnitud, trim_scale(u.factor_si)::text AS factor_si, u.es_referencia,
            (SELECT COUNT(*)::int FROM logic.producto p WHERE p.unidad_base = u.codigo) AS productos
       FROM logic.unidad u ORDER BY u.magnitud, u.factor_si`);
  res.json({ ok: true, unidades: rows });
}));

// El factor se carga contra la unidad patrón de la magnitud (g, ml, u): "docena" = 12 u,
// "cucharada" = 15 ml. Es lo único que hace falta para convertir entre cualquier par.
function leerUnidad(b) {
  const u = {
    codigo: (texto(b.codigo, { campo: 'el código', requerido: true })).toLowerCase(),
    nombre: texto(b.nombre, { campo: 'el nombre', requerido: true }),
    magnitud: texto(b.magnitud, { campo: 'la magnitud', requerido: true }),
    factor_si: numero(b.factor_si, { campo: 'El factor', requerido: true, positivo: true }),
    es_referencia: !!b.es_referencia,
  };
  if (!/^[a-zà-ü0-9_.]{1,12}$/.test(u.codigo))
    throw new ErrorUsuario('El código va corto y sin espacios (hasta 12 letras o números).');
  if (!['masa', 'volumen', 'conteo'].includes(u.magnitud)) throw new ErrorUsuario('Magnitud inválida.');
  return u;
}

// Marcar una unidad como referencia desmarca la anterior de su magnitud: hay una sola por magnitud.
async function marcarReferencia(c, u) {
  if (!u.es_referencia) return;
  await c.query('UPDATE logic.unidad SET es_referencia = false WHERE magnitud = $1 AND codigo <> $2 AND es_referencia',
    [u.magnitud, u.codigo]);
  await c.query('UPDATE logic.unidad SET es_referencia = true WHERE codigo = $1', [u.codigo]);
}

r.post('/unidades', h(async (req, res) => {
  const u = leerUnidad(req.body);
  await enTransaccion(async c => {
    await c.query('INSERT INTO logic.unidad (codigo, nombre, magnitud, factor_si) VALUES ($1,$2,$3,$4)',
      [u.codigo, u.nombre, u.magnitud, u.factor_si]);
    await marcarReferencia(c, u);
  });
  res.status(201).json({ ok: true, codigo: u.codigo });
}));

// El código no se cambia (es la clave a la que apuntan los productos); el resto sí, y la base
// frena el cambio de magnitud o factor si la unidad ya está en uso.
r.put('/unidades/:codigo', h(async (req, res) => {
  const u = leerUnidad({ ...req.body, codigo: req.params.codigo });
  const ok = await enTransaccion(async c => {
    const { rows: [ant] } = await c.query('SELECT es_referencia FROM logic.unidad WHERE codigo = $1 FOR UPDATE', [u.codigo]);
    if (!ant) return false;
    if (ant.es_referencia && !u.es_referencia)
      throw new ErrorUsuario('Para dejar de usarla como referencia, marcá otra unidad de la misma magnitud.');
    await c.query('UPDATE logic.unidad SET nombre = $1, magnitud = $2, factor_si = $3 WHERE codigo = $4',
      [u.nombre, u.magnitud, u.factor_si, u.codigo]);
    await marcarReferencia(c, u);
    return true;
  });
  if (!ok) return res.status(404).json({ ok: false, error: 'No existe esa unidad.' });
  res.json({ ok: true, codigo: u.codigo });
}));

r.delete('/unidades/:codigo', h(async (req, res) => {
  const { rows: [u] } = await pool.query('SELECT es_referencia FROM logic.unidad WHERE codigo = $1', [req.params.codigo]);
  if (!u) return res.status(404).json({ ok: false, error: 'No existe esa unidad.' });
  if (u.es_referencia || SISTEMA.includes(req.params.codigo))
    throw new ErrorUsuario('Es una unidad del sistema o de referencia: no se borra.');
  await pool.query('DELETE FROM logic.unidad WHERE codigo = $1', [req.params.codigo]);
  res.json({ ok: true });
}));

// ── Almacenes y ubicaciones ──────────────────────────────────────────────────────────────────
const TIPOS_FRIO = ['camara', 'heladera', 'freezer'];

r.get('/almacenes', h(async (req, res) => {
  const [{ rows: almacenes }, { rows: ubicaciones }] = await Promise.all([
    pool.query('SELECT id, nombre, direccion, notas, activo FROM logic.almacen ORDER BY activo DESC, nombre'),
    pool.query(
      `SELECT u.id, u.almacen_id, u.nombre, u.tipo, trim_scale(u.temp_min)::text AS temp_min,
              trim_scale(u.temp_max)::text AS temp_max, u.activa,
              EXISTS (SELECT 1 FROM logic.stock s WHERE s.ubicacion_id = u.id) AS con_stock
         FROM logic.ubicacion u ORDER BY u.activa DESC, u.nombre`),
  ]);
  for (const a of almacenes) a.ubicaciones = ubicaciones.filter(u => u.almacen_id === a.id);
  res.json({ ok: true, almacenes });
}));

function leerAlmacen(b) {
  return {
    nombre: texto(b.nombre, { campo: 'el nombre del almacén', requerido: true }),
    direccion: texto(b.direccion), notas: texto(b.notas),
    activo: b.activo === undefined ? true : !!b.activo,
  };
}

r.post('/almacenes', h(async (req, res) => {
  const a = leerAlmacen(req.body);
  const { rows: [n] } = await pool.query(
    'INSERT INTO logic.almacen (nombre, direccion, notas, activo) VALUES ($1,$2,$3,$4) RETURNING id',
    [a.nombre, a.direccion, a.notas, a.activo]);
  res.status(201).json({ ok: true, id: n.id });
}));

r.put('/almacenes/:id', h(async (req, res) => {
  const a = leerAlmacen(req.body);
  const { rowCount } = await pool.query(
    'UPDATE logic.almacen SET nombre=$1, direccion=$2, notas=$3, activo=$4 WHERE id=$5',
    [a.nombre, a.direccion, a.notas, a.activo, req.params.id]);
  if (!rowCount) return res.status(404).json({ ok: false, error: 'No existe ese almacén.' });
  res.json({ ok: true, id: req.params.id });
}));

function leerUbicacion(b) {
  const u = {
    almacen_id: texto(b.almacen_id, { campo: 'el almacén', requerido: true }),
    nombre: texto(b.nombre, { campo: 'el nombre de la ubicación', requerido: true }),
    tipo: texto(b.tipo, { campo: 'el tipo', requerido: true }),
    temp_min: numero(b.temp_min, { campo: 'Temperatura mínima', negativo: true }),
    temp_max: numero(b.temp_max, { campo: 'Temperatura máxima', negativo: true }),
    activa: b.activa === undefined ? true : !!b.activa,
  };
  // La base lo exige igual; acá se dice con palabras.
  if (TIPOS_FRIO.includes(u.tipo) && (u.temp_min === null || u.temp_max === null))
    throw new ErrorUsuario('Una cámara, heladera o freezer necesita rango de temperatura: sin eso no hay control de frío.');
  return u;
}

r.post('/ubicaciones', h(async (req, res) => {
  const u = leerUbicacion(req.body);
  const { rows: [n] } = await pool.query(
    `INSERT INTO logic.ubicacion (almacen_id, nombre, tipo, temp_min, temp_max, activa)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [u.almacen_id, u.nombre, u.tipo, u.temp_min, u.temp_max, u.activa]);
  res.status(201).json({ ok: true, id: n.id });
}));

// Una ubicación con stock no cambia de almacén: el stock "se mudaría" sin ningún movimiento que
// lo explique. Para eso está el traslado.
r.put('/ubicaciones/:id', h(async (req, res) => {
  const u = leerUbicacion(req.body);
  const ok = await enTransaccion(async c => {
    const { rows: [ant] } = await c.query('SELECT almacen_id FROM logic.ubicacion WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!ant) return false;
    if (ant.almacen_id !== u.almacen_id) {
      const { rows: [s] } = await c.query('SELECT 1 FROM logic.stock WHERE ubicacion_id = $1 LIMIT 1', [req.params.id]);
      if (s) throw new ErrorUsuario('La ubicación tiene stock: no puede cambiar de almacén. Trasladá el stock primero.');
    }
    await c.query(
      'UPDATE logic.ubicacion SET almacen_id=$1, nombre=$2, tipo=$3, temp_min=$4, temp_max=$5, activa=$6 WHERE id=$7',
      [u.almacen_id, u.nombre, u.tipo, u.temp_min, u.temp_max, u.activa, req.params.id]);
    return true;
  });
  if (!ok) return res.status(404).json({ ok: false, error: 'No existe esa ubicación.' });
  res.json({ ok: true, id: req.params.id });
}));

// ── Proveedores ──────────────────────────────────────────────────────────────────────────────
r.get('/proveedores', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nombre, cuit, contacto, telefono, email, notas, activo FROM logic.proveedor
      WHERE ($1 OR activo) ORDER BY activo DESC, nombre`, [req.query.inactivos === '1']);
  res.json({ ok: true, proveedores: rows });
}));

function leerProveedor(b) {
  const p = {
    nombre: texto(b.nombre, { campo: 'el nombre', requerido: true }),
    cuit: texto(b.cuit), contacto: texto(b.contacto), telefono: texto(b.telefono),
    email: texto(b.email), notas: texto(b.notas),
    activo: b.activo === undefined ? true : !!b.activo,
  };
  if (p.cuit && !/^\d{2}-?\d{8}-?\d$/.test(p.cuit)) throw new ErrorUsuario('El CUIT tiene que tener 11 dígitos.');
  if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw new ErrorUsuario('El email no parece válido.');
  return p;
}

r.post('/proveedores', h(async (req, res) => {
  const p = leerProveedor(req.body);
  const { rows: [n] } = await pool.query(
    `INSERT INTO logic.proveedor (nombre, cuit, contacto, telefono, email, notas, activo)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [p.nombre, p.cuit, p.contacto, p.telefono, p.email, p.notas, p.activo]);
  res.status(201).json({ ok: true, id: n.id });
}));

r.put('/proveedores/:id', h(async (req, res) => {
  const p = leerProveedor(req.body);
  const { rowCount } = await pool.query(
    `UPDATE logic.proveedor SET nombre=$1, cuit=$2, contacto=$3, telefono=$4, email=$5, notas=$6, activo=$7
      WHERE id=$8`,
    [p.nombre, p.cuit, p.contacto, p.telefono, p.email, p.notas, p.activo, req.params.id]);
  if (!rowCount) return res.status(404).json({ ok: false, error: 'No existe ese proveedor.' });
  res.json({ ok: true, id: req.params.id });
}));

module.exports = r;
