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
  if (s.es_central && s.tipo === 'local') throw new ErrorUsuario('Un punto de venta no puede ser la sede central: la central consolida, no vende.');
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
    // Un punto de venta siempre lo tiene: es el único lugar por donde pasa su mercadería.
    if (s.tipo === 'local' || req.body.crear_almacen !== false) {
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
    // El tipo no cambia: un local tiene un solo almacén y una sola ubicación, un centro no tiene sistema de venta.
    if (ant.tipo !== s.tipo) throw new ErrorUsuario('El tipo de una sede no cambia: creá una sede nueva.');
    await c.query('UPDATE org.sede SET nombre=$1, tipo=$2, direccion=$3, activa=$4, es_central=$5 WHERE id=$6',
      [s.nombre, s.tipo, s.direccion, s.activa, s.es_central, req.params.id]);
    // El sistema de venta y su cuenta de efectivo llevan el nombre de la sede.
    const { rows: [pv] } = await c.query(`SELECT id, nombre, cuenta_efectivo_id FROM pos.integracion WHERE sede_id = $1 AND sistema <> 'pedidosya'`, [req.params.id]);
    if (pv && pv.nombre !== s.nombre) {
      await c.query('UPDATE pos.integracion SET nombre = $1 WHERE id = $2', [s.nombre, pv.id]);
      if (pv.cuenta_efectivo_id) await c.query('UPDATE fin.cuenta SET nombre = $1 WHERE id = $2', ['Efectivo · ' + s.nombre, pv.cuenta_efectivo_id]);
    }
    // PedidosYa, el segundo sistema del local (comparte la cuenta de efectivo con el principal).
    await c.query(`UPDATE pos.integracion SET nombre = $1 WHERE sede_id = $2 AND sistema = 'pedidosya' AND nombre <> $1`, ['PedidosYa · ' + s.nombre, req.params.id]);
  });
  res.json({ ok: true, id: req.params.id });
}));

// ── Comercios de un local ────────────────────────────────────────────────────────────────────
// Varios comercios que comparten punto de venta, caja y cuentas (SORELLE: Wera Sushi y Lo de Titi Bodegón) se separan en
// ventas y resultados: cada uno dice qué rubros del sistema de venta son suyos (los demás se reparten en proporción) y qué
// tiendas de PedidosYa. Lo financiero sigue siendo del local. La consulta la usan la ficha de la sede y los tableros.
r.get('/comercios', h(async (req, res) => {
  const sede = texto(req.query.sede);
  const [{ rows: comercios }, { rows: rubros }, { rows: tiendas }] = await Promise.all([
    pool.query(`SELECT c.id, c.sede_id, s.nombre AS sede, c.nombre, c.rubros, c.tiendas, c.activo FROM org.comercio c JOIN org.sede s ON s.id = c.sede_id
                 WHERE ($1::uuid IS NULL OR c.sede_id = $1::uuid) ORDER BY s.nombre, c.nombre`, [sede]),
    // Los rubros que el sistema de venta del local informó en los últimos 90 días, con lo vendido, para elegir los propios.
    sede ? pool.query(`SELECT a.rubro, SUM(a.venta)::numeric(16,2)::text AS venta, COUNT(DISTINCT a.codigo)::int AS articulos
                         FROM pos.articulo_dia a JOIN pos.integracion i ON i.id = a.integracion_id
                        WHERE i.sede_id = $1::uuid AND a.dia >= current_date - 90 AND a.rubro IS NOT NULL
                        GROUP BY a.rubro ORDER BY SUM(a.venta) DESC`, [sede]) : { rows: [] },
    sede ? pool.query(`SELECT unnest(tiendas) AS tienda FROM pos.integracion WHERE sede_id = $1::uuid AND sistema = 'pedidosya'`, [sede]) : { rows: [] },
  ]);
  res.json({ ok: true, comercios, rubros, tiendas: tiendas.map(t => t.tienda) });
}));
function leerComercio(b) {
  const lista = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x ?? '').trim()).filter(Boolean))];
  return { nombre: texto(b.nombre, { campo: 'el nombre del comercio', requerido: true }), rubros: lista(b.rubros), tiendas: lista(b.tiendas),
           activo: b.activo === undefined ? true : !!b.activo };
}
// Un rubro o una tienda es de un solo comercio del local: si no, la misma venta se contaría dos veces.
async function controlarComercio(c, sedeId, id, x) {
  const { rows: [s] } = await c.query('SELECT tipo FROM org.sede WHERE id = $1::uuid', [sedeId]);
  if (!s) throw new ErrorUsuario('No existe esa sede.', 404);
  if (s.tipo !== 'local') throw new ErrorUsuario('Los comercios son de un punto de venta.');
  const { rows: [dup] } = await c.query(
    `SELECT nombre, (SELECT array_agg(r) FROM unnest(rubros) r WHERE lower(r) = ANY (SELECT lower(y) FROM unnest($3::text[]) y)) AS rubros,
            (SELECT array_agg(t) FROM unnest(tiendas) t WHERE t = ANY ($4::text[])) AS tiendas
       FROM org.comercio WHERE sede_id = $1::uuid AND activo AND id IS DISTINCT FROM $2::uuid
        AND (EXISTS (SELECT 1 FROM unnest(rubros) r WHERE lower(r) = ANY (SELECT lower(y) FROM unnest($3::text[]) y)) OR tiendas && $4::text[])
      LIMIT 1`, [sedeId, id, x.rubros, x.tiendas]);
  if (dup && x.activo) throw new ErrorUsuario(`${[...(dup.rubros || []), ...(dup.tiendas || [])].join(', ')} ya es de ${dup.nombre}: un rubro o una tienda va en un solo comercio.`);
}
r.post('/sedes/:id/comercios', h(async (req, res) => {
  const x = leerComercio(req.body);
  const id = await enTransaccion(async c => {
    await controlarComercio(c, req.params.id, null, x);
    const { rows: [n] } = await c.query('INSERT INTO org.comercio (sede_id, nombre, rubros, tiendas, activo) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.params.id, x.nombre, x.rubros, x.tiendas, x.activo]);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));
r.put('/sedes/comercios/:id', h(async (req, res) => {
  const x = leerComercio(req.body);
  await enTransaccion(async c => {
    const { rows: [ant] } = await c.query('SELECT sede_id FROM org.comercio WHERE id = $1::uuid FOR UPDATE', [req.params.id]);
    if (!ant) throw new ErrorUsuario('No existe ese comercio.', 404);
    await controlarComercio(c, ant.sede_id, req.params.id, x);
    await c.query('UPDATE org.comercio SET nombre = $1, rubros = $2, tiendas = $3, activo = $4 WHERE id = $5', [x.nombre, x.rubros, x.tiendas, x.activo, req.params.id]);
  });
  res.json({ ok: true });
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
