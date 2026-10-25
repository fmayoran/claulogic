// API de sedes (alta y edición, sólo administrador) y de unidades productivas (encargado de la sede).
// GET /sedes está en usuarios.js: lo usan también las pantallas de almacenes y de remitos.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, texto, h, enTransaccion } = require('./util');
const { exigirEncargadoDe, filtroSedes } = require('./auth');

const r = express.Router();

// ── Sedes ────────────────────────────────────────────────────────────────────────────────────
function leerSede(b) {
  const s = {
    nombre: texto(b.nombre, { campo: 'el nombre de la sede', requerido: true }),
    tipo: texto(b.tipo, { campo: 'el tipo', requerido: true }),
    direccion: texto(b.direccion),
    activa: b.activa === undefined ? true : !!b.activa,
    es_central: !!b.es_central,
  };
  if (s.es_central && !s.activa) throw new ErrorUsuario('La sede central tiene que estar activa.');
  if (!['centro', 'local'].includes(s.tipo)) throw new ErrorUsuario('El tipo es centro o local.');
  return s;
}

// Un local nuevo sin almacén no puede recibir nada: por defecto se le crea "Depósito" con una
// ubicación "General", que después se renombra o se completa desde Almacenes.
r.post('/sedes', h(async (req, res) => {
  const s = leerSede(req.body);
  const id = await enTransaccion(async c => {
    // La central es una sola: marcar otra le saca la marca a la anterior.
    if (s.es_central) await c.query('UPDATE org.sede SET es_central = false WHERE es_central');
    const { rows: [n] } = await c.query(
      'INSERT INTO org.sede (nombre, tipo, direccion, activa, es_central) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [s.nombre, s.tipo, s.direccion, s.activa, s.es_central]);
    if (req.body.crear_almacen !== false) {
      const { rows: [a] } = await c.query(
        `INSERT INTO logic.almacen (nombre, sede_id, direccion) VALUES ('Depósito', $1, $2) RETURNING id`, [n.id, s.direccion]);
      await c.query(`INSERT INTO logic.ubicacion (almacen_id, nombre, tipo) VALUES ($1, 'General', 'deposito')`, [a.id]);
    }
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

// Una sede con stock no se desactiva: el stock quedaría donde nadie lo ve (las sedes inactivas no
// aparecen en los permisos). Primero se traslada o se ajusta.
r.put('/sedes/:id', h(async (req, res) => {
  const s = leerSede(req.body);
  await enTransaccion(async c => {
    const { rows: [ant] } = await c.query('SELECT activa, tipo FROM org.sede WHERE id = $1::uuid FOR UPDATE', [req.params.id]);
    if (!ant) throw new ErrorUsuario('No existe esa sede.', 404);
    if (ant.activa && !s.activa) {
      const { rows: [x] } = await c.query(
        `SELECT 1 FROM logic.stock st JOIN logic.ubicacion u ON u.id = st.ubicacion_id
           JOIN logic.almacen a ON a.id = u.almacen_id WHERE a.sede_id = $1 AND st.cantidad <> 0 LIMIT 1`, [req.params.id]);
      if (x) throw new ErrorUsuario('La sede tiene stock: trasladalo o ajustalo antes de desactivarla.');
      const { rows: [p] } = await c.query(
        `SELECT 1 FROM logic.remito WHERE (origen_sede_id = $1 OR destino_sede_id = $1) AND estado IN ('borrador','enviado') LIMIT 1`,
        [req.params.id]);
      if (p) throw new ErrorUsuario('La sede tiene remitos sin cerrar.');
    }
    // La central consolida las finanzas y no vende: no puede tener puntos de venta.
    if (s.es_central) {
      const { rows: [pv] } = await c.query('SELECT nombre FROM pos.integracion WHERE sede_id = $1 AND activa LIMIT 1', [req.params.id]);
      if (pv) throw new ErrorUsuario(`La sede central no tiene puntos de venta, y esta tiene "${pv.nombre}".`);
      await c.query('UPDATE org.sede SET es_central = false WHERE es_central AND id <> $1', [req.params.id]);
    } else {
      const { rows: [era] } = await c.query('SELECT es_central FROM org.sede WHERE id = $1', [req.params.id]);
      if (era.es_central) throw new ErrorUsuario('Siempre tiene que haber una sede central: marcá otra como central y esta deja de serlo.');
    }
    await c.query('UPDATE org.sede SET nombre=$1, tipo=$2, direccion=$3, activa=$4, es_central=$5 WHERE id=$6',
      [s.nombre, s.tipo, s.direccion, s.activa, s.es_central, req.params.id]);
  });
  res.json({ ok: true, id: req.params.id });
}));

// ── Unidades productivas ─────────────────────────────────────────────────────────────────────
r.get('/unidades-productivas', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT up.id, up.nombre, up.activa, up.sede_id, s.nombre AS sede, up.almacen_id, a.nombre AS almacen,
            up.ubicacion_salida_id, ua.nombre || ' · ' || u.nombre AS ubicacion_salida,
            (SELECT COUNT(*)::int FROM logic.receta re WHERE re.unidad_productiva_id = up.id AND re.vigente) AS recetas
       FROM logic.unidad_productiva up
       JOIN org.sede s ON s.id = up.sede_id
       JOIN logic.almacen a ON a.id = up.almacen_id
       LEFT JOIN logic.ubicacion u ON u.id = up.ubicacion_salida_id
       LEFT JOIN logic.almacen ua ON ua.id = u.almacen_id
      WHERE ($1::uuid[] IS NULL OR up.sede_id = ANY($1))
      ORDER BY up.activa DESC, s.nombre, up.nombre`, [filtroSedes(req)]);
  res.json({ ok: true, unidades: rows });
}));

async function leerUnidad(c, b) {
  const u = {
    nombre: texto(b.nombre, { campo: 'el nombre', requerido: true }),
    almacen_id: texto(b.almacen_id, { campo: 'el almacén de insumos', requerido: true }),
    ubicacion_salida_id: texto(b.ubicacion_salida_id),
    activa: b.activa === undefined ? true : !!b.activa,
  };
  // La sede sale del almacén de insumos: no hay forma de elegir una que no coincida.
  const { rows: [a] } = await c.query(
    'SELECT a.sede_id, s.nombre AS sede FROM logic.almacen a JOIN org.sede s ON s.id = a.sede_id WHERE a.id = $1::uuid', [u.almacen_id]);
  if (!a) throw new ErrorUsuario('No existe ese almacén.');
  return { ...u, sede_id: a.sede_id, sede: a.sede };
}

r.post('/unidades-productivas', h(async (req, res) => {
  const { rows: [n] } = await enTransaccion(async c => {
    const u = await leerUnidad(c, req.body);
    exigirEncargadoDe(req, u.sede_id, u.sede);
    return c.query(
      `INSERT INTO logic.unidad_productiva (sede_id, nombre, almacen_id, ubicacion_salida_id, activa)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [u.sede_id, u.nombre, u.almacen_id, u.ubicacion_salida_id, u.activa]);
  });
  res.status(201).json({ ok: true, id: n.id });
}));

r.put('/unidades-productivas/:id', h(async (req, res) => {
  await enTransaccion(async c => {
    const { rows: [ant] } = await c.query(
      `SELECT up.sede_id, s.nombre FROM logic.unidad_productiva up JOIN org.sede s ON s.id = up.sede_id
        WHERE up.id = $1::uuid FOR UPDATE OF up`, [req.params.id]);
    if (!ant) throw new ErrorUsuario('No existe esa unidad productiva.', 404);
    exigirEncargadoDe(req, ant.sede_id, ant.nombre);
    const u = await leerUnidad(c, req.body);
    if (u.sede_id !== ant.sede_id) throw new ErrorUsuario('Una unidad productiva no cambia de sede.');
    await c.query('UPDATE logic.unidad_productiva SET nombre=$1, almacen_id=$2, ubicacion_salida_id=$3, activa=$4 WHERE id=$5',
      [u.nombre, u.almacen_id, u.ubicacion_salida_id, u.activa, req.params.id]);
  });
  res.json({ ok: true, id: req.params.id });
}));

module.exports = r;
