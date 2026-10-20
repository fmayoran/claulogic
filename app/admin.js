// Consola de administración, para lo que no se puede hacer desde la app: crear el PRIMER
// administrador y recuperar el acceso si todos los administradores quedaron afuera.
//
// Se corre adentro del contenedor de la app, que ya tiene el entorno de la base:
//   docker exec -it $(docker ps -q -f name=claulogic_app.1.) node admin.js admin <usuario> "<Nombre>"
//   docker exec -it $(docker ps -q -f name=claulogic_app.1.) node admin.js clave <usuario>
//
// Las dos imprimen una clave temporal que hay que cambiar al entrar. No hay forma de fijar una
// clave desde acá: quedaría en el historial de la terminal.
const { pool } = require('./db');
const { hashClave, claveTemporal } = require('./auth');

async function main() {
  const [cmd, usuario, nombre] = process.argv.slice(2);
  if (!['admin', 'clave'].includes(cmd) || !usuario) {
    console.error('uso: node admin.js admin <usuario> "<Nombre>"   |   node admin.js clave <usuario>');
    process.exit(1);
  }
  const temporal = claveTemporal();
  const hash = await hashClave(temporal);
  if (cmd === 'admin') {
    if (!nombre) throw new Error('falta el nombre');
    await pool.query(
      `INSERT INTO org.usuario (usuario, nombre, clave_hash, es_admin) VALUES ($1, $2, $3, true)`,
      [usuario.toLowerCase(), nombre, hash]);
  } else {
    const { rowCount } = await pool.query(
      `UPDATE org.usuario SET clave_hash = $1, debe_cambiar_clave = true, clave_cambiada_en = now(),
              fallos_clave = 0, bloqueado_hasta = NULL, fallos_pin = 0, activo = true
        WHERE usuario = $2`, [hash, usuario.toLowerCase()]);
    if (!rowCount) throw new Error(`no existe el usuario ${usuario}`);
    await pool.query('UPDATE org.sesion SET cerrada_en = now() WHERE cerrada_en IS NULL AND usuario_id = (SELECT id FROM org.usuario WHERE usuario = $1)', [usuario.toLowerCase()]);
  }
  await pool.query(`INSERT INTO org.acceso (usuario, evento, por) VALUES ($1, $2, 'consola')`,
    [usuario.toLowerCase(), cmd === 'admin' ? 'alta' : 'clave_blanqueada']);
  console.log(`${usuario}: clave temporal ${temporal}  (se cambia al entrar)`);
}

main().then(() => pool.end()).catch(e => { console.error('error:', e.message); pool.end(); process.exit(1); });
