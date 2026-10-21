// API de administración: usuarios, roles por sede, dispositivos de cocina y registro de accesos.
// La política de auth.js deja entrar sólo a administradores (salvo GET /sedes, que lo usan las
// pantallas de almacenes).
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, texto, h, enTransaccion } = require('./util');
const { hashClave, claveTemporal, registrarAcceso } = require('./auth');

const r = express.Router();
const ROLES = ['encargado', 'operador', 'consulta'];

r.get('/sedes', h(async (req, res) => {
  const { rows } = await pool.query('SELECT id, nombre, tipo, direccion, activa FROM org.sede ORDER BY tipo, nombre');
  res.json({ ok: true, sedes: rows });
}));

r.get('/usuarios', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.usuario, u.nombre, u.es_admin, u.finanzas, u.activo, u.debe_cambiar_clave,
            u.pin_hash IS NOT NULL AS tiene_pin, u.fallos_pin >= 5 AS pin_inhabilitado,
            u.bloqueado_hasta > now() AS bloqueado, u.creado_en,
            COALESCE((SELECT json_agg(json_build_object('sede_id', x.sede_id, 'rol', x.rol))
                        FROM org.usuario_sede x WHERE x.usuario_id = u.id), '[]') AS roles,
            (SELECT COUNT(*)::int FROM org.sesion s WHERE s.usuario_id = u.id AND s.cerrada_en IS NULL
                AND now() < s.vence_en AND now() - s.usada_en < s.inactividad) AS sesiones,
            (SELECT max(a.ocurrido_en) FROM org.acceso a
              WHERE a.usuario = u.usuario AND a.evento IN ('entrada','entrada_pin')) AS ultima_entrada
       FROM org.usuario u ORDER BY u.activo DESC, u.nombre`);
  res.json({ ok: true, usuarios: rows });
}));

function leerUsuario(b) {
  const u = {
    nombre: texto(b.nombre, { campo: 'el nombre', requerido: true }),
    es_admin: !!b.es_admin,
    finanzas: !!b.finanzas,
    activo: b.activo === undefined ? true : !!b.activo,
    roles: Array.isArray(b.roles) ? b.roles : [],
  };
  const sedes = new Set();
  for (const x of u.roles) {
    if (!ROLES.includes(x.rol)) throw new ErrorUsuario('Rol inválido.');
    if (sedes.has(x.sede_id)) throw new ErrorUsuario('Una sede está repetida: va un solo rol por sede.');
    sedes.add(x.sede_id);
  }
  if (!u.es_admin && !u.finanzas && !u.roles.length)
    throw new ErrorUsuario('Asigná al menos una sede con su rol, o marcalo como administrador o de finanzas.');
  return u;
}

const descRoles = async (c, roles) => {
  if (!roles.length) return 'sin sedes';
  const { rows } = await c.query('SELECT id, nombre FROM org.sede WHERE id = ANY($1::uuid[])', [roles.map(x => x.sede_id)]);
  return roles.map(x => `${(rows.find(s => s.id === x.sede_id) || {}).nombre || '?'}: ${x.rol}`).join(', ');
};

async function guardarRoles(c, id, roles) {
  await c.query('DELETE FROM org.usuario_sede WHERE usuario_id = $1', [id]);
  for (const x of roles)
    await c.query('INSERT INTO org.usuario_sede (usuario_id, sede_id, rol) VALUES ($1,$2,$3)', [id, x.sede_id, x.rol]);
}

// El alta devuelve una clave temporal que se muestra UNA vez: el usuario la cambia al entrar.
r.post('/usuarios', h(async (req, res) => {
  const u = leerUsuario(req.body);
  const usuario = String(req.body.usuario || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(usuario))
    throw new ErrorUsuario('El usuario va en minúsculas, de 3 a 32 caracteres, sin espacios ni acentos (puede llevar . _ -).');
  const temporal = claveTemporal();
  const hash = await hashClave(temporal);
  const id = await enTransaccion(async c => {
    const { rows: [n] } = await c.query(
      `INSERT INTO org.usuario (usuario, nombre, clave_hash, es_admin, finanzas, activo)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [usuario, u.nombre, hash, u.es_admin, u.finanzas, u.activo]);
    await guardarRoles(c, n.id, u.roles);
    await registrarAcceso(c, { usuario, evento: 'alta', req, por: req.usuario.usuario,
      detalle: (u.es_admin ? 'administrador; ' : '') + (u.finanzas ? 'finanzas; ' : '') + await descRoles(c, u.roles) });
    return n.id;
  });
  res.status(201).json({ ok: true, id, clave_temporal: temporal });
}));

r.put('/usuarios/:id', h(async (req, res) => {
  const u = leerUsuario(req.body);
  const ok = await enTransaccion(async c => {
    const { rows: [ant] } = await c.query('SELECT usuario, activo FROM org.usuario WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!ant) return false;
    await c.query('UPDATE org.usuario SET nombre = $1, es_admin = $2, activo = $3, finanzas = $5 WHERE id = $4',
      [u.nombre, u.es_admin, u.activo, req.params.id, u.finanzas]);
    await guardarRoles(c, req.params.id, u.roles);
    // Desactivado, se va en el momento: no espera a que se le venza la sesión.
    if (!u.activo) await c.query('UPDATE org.sesion SET cerrada_en = now() WHERE usuario_id = $1 AND cerrada_en IS NULL', [req.params.id]);
    await registrarAcceso(c, { usuario: ant.usuario, evento: 'permisos', req, por: req.usuario.usuario,
      detalle: (u.activo ? '' : 'desactivado; ') + (u.es_admin ? 'administrador; ' : '') + (u.finanzas ? 'finanzas; ' : '') + await descRoles(c, u.roles) });
    return true;
  });
  if (!ok) return res.status(404).json({ ok: false, error: 'No existe ese usuario.' });
  res.json({ ok: true });
}));

// Blanqueo: clave temporal nueva, desbloqueo y cierre de todas sus sesiones.
r.post('/usuarios/:id/clave', h(async (req, res) => {
  const temporal = claveTemporal();
  const hash = await hashClave(temporal);
  const ok = await enTransaccion(async c => {
    const { rows: [u] } = await c.query(
      `UPDATE org.usuario SET clave_hash = $1, debe_cambiar_clave = true, clave_cambiada_en = now(),
              fallos_clave = 0, bloqueado_hasta = NULL, fallos_pin = 0
        WHERE id = $2 RETURNING usuario`, [hash, req.params.id]);
    if (!u) return false;
    await c.query('UPDATE org.sesion SET cerrada_en = now() WHERE usuario_id = $1 AND cerrada_en IS NULL', [req.params.id]);
    await registrarAcceso(c, { usuario: u.usuario, evento: 'clave_blanqueada', req, por: req.usuario.usuario });
    return true;
  });
  if (!ok) return res.status(404).json({ ok: false, error: 'No existe ese usuario.' });
  res.json({ ok: true, clave_temporal: temporal });
}));

r.post('/usuarios/:id/desbloquear', h(async (req, res) => {
  const { rows: [u] } = await pool.query(
    'UPDATE org.usuario SET fallos_clave = 0, bloqueado_hasta = NULL, fallos_pin = 0 WHERE id = $1 RETURNING usuario', [req.params.id]);
  if (!u) return res.status(404).json({ ok: false, error: 'No existe ese usuario.' });
  await registrarAcceso(null, { usuario: u.usuario, evento: 'desbloqueo', req, por: req.usuario.usuario });
  res.json({ ok: true });
}));

r.post('/usuarios/:id/quitar-pin', h(async (req, res) => {
  const { rows: [u] } = await pool.query(
    'UPDATE org.usuario SET pin_hash = NULL, fallos_pin = 0 WHERE id = $1 RETURNING usuario', [req.params.id]);
  if (!u) return res.status(404).json({ ok: false, error: 'No existe ese usuario.' });
  await registrarAcceso(null, { usuario: u.usuario, evento: 'pin_quitado', req, por: req.usuario.usuario });
  res.json({ ok: true });
}));

r.post('/usuarios/:id/cerrar-sesiones', h(async (req, res) => {
  const { rows: [u] } = await pool.query('SELECT usuario FROM org.usuario WHERE id = $1', [req.params.id]);
  if (!u) return res.status(404).json({ ok: false, error: 'No existe ese usuario.' });
  const { rowCount } = await pool.query(
    'UPDATE org.sesion SET cerrada_en = now() WHERE usuario_id = $1 AND cerrada_en IS NULL', [req.params.id]);
  await registrarAcceso(null, { usuario: u.usuario, evento: 'sesiones_cerradas', req, por: req.usuario.usuario,
    detalle: `${rowCount} sesión(es)` });
  res.json({ ok: true, cerradas: rowCount });
}));

// ── Dispositivos de cocina ───────────────────────────────────────────────────────────────────
r.get('/dispositivos', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.descripcion, d.creado_en, d.usado_en, d.vence_en, d.revocado_en, u.nombre AS habilitado_por,
            d.revocado_en IS NULL AND now() < d.vence_en AS vigente
       FROM org.dispositivo d JOIN org.usuario u ON u.id = d.habilitado_por
      ORDER BY (d.revocado_en IS NULL AND now() < d.vence_en) DESC, d.usado_en DESC LIMIT 200`);
  res.json({ ok: true, dispositivos: rows });
}));

r.post('/dispositivos/:id/revocar', h(async (req, res) => {
  const { rows: [d] } = await pool.query(
    'UPDATE org.dispositivo SET revocado_en = now() WHERE id = $1 AND revocado_en IS NULL RETURNING descripcion', [req.params.id]);
  if (!d) throw new ErrorUsuario('Ese dispositivo no existe o ya estaba revocado.');
  await registrarAcceso(null, { usuario: null, evento: 'dispositivo_revocado', req, por: req.usuario.usuario, detalle: d.descripcion });
  res.json({ ok: true });
}));

// ── Registro de accesos ──────────────────────────────────────────────────────────────────────
r.get('/accesos', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ocurrido_en, usuario, evento, ip, detalle, por FROM org.acceso
      WHERE ($1::text IS NULL OR usuario = $1 OR por = $1)
      ORDER BY ocurrido_en DESC, id DESC LIMIT 300`, [texto(req.query.usuario)]);
  res.json({ ok: true, accesos: rows });
}));

module.exports = r;
