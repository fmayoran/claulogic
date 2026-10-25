// Autenticación y permisos.
//
// Sesión por cookie HttpOnly con un token al azar; en la base queda su sha256. Dos formas de entrar:
//   - usuario y clave, desde cualquier navegador;
//   - PIN, sólo en un DISPOSITIVO de cocina que un encargado habilitó entrando con su clave. El PIN
//     es para cambiar de usuario rápido en una tablet compartida, no para entrar desde afuera.
//
// Permisos en dos capas. Acá, por ruta: quién puede mirar, operar, gestionar el catálogo o
// administrar usuarios. En la base, por sede: los triggers del libro mayor, los conteos y las
// lecturas de frío verifican que el usuario tenga rol en la sede de la ubicación, y firman.
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { pool, contexto } = require('./db');
const { ErrorUsuario, texto, h, enTransaccion } = require('./util');

const scrypt = promisify(crypto.scrypt);

// ── Claves ───────────────────────────────────────────────────────────────────────────────────
// scrypt con N=2^15: 32 MB por cálculo. Más alto sería mejor contra fuerza bruta, pero el VPS no
// tiene swap y comparte la memoria con otras apps; un pico de logins no puede tumbarlo.
const N = 2 ** 15, R = 8, P = 1, LARGO = 32, MAXMEM = 64 * 1024 * 1024;

async function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const dk = await scrypt(String(clave), sal, LARGO, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${dk.toString('base64')}`;
}

async function verificarClave(clave, guardado) {
  const [alg, n, r, p, sal, dk] = String(guardado || '').split('$');
  if (alg !== 'scrypt') return false;
  const esperado = Buffer.from(dk, 'base64');
  const calc = await scrypt(String(clave), Buffer.from(sal, 'base64'), esperado.length,
    { N: +n, r: +r, p: +p, maxmem: MAXMEM });
  return crypto.timingSafeEqual(calc, esperado);
}
// Para un usuario que no existe se calcula igual un hash: si no, la demora de la respuesta dice
// qué usuarios existen.
let _falso;
const hashFalso = async () => (_falso ||= await hashClave(crypto.randomBytes(12).toString('hex')));

function validarClave(clave, usuario) {
  const c = String(clave || '');
  if (c.length < 8) throw new ErrorUsuario('La clave tiene que tener al menos 8 caracteres.');
  if (c.length > 200) throw new ErrorUsuario('La clave es demasiado larga.');
  // Con usuarios de 3 letras ("ana") la regla rechazaría claves sanas ("banana-split").
  const u = String(usuario).toLowerCase();
  if (c.toLowerCase() === u || (u.length >= 4 && c.toLowerCase().includes(u)))
    throw new ErrorUsuario('La clave no puede contener el nombre de usuario.');
  return c;
}

// Un PIN de 4 dígitos son 10.000 combinaciones; los obvios (1234, 0000, 2580) son los primeros que
// se prueban. Al quinto fallo se inhabilita, así que lo que queda es no regalar los primeros cinco.
function validarPin(pin) {
  const p = String(pin || '');
  if (!/^\d{4,6}$/.test(p)) throw new ErrorUsuario('El PIN va de 4 a 6 dígitos.');
  const d = [...p].map(Number);
  const paso = d[1] - d[0];
  if (Math.abs(paso) <= 1 && d.every((x, i) => i === 0 || x - d[i - 1] === paso))
    throw new ErrorUsuario('El PIN no puede ser una serie (1111, 1234, 4321): es lo primero que se prueba.');
  if (['2580', '0852', '1004', '2000', '1212', '6969', '1122', '121212', '112233'].includes(p))
    throw new ErrorUsuario('Ese PIN es de los más usados: elegí otro.');
  return p;
}

// Clave temporal para altas y blanqueos: sin letras que se confundan (0/O, 1/l/I).
function claveTemporal() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(12);
  const s = [...b].map(x => abc[x % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

// ── Cookies y tokens ─────────────────────────────────────────────────────────────────────────
const COOKIE_SESION = 'cl_sesion', COOKIE_DISP = 'cl_dispositivo';
const DISPOSITIVO_DIAS = 90;
// Clave en un navegador propio: 12 h sin uso, 7 días como máximo. En un dispositivo de cocina,
// 30 min sin uso: la tablet queda sobre la mesada y el siguiente no tiene que operar con el
// usuario del anterior.
const DURACION = {
  propio: { inactividad: '12 hours', vence: '7 days' },
  cocina: { inactividad: '30 minutes', vence: '12 hours' },
};

function cookies(req) {
  const out = {};
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}
function ponerCookie(req, res, nombre, valor, maxAgeSeg, sameSite = 'Lax') {
  const partes = [`${nombre}=${valor}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (req.secure) partes.push('Secure');
  if (maxAgeSeg !== undefined) partes.push(`Max-Age=${maxAgeSeg}`);
  res.append('Set-Cookie', partes.join('; '));
}
const nuevoToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest();

// ── Freno por IP ─────────────────────────────────────────────────────────────────────────────
// El bloqueo por usuario frena que se adivine la clave de UNO; esto frena que se pruebe la misma
// clave contra todos. En memoria: con un solo proceso alcanza, y un reinicio lo pone en cero.
const FALLOS_IP = 20, VENTANA_MS = 15 * 60 * 1000;
const fallosIp = new Map();
setInterval(() => {
  const t = Date.now();
  for (const [ip, f] of fallosIp) if (t - f.desde > VENTANA_MS) fallosIp.delete(ip);
}, 60 * 1000).unref();
function frenoIp(req) {
  const f = fallosIp.get(req.ip);
  if (f && Date.now() - f.desde < VENTANA_MS && f.n >= FALLOS_IP)
    throw new ErrorUsuario('Demasiados intentos fallidos desde esta conexión. Esperá unos minutos.', 429);
}
function falloIp(req) {
  const f = fallosIp.get(req.ip);
  if (!f || Date.now() - f.desde > VENTANA_MS) fallosIp.set(req.ip, { n: 1, desde: Date.now() });
  else f.n++;
}

async function registrarAcceso(c, { usuario, evento, req, detalle = null, por = null }) {
  await (c || pool).query('INSERT INTO org.acceso (usuario, evento, ip, detalle, por) VALUES ($1,$2,$3,$4,$5)',
    [usuario, evento, req ? req.ip : null, detalle, por]);
}

// ── Sesión ───────────────────────────────────────────────────────────────────────────────────
async function dispositivoDe(req) {
  const t = cookies(req)[COOKIE_DISP];
  if (!t) return null;
  const { rows: [d] } = await pool.query(
    `UPDATE org.dispositivo SET usado_en = now()
      WHERE token_hash = $1 AND revocado_en IS NULL AND now() < vence_en
      RETURNING id, descripcion`, [hashToken(t)]);
  return d || null;
}

async function sesionDe(req) {
  const t = cookies(req)[COOKIE_SESION];
  if (!t) return null;
  const { rows: [s] } = await pool.query(
    `SELECT s.id AS sesion_id, s.metodo, s.dispositivo_id, now() - s.usada_en > interval '1 minute' AS tocar,
            u.id, u.usuario, u.nombre, u.es_admin, u.finanzas, u.debe_cambiar_clave, u.pin_hash IS NOT NULL AS tiene_pin,
            COALESCE((SELECT json_agg(json_build_object('sede_id', se.id, 'sede', se.nombre, 'tipo', se.tipo, 'rol', x.rol)
                                      ORDER BY se.nombre)
                        FROM org.usuario_sede x JOIN org.sede se ON se.id = x.sede_id
                       WHERE x.usuario_id = u.id AND se.activa), '[]') AS roles
       FROM org.sesion s JOIN org.usuario u ON u.id = s.usuario_id
      WHERE s.token_hash = $1 AND s.cerrada_en IS NULL AND u.activo
        AND now() < s.vence_en AND now() - s.usada_en < s.inactividad
        AND (s.dispositivo_id IS NULL OR EXISTS (
               SELECT 1 FROM org.dispositivo d WHERE d.id = s.dispositivo_id AND d.revocado_en IS NULL))`,
    [hashToken(t)]);
  if (!s) return null;
  // La marca de uso se actualiza como mucho una vez por minuto: escribir en cada pedido es carga
  // sin información.
  if (s.tocar) await pool.query('UPDATE org.sesion SET usada_en = now() WHERE id = $1', [s.sesion_id]);
  delete s.tocar;
  return s;
}

async function abrirSesion(c, req, res, usuario, metodo, dispositivo) {
  const d = DURACION[dispositivo ? 'cocina' : 'propio'];
  const token = nuevoToken();
  await c.query(
    `INSERT INTO org.sesion (token_hash, usuario_id, dispositivo_id, metodo, inactividad, vence_en, ip, agente)
     VALUES ($1, $2, $3, $4, $5::interval, now() + $6::interval, $7, $8)`,
    [hashToken(token), usuario.id, dispositivo ? dispositivo.id : null, metodo, d.inactividad, d.vence,
     req.ip, String(req.headers['user-agent'] || '').slice(0, 300)]);
  // Sesiones viejas: se limpian de paso, no hace falta un cron para esto.
  await c.query(`DELETE FROM org.sesion WHERE vence_en < now() - interval '30 days'`);
  ponerCookie(req, res, COOKIE_SESION, token);   // sin Max-Age: se va al cerrar el navegador
}

async function cerrarSesionActual(req) {
  const t = cookies(req)[COOKIE_SESION];
  if (t) await pool.query('UPDATE org.sesion SET cerrada_en = now() WHERE token_hash = $1 AND cerrada_en IS NULL', [hashToken(t)]);
}

// ── Permisos ─────────────────────────────────────────────────────────────────────────────────
//   ver:       cualquier rol en alguna sede.
//   operar:    encargado u operador en alguna sede (la sede concreta la verifica la base).
//   gestionar: encargado en alguna sede (la sede concreta, el handler).
//   catalogo:  encargado del centro. Productos, recetas, proveedores, unidades y compras son del
//              grupo entero, y los administra quien abastece.
//   finanzas:  comprobantes de proveedor, cuenta corriente y libro IVA. Global, lo da un admin.
//   proveedor: dar de alta o editar un proveedor: el catálogo o finanzas (lo carga quien recibe la factura).
//   admin:     usuarios, sedes y dispositivos.
function puede(u, permiso) {
  if (!u) return false;
  if (u.es_admin) return true;
  const roles = u.roles || [];
  switch (permiso) {
    case 'ver': return roles.length > 0 || !!u.finanzas;
    case 'operar': return roles.some(r => r.rol === 'encargado' || r.rol === 'operador');
    case 'gestionar': return roles.some(r => r.rol === 'encargado');
    case 'catalogo': return roles.some(r => r.rol === 'encargado' && r.tipo === 'centro');
    case 'finanzas': return !!u.finanzas;
    case 'proveedor': return puede(u, 'catalogo') || puede(u, 'finanzas');
    case 'medios': return puede(u, 'gestionar') || puede(u, 'finanzas');
    default: return false;
  }
}

const NOMBRE_PERMISO = {
  ver: 'No tenés ninguna sede asignada. Pedile a un administrador que te dé acceso.',
  operar: 'Tu rol es de consulta: no podés registrar operaciones.',
  gestionar: 'Hace falta ser encargado para esto.',
  catalogo: 'El catálogo, las recetas y las compras los gestiona el encargado del centro.',
  admin: 'Sólo un administrador puede hacer esto.',
  finanzas: 'Hace falta permiso de finanzas para esto.',
  proveedor: 'Los proveedores los cargan el encargado del centro o finanzas.',
  medios: 'Los medios de cobro los asigna el encargado del local o finanzas.',
};

function exigir(req, permiso) {
  if (!puede(req.usuario, permiso)) throw new ErrorUsuario(NOMBRE_PERMISO[permiso], 403);
}

// Rol del usuario en una sede concreta ('admin' si es administrador, null si no tiene).
function rolEn(u, sedeId) {
  if (u.es_admin) return 'admin';
  const r = (u.roles || []).find(x => x.sede_id === sedeId);
  return r ? r.rol : null;
}
function exigirEncargadoDe(req, sedeId, nombreSede) {
  if (!['admin', 'encargado'].includes(rolEn(req.usuario, sedeId)))
    throw new ErrorUsuario(`Hace falta ser encargado de ${nombreSede || 'esa sede'} para esto.`, 403);
}
function exigirOperarEn(req, sedeId, nombreSede) {
  if (!['admin', 'encargado', 'operador'].includes(rolEn(req.usuario, sedeId)))
    throw new ErrorUsuario(`No tenés permiso para operar en ${nombreSede || 'esa sede'}.`, 403);
}

// ── Lo que cada uno ve ───────────────────────────────────────────────────────────────────────
// Stock, movimientos, frío, producciones, remitos y pedidos se ven sólo de las sedes donde el
// usuario tiene rol; el administrador ve todo. El catálogo (productos, recetas, proveedores) es del
// grupo entero y lo ven todos. Las consultas reciben un arreglo de sedes, o null para "todas".
function sedesVisibles(u) {
  return u.es_admin ? null : (u.roles || []).map(r => r.sede_id);
}
// Las visibles, o sólo la pedida en `?sede=` si el usuario la puede ver.
function filtroSedes(req) {
  const visibles = sedesVisibles(req.usuario);
  const pedida = texto(req.query.sede);
  if (!pedida) return visibles;
  if (visibles && !visibles.includes(pedida)) throw new ErrorUsuario('No tenés acceso a esa sede.', 403);
  return [pedida];
}

// Permiso por ruta, para lo que modifica. Lo que no está en la lista exige `catalogo`: una ruta
// nueva arranca cerrada, no abierta.
const POLITICA = [
  [/^\/(usuarios|sedes|dispositivos)(\/|$)/, 'admin'],
  [/^\/(ajustes|movimientos|lecturas|producciones)$/, 'operar'],
  [/^\/compras\/[^/]+\/recibir$/, 'operar'],
  [/^\/movimientos\/\d+\/anular$/, 'gestionar'],
  [/^\/(almacenes|ubicaciones|unidades-productivas)(\/|$)/, 'gestionar'],
  // Remitos y pedidos: la sede concreta (despacha, pide o recibe) la verifica cada handler, y los
  // traslados, además, la base.
  [/^\/(remitos|pedidos)(\/|$)/, 'operar'],
  // POS: la sede concreta la verifica cada handler. Configurar la integración y las equivalencias
  // de artículos es de encargado; importar y descontar el consumo, de quien opera; los cobros y la
  // cuenta de cada medio, de finanzas.
  [/^\/pos\/integraciones(\/[^/]+)?$/, 'gestionar'],
  [/^\/pos\/integraciones\/[^/]+\/(sincronizar|importar)$/, 'operar'],
  [/^\/pos\/importaciones\/[^/]+\/(consumo|anular)$/, 'operar'],
  [/^\/pos\/importaciones\/[^/]+\/cobros$/, 'finanzas'],
  [/^\/pos\/articulos\//, 'gestionar'],
  // Asignar a cada medio del sistema su medio de pago global: el encargado del local o finanzas.
  [/^\/pos\/medios\//, 'medios'],
  [/^\/proveedores(\/[^/]+)?$/, 'proveedor'],
  // Proceso de abastecimiento: la compra es del catálogo (por defecto); la factura armada desde la
  // compra, de finanzas (y el handler lo vuelve a exigir cuando la compra trae comprobante).
  [/^\/abastecimiento\/[^/]+\/comprobante$/, 'finanzas'],
];
const SOLO_ADMIN_LECTURA = /^\/(usuarios|dispositivos|accesos)(\/|$)/;

function permisoDe(req) {
  // Comprobantes, deuda y libro IVA: ni siquiera se miran sin permiso de finanzas.
  if (/^\/fin\//.test(req.path)) return 'finanzas';
  if (req.method === 'GET' || req.method === 'HEAD') return SOLO_ADMIN_LECTURA.test(req.path) ? 'admin' : 'ver';
  for (const [re, p] of POLITICA) if (re.test(req.path)) return p;
  return 'catalogo';
}

// Middleware para todo /api salvo /sesion: exige sesión, aplica la política y corre el resto del
// pedido con el usuario en el contexto de la base.
const exigirSesion = h(async (req, res, next) => {
  // Lo que modifica viaja como JSON. Un formulario de otro sitio no puede mandar JSON sin que el
  // navegador pregunte antes (CORS), así que esto, con SameSite, cierra la puerta al CSRF.
  if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json'))
    throw new ErrorUsuario('Formato de pedido inválido.', 415);
  const s = await sesionDe(req);
  if (!s) return res.status(401).json({ ok: false, error: 'Tu sesión terminó: volvé a entrar.', sesion: false });
  req.usuario = s;
  if (s.debe_cambiar_clave && !/^\/cuenta\/clave$/.test(req.path))
    return res.status(403).json({ ok: false, error: 'Antes de seguir, cambiá la clave temporal.', cambiar_clave: true });
  if (!/^\/cuenta\//.test(req.path)) exigir(req, permisoDe(req));
  contexto.run({ usuario: s.usuario }, next);
});

// ── Rutas de sesión y cuenta ─────────────────────────────────────────────────────────────────
const r = express.Router();

function publico(u) {
  return { id: u.id, usuario: u.usuario, nombre: u.nombre, es_admin: u.es_admin, finanzas: u.finanzas, roles: u.roles,
           tiene_pin: u.tiene_pin, metodo: u.metodo, en_dispositivo: !!u.dispositivo_id,
           debe_cambiar_clave: u.debe_cambiar_clave,
           puede: Object.fromEntries(['ver', 'operar', 'gestionar', 'catalogo', 'admin', 'finanzas'].map(p => [p, puede(u, p)])) };
}

// Estado: quién está adentro y, en un dispositivo de cocina, quiénes pueden entrar con PIN.
r.get('/sesion', h(async (req, res) => {
  const [s, d] = await Promise.all([sesionDe(req), dispositivoDe(req)]);
  let pin = [];
  if (d) ({ rows: pin } = await pool.query(
    `SELECT id, nombre FROM org.usuario
      WHERE activo AND pin_hash IS NOT NULL AND fallos_pin < 5 AND NOT debe_cambiar_clave
        AND (es_admin OR EXISTS (SELECT 1 FROM org.usuario_sede x WHERE x.usuario_id = usuario.id))
      ORDER BY nombre`));
  res.json({ ok: true, usuario: s ? publico(s) : null,
             dispositivo: d ? { descripcion: d.descripcion, usuarios: pin } : null });
}));

const BLOQUEO_FALLOS = 5;

r.post('/sesion/entrar', h(async (req, res) => {
  frenoIp(req);
  const nombre = String(req.body.usuario || '').trim().toLowerCase().slice(0, 64);
  const clave = String(req.body.clave || '');
  if (!nombre || !clave) throw new ErrorUsuario('Falta el usuario o la clave.');
  const { rows: [u] } = await pool.query(
    `SELECT id, usuario, clave_hash, activo, es_admin, bloqueado_hasta > now() AS bloqueado,
            ceil(extract(epoch FROM bloqueado_hasta - now()) / 60) AS minutos,
            EXISTS (SELECT 1 FROM org.usuario_sede x WHERE x.usuario_id = usuario.id AND x.rol = 'encargado') AS encargado
       FROM org.usuario WHERE usuario = $1`, [nombre]);
  const ok = await verificarClave(clave, u ? u.clave_hash : await hashFalso());
  if (u && u.bloqueado) {
    // Ni siquiera con la clave correcta: si no, el bloqueo no frena nada.
    await registrarAcceso(null, { usuario: nombre, evento: 'bloqueado', req });
    throw new ErrorUsuario(`Usuario bloqueado por intentos fallidos. Probá de nuevo en ${u.minutos} min o pedile a un administrador que lo desbloquee.`, 429);
  }
  if (!u || !ok) {
    falloIp(req);
    if (u) {
      const { rows: [f] } = await pool.query(
        `UPDATE org.usuario SET fallos_clave = fallos_clave + 1,
                bloqueado_hasta = CASE WHEN fallos_clave + 1 >= $2 THEN now() + interval '15 minutes' END
          WHERE id = $1 RETURNING bloqueado_hasta IS NOT NULL AS bloqueo`, [u.id, BLOQUEO_FALLOS]);
      if (f.bloqueo) await pool.query('UPDATE org.usuario SET fallos_clave = 0 WHERE id = $1', [u.id]);
      await registrarAcceso(null, { usuario: nombre, evento: f.bloqueo ? 'bloqueo' : 'clave_incorrecta', req });
    } else {
      await registrarAcceso(null, { usuario: nombre, evento: 'usuario_inexistente', req });
    }
    throw new ErrorUsuario('Usuario o clave incorrectos.', 401);
  }
  if (!u.activo) {
    await registrarAcceso(null, { usuario: nombre, evento: 'inactivo', req });
    throw new ErrorUsuario('Ese usuario está desactivado.', 403);
  }

  let disp = await dispositivoDe(req);
  const habilitar = !disp && req.body.habilitar_dispositivo;
  if (habilitar && !u.es_admin && !u.encargado)
    throw new ErrorUsuario('Sólo un encargado o un administrador puede habilitar un dispositivo de cocina.', 403);

  await enTransaccion(async c => {
    await c.query('UPDATE org.usuario SET fallos_clave = 0, fallos_pin = 0, bloqueado_hasta = NULL WHERE id = $1', [u.id]);
    if (habilitar) {
      const token = nuevoToken();
      const { rows: [d] } = await c.query(
        `INSERT INTO org.dispositivo (token_hash, descripcion, habilitado_por, vence_en)
         VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING id, descripcion`,
        [hashToken(token), texto(req.body.dispositivo) || String(req.headers['user-agent'] || '').slice(0, 120),
         u.id, DISPOSITIVO_DIAS]);
      disp = d;
      ponerCookie(req, res, COOKIE_DISP, token, DISPOSITIVO_DIAS * 86400, 'Strict');
      await registrarAcceso(c, { usuario: u.usuario, evento: 'dispositivo_habilitado', req, detalle: d.descripcion });
    }
    await cerrarSesionActual(req);
    await abrirSesion(c, req, res, u, 'clave', disp);
    await registrarAcceso(c, { usuario: u.usuario, evento: 'entrada', req, detalle: disp ? 'dispositivo de cocina' : null });
  });
  res.json({ ok: true });
}));

r.post('/sesion/pin', h(async (req, res) => {
  frenoIp(req);
  const disp = await dispositivoDe(req);
  if (!disp) throw new ErrorUsuario('El PIN sólo sirve en un dispositivo de cocina habilitado. Entrá con tu clave.', 403);
  const id = texto(req.body.usuario_id, { campo: 'el usuario', requerido: true });
  const pin = String(req.body.pin || '');
  const { rows: [u] } = await pool.query(
    `SELECT id, usuario, pin_hash, fallos_pin FROM org.usuario
      WHERE id = $1::uuid AND activo AND pin_hash IS NOT NULL AND NOT debe_cambiar_clave
        AND (bloqueado_hasta IS NULL OR bloqueado_hasta < now())`, [id]).catch(() => ({ rows: [] }));
  if (!u) throw new ErrorUsuario('Ese usuario no puede entrar con PIN. Que entre con su clave.', 403);
  if (u.fallos_pin >= BLOQUEO_FALLOS)
    throw new ErrorUsuario('El PIN quedó inhabilitado por intentos fallidos. Entrá con tu clave para rehabilitarlo.', 403);
  if (!/^\d{4,6}$/.test(pin) || !(await verificarClave(pin, u.pin_hash))) {
    falloIp(req);
    const { rows: [f] } = await pool.query(
      'UPDATE org.usuario SET fallos_pin = fallos_pin + 1 WHERE id = $1 RETURNING fallos_pin', [u.id]);
    const quedan = BLOQUEO_FALLOS - f.fallos_pin;
    await registrarAcceso(null, { usuario: u.usuario, evento: quedan > 0 ? 'pin_incorrecto' : 'pin_inhabilitado', req,
      detalle: disp.descripcion });
    throw new ErrorUsuario(quedan > 0 ? `PIN incorrecto. Te quedan ${quedan} intento(s).`
      : 'PIN incorrecto. Quedó inhabilitado: entrá con tu clave para rehabilitarlo.', 401);
  }
  await enTransaccion(async c => {
    await c.query('UPDATE org.usuario SET fallos_pin = 0 WHERE id = $1', [u.id]);
    await cerrarSesionActual(req);
    await abrirSesion(c, req, res, u, 'pin', disp);
    await registrarAcceso(c, { usuario: u.usuario, evento: 'entrada_pin', req, detalle: disp.descripcion });
  });
  res.json({ ok: true });
}));

r.post('/sesion/salir', h(async (req, res) => {
  const s = await sesionDe(req);
  await cerrarSesionActual(req);
  if (s) await registrarAcceso(null, { usuario: s.usuario, evento: 'salida', req });
  ponerCookie(req, res, COOKIE_SESION, '', 0);
  res.json({ ok: true });
}));

// ── Cuenta propia ────────────────────────────────────────────────────────────────────────────
// Estas dos rutas van detrás de exigirSesion (ver server.js).
const cuenta = express.Router();

async function claveActualOk(req, clave) {
  const { rows: [u] } = await pool.query('SELECT clave_hash FROM org.usuario WHERE id = $1', [req.usuario.id]);
  if (!(await verificarClave(String(clave || ''), u.clave_hash))) {
    falloIp(req);
    await registrarAcceso(null, { usuario: req.usuario.usuario, evento: 'clave_incorrecta', req, detalle: 'en Mi cuenta' });
    throw new ErrorUsuario('La clave actual no es correcta.', 401);
  }
}

cuenta.post('/cuenta/clave', h(async (req, res) => {
  frenoIp(req);
  await claveActualOk(req, req.body.actual);
  const nueva = validarClave(req.body.nueva, req.usuario.usuario);
  if (nueva === String(req.body.actual)) throw new ErrorUsuario('La clave nueva tiene que ser distinta de la actual.');
  const hash = await hashClave(nueva);
  await enTransaccion(async c => {
    await c.query(`UPDATE org.usuario SET clave_hash = $1, debe_cambiar_clave = false, clave_cambiada_en = now()
                    WHERE id = $2`, [hash, req.usuario.id]);
    // Las otras sesiones abiertas se cierran: si cambió la clave porque alguien más la sabía, ése
    // no puede seguir adentro.
    await c.query('UPDATE org.sesion SET cerrada_en = now() WHERE usuario_id = $1 AND id <> $2 AND cerrada_en IS NULL',
      [req.usuario.id, req.usuario.sesion_id]);
    await registrarAcceso(c, { usuario: req.usuario.usuario, evento: 'clave_cambiada', req });
  });
  res.json({ ok: true });
}));

cuenta.post('/cuenta/pin', h(async (req, res) => {
  frenoIp(req);
  await claveActualOk(req, req.body.clave);
  const pin = req.body.pin === null ? null : validarPin(req.body.pin);
  await pool.query('UPDATE org.usuario SET pin_hash = $1, fallos_pin = 0 WHERE id = $2',
    [pin && await hashClave(pin), req.usuario.id]);
  await registrarAcceso(null, { usuario: req.usuario.usuario, evento: pin ? 'pin_cambiado' : 'pin_quitado', req });
  res.json({ ok: true });
}));

module.exports = {
  router: r, cuenta, exigirSesion, puede, exigir, rolEn, exigirEncargadoDe, exigirOperarEn, sedesVisibles, filtroSedes,
  hashClave, claveTemporal, validarPin, registrarAcceso,
};
