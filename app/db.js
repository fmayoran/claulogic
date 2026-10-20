// Pool de conexiones. Un POOL y no una conexión suelta: Express atiende pedidos en paralelo y una
// sola conexión los serializa sin que se note hasta que hay dos usuarios.
//
// El esquema es `logic`, no `public`. Eso hace que un dump, un GRANT o un DROP sean quirúrgicos
// en vez de "todo o nada", y es la misma convención que `contenido` en ClaUsina.
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// Las columnas DATE vuelven como texto 'AAAA-MM-DD'. Convertidas a Date de JavaScript quedan a la
// medianoche UTC, y un navegador en Argentina (UTC-3) muestra el vencimiento un día antes.
types.setTypeParser(1082, v => v);

const pool = new Pool({
  host: process.env.PGHOST,
  port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  // "Hoy" es el de la cocina, no el de Greenwich: a las 22 h de acá en UTC ya es mañana, y los
  // vencimientos, los códigos de lote y los filtros de "vence en N días" se correrían un día.
  // logic.origen=app le dice a los triggers que el pedido viene de la app y que, por lo tanto,
  // tiene que traer usuario. Desde psql no está, y ahí no se exige.
  options: '-c timezone=America/Argentina/Buenos_Aires -c logic.origen=app',
  max: 10,
  idleTimeoutMillis: 30000,
  // Si la base no contesta, fallar rápido y ruidoso. Sin esto el pedido queda colgado y el
  // usuario ve una pantalla girando para siempre en vez de un error.
  connectionTimeoutMillis: 5000,
});

pool.on('error', e => console.error('pool pg:', e.message));

// Quién hace el pedido. auth.js corre cada pedido autenticado dentro de `contexto.run`, y cada
// conexión que se toma del pool lleva ese usuario en `logic.usuario`: los triggers de la base lo
// leen para firmar los movimientos y verificar el permiso por sede. Se fija en CADA préstamo (vacío
// si no hay usuario), así una conexión nunca arrastra el usuario del pedido anterior.
const contexto = new AsyncLocalStorage();
const prestar = pool.connect.bind(pool);
pool.connect = async () => {
  const c = await prestar();
  try {
    await c.query("SELECT set_config('logic.usuario', $1, false)", [contexto.getStore()?.usuario || '']);
  } catch (e) { c.release(e); throw e; }
  return c;
};
// pool.query original toma la conexión por adentro, sin pasar por el connect de arriba.
pool.query = async (...args) => {
  const c = await pool.connect();
  try { return await c.query(...args); } finally { c.release(); }
};

/** ¿La base responde? Lo usa /salud, que es lo primero que se mira cuando algo no anda. */
async function salud() {
  const t = Date.now();
  const { rows: [r] } = await pool.query('SELECT now() AS ahora, current_database() AS base');
  return { ok: true, base: r.base, ahora: r.ahora, ms: Date.now() - t };
}

module.exports = { pool, salud, contexto };
