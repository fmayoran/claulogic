// ClauLogic — servidor. Independiente de ClaUsina: su propio repo, su propia base, su propia
// clave de cifrado y su propio proyecto en EasyPanel. Lo único que comparten es el VPS.
const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PUERTO = +(process.env.PORT || 3002);

app.disable('x-powered-by');
// Detrás de Traefik: req.protocol sale de X-Forwarded-Proto. Lo usan los QR, que llevan la URL
// pública adentro; sin esto saldrían con http://.
app.set('trust proxy', 1);
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

// Sesión: entrar, salir y estado van sin usuario. Todo lo demás de /api pasa por exigirSesion,
// que además aplica el permiso por ruta y deja el usuario en el contexto de la base.
const auth = require('./auth');
app.use('/api', auth.router);
app.use('/api', auth.exigirSesion);
app.use('/api', auth.cuenta);
app.use('/api', require('./usuarios'));
app.use('/api', require('./productos'));
app.use('/api', require('./config'));
app.use('/api', require('./stock'));
app.use('/api', require('./compras'));
app.use('/api', require('./produccion'));
app.use('/api', require('./frio'));
app.use('/api', require('./codigos'));
app.use('/api', require('./catalogo'));
app.use('/api', require('./fotos'));
app.use('/api', require('./sedes'));
app.use('/api', require('./remitos'));
app.use('/api', require('./finanzas'));
app.use('/api', require('./resultados'));
app.use('/api', require('./tesoreria'));
app.use('/api', require('./pos'));
app.use('/api', require('./tablero'));
app.use('/api', require('./abastecimiento'));

// GS1 Digital Link: el QR de una etiqueta es una URL /01/<GTIN>[/10/<lote>]. Al escanearla con un
// celular, se abre la ficha de trazabilidad.
app.get(/^\/01\/(\d{8,14})(?:\/10\/([^/?]+))?\/?$/, (req, res) => {
  const q = new URLSearchParams({ gtin: req.params[0] });
  if (req.params[1]) q.set('lote', decodeURIComponent(req.params[1]));
  res.redirect(302, '/trazabilidad.html?' + q);
});

// Lector de códigos por cámara para navegadores sin BarcodeDetector (Safari, Chrome de
// escritorio). Se sirve desde el propio paquete npm, con versión fija: nada de CDN en producción.
app.use('/vendor/zxing', express.static(path.join(path.dirname(require.resolve('@zxing/library/package.json')), 'umd'), { maxAge: '7d' }));
// Tipografía (Archivo, variable en peso y ancho), también desde el paquete: cargarla de Google
// Fonts le avisaría a un tercero cada vez que alguien abre la app.
app.use('/vendor/archivo', express.static(path.join(path.dirname(require.resolve('@fontsource-variable/archivo/package.json')), 'files'), { maxAge: '30d' }));

// Las pantallas y sus helpers se revalidan en cada visita (304 si no cambiaron): con un max-age,
// después de un deploy el navegador puede juntar un HTML nuevo con un comun.js viejo y la
// pantalla se rompe sin aviso.
app.use(express.static(path.join(__dirname, 'public'), { cacheControl: false,
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));

// Errores sin atrapar: se registran enteros del lado del servidor y al cliente le va un mensaje
// escueto. Devolver el stack es regalarle al que prueba la puerta el plano de la casa.
app.use((e, req, res, next) => {
  console.error('error no atrapado:', e.stack || e.message);
  res.status(500).json({ ok: false, error: 'error interno' });
});

const srv = app.listen(PUERTO, () => console.log(`claulogic escuchando en ${PUERTO}`));

// Procesos automáticos: la sincronización diaria de los puntos de venta por API (programador.js).
require('./programador').iniciar(require('./pos').correrAutomaticas);

// Apagado ordenado: Docker manda SIGTERM y espera. Sin esto, un deploy corta pedidos a la mitad
// y deja conexiones de la base colgadas hasta que vencen solas.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig}: cerrando`);
    srv.close(() => db.pool.end().then(() => process.exit(0)).catch(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
