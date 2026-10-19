// Pool de conexiones. Un POOL y no una conexión suelta: Express atiende pedidos en paralelo y una
// sola conexión los serializa sin que se note hasta que hay dos usuarios.
//
// El esquema es `logic`, no `public`. Eso hace que un dump, un GRANT o un DROP sean quirúrgicos
// en vez de "todo o nada", y es la misma convención que `contenido` en ClaUsina.
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST,
  port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  max: 10,
  idleTimeoutMillis: 30000,
  // Si la base no contesta, fallar rápido y ruidoso. Sin esto el pedido queda colgado y el
  // usuario ve una pantalla girando para siempre en vez de un error.
  connectionTimeoutMillis: 5000,
});

pool.on('error', e => console.error('pool pg:', e.message));

/** ¿La base responde? Lo usa /salud, que es lo primero que se mira cuando algo no anda. */
async function salud() {
  const t = Date.now();
  const { rows: [r] } = await pool.query('SELECT now() AS ahora, current_database() AS base');
  return { ok: true, base: r.base, ahora: r.ahora, ms: Date.now() - t };
}

module.exports = { pool, salud };
