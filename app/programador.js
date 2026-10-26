// Programador de los procesos automáticos. Por ahora uno: la sincronización diaria de los puntos de venta que van
// por API (decisión de Fer, 26/10/2026: a las 5:00, trae el día anterior). Cada minuto se fija si ya son las 5 en la
// hora de la cocina y corre lo que falte de hoy: si la app estuvo caída a esa hora, corre al volver. Una corrida
// automática por punto de venta y por día (lo garantiza la base), así que dos instancias no la duplican.
//
// Lo firma el usuario de sistema ("sistema", con permiso de finanzas y sin clave): la base exige un usuario para
// asentar cobros y lotes, y así queda claro en el historial qué hizo el proceso automático.
const { pool, contexto } = require('./db');

const HORA = 5;
const SISTEMA = { usuario: 'sistema', nombre: 'Proceso automático', es_admin: false, finanzas: true, roles: [] };
let corriendo = false;

async function tick(correrAutomaticas) {
  if (corriendo) return;
  corriendo = true;
  try {
    const { rows: [{ hora }] } = await pool.query('SELECT extract(hour FROM now())::int AS hora');
    if (hora < HORA) return;
    await contexto.run({ usuario: SISTEMA.usuario }, () => correrAutomaticas({ usuario: SISTEMA }));
  } catch (e) {
    console.error('programador:', e.message);
  } finally { corriendo = false; }
}

function iniciar(correrAutomaticas) {
  if (process.env.PROGRAMADOR === 'no') return;   // en las pruebas se corre a mano
  setTimeout(() => tick(correrAutomaticas), 20000);
  setInterval(() => tick(correrAutomaticas), 60000).unref();
}

module.exports = { iniciar, tick };
