// ClauLogic — servidor. Independiente de ClaUsina: su propio repo, su propia base, su propia
// clave de cifrado y su propio proyecto en EasyPanel. Lo único que comparten es el VPS.
const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PUERTO = +(process.env.PORT || 3002);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Salud: lo primero que se mira cuando algo no anda, y lo que mira EasyPanel para saber si el
// contenedor está vivo. Toca la base a propósito —un proceso que responde pero no llega a la
// base está "arriba" y no sirve para nada—.
app.get('/salud', async (req, res) => {
  try {
    res.json({ ok: true, app: 'claulogic', ...(await db.salud()) });
  } catch (e) {
    // 503 y no 500: no es que el pedido esté mal, es que la dependencia no está. El que mira el
    // estado necesita distinguirlos.
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.use('/api', require('./productos'));
app.use('/api', require('./config'));
app.use('/api', require('./stock'));
app.use('/api', require('./compras'));
app.use('/api', require('./produccion'));
app.use('/api', require('./frio'));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Errores sin atrapar: se registran enteros del lado del servidor y al cliente le va un mensaje
// escueto. Devolver el stack es regalarle al que prueba la puerta el plano de la casa.
app.use((e, req, res, next) => {
  console.error('error no atrapado:', e.stack || e.message);
  res.status(500).json({ ok: false, error: 'error interno' });
});

const srv = app.listen(PUERTO, () => console.log(`claulogic escuchando en ${PUERTO}`));

// Apagado ordenado: Docker manda SIGTERM y espera. Sin esto, un deploy corta pedidos a la mitad
// y deja conexiones de la base colgadas hasta que vencen solas.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig}: cerrando`);
    srv.close(() => db.pool.end().then(() => process.exit(0)).catch(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
