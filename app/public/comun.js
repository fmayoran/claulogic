// Helpers comunes de las pantallas de ClauLogic.
//
// Los números llegan de la API como TEXTO (NUMERIC de la base) y se muestran formateando el
// texto, sin pasar por Number: así lo que se ve es exactamente lo que está guardado.

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

async function api(url, opt = {}) {
  // Toda modificación lleva cuerpo JSON, aunque sea vacío: el servidor exige JSON (es la defensa
  // contra CSRF), y un DELETE sin cuerpo no manda tipo de contenido.
  const modifica = opt.method && !['GET', 'HEAD'].includes(opt.method);
  const r = await fetch('api/' + url, {
    ...opt, headers: { 'content-type': 'application/json' },
    body: opt.body ? JSON.stringify(opt.body) : modifica ? '{}' : undefined,
  });
  const d = await r.json().catch(() => ({ ok: false, error: 'Respuesta inválida del servidor.' }));
  // Sin sesión, al login; con clave temporal, a cambiarla. Vuelve a donde estaba después.
  if (r.status === 401 && d.sesion === false) irA('login.html');
  if (r.status === 403 && d.cambiar_clave) irA('cuenta.html');
  if (!d.ok) throw new Error(d.error || 'Error del servidor.');
  return d;
}
function irA(pagina) {
  const aca = location.pathname.split('/').pop() || 'index.html';
  if (aca === pagina) return;
  location.href = pagina + '?volver=' + encodeURIComponent(aca + location.search + location.hash);
}

function el(tag, props = {}, ...hijos) {
  const e = Object.assign(document.createElement(tag), props);
  for (const h of hijos) if (h !== null && h !== undefined && h !== false) e.append(h);
  return e;
}

function msg(t, tipo = '', sel = '#msg') { const m = $(sel); if (!m) return; m.textContent = t; m.className = 'msg ' + tipo; }

function opciones(select, items, valor, vacio) {
  select.replaceChildren(...(vacio !== undefined ? [el('option', { value: '', textContent: vacio })] : []),
    ...items.map(([v, t]) => el('option', { value: v, textContent: t })));
  if (valor != null) select.value = valor;
}

// Para volver a poner un número en un input: coma decimal, como se escribe acá.
const coma = v => v == null ? '' : String(v).replace('.', ',');

// "1234567.5" -> "1.234.567,5", sin pasar por float.
function num(v, decimales) {
  if (v === null || v === undefined || v === '') return '';
  let [ent, dec = ''] = String(v).split('.');
  const neg = ent.startsWith('-'); if (neg) ent = ent.slice(1);
  if (decimales !== undefined) dec = (dec + '0'.repeat(decimales)).slice(0, decimales);
  ent = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + ent + (dec ? ',' + dec : '');
}
const pesos = v => v === null || v === undefined || v === '' ? '' : String(v).startsWith('-') ? '-$' + num(String(v).slice(1), 2) : '$' + num(v, 2);

// Plata en centavos enteros (BigInt) para sumar y comparar en el navegador sin float. Acepta
// "1234.5", "1.234,50" (tipeado) o "-20000.00" (de la API).
function centavos(v) {
  let s = String(v ?? '').trim();
  if (!s) return 0n;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const neg = s.startsWith('-'); if (neg) s = s.slice(1);
  if (!/^\d*(\.\d*)?$/.test(s)) return 0n;
  const [e, d = ''] = s.split('.');
  return (neg ? -1n : 1n) * (BigInt(e || '0') * 100n + BigInt((d + '00').slice(0, 2)));
}
const deCentavos = c => { const a = c < 0n ? -c : c; return (c < 0n ? '-' : '') + String(a / 100n) + '.' + String(a % 100n).padStart(2, '0'); };

// Corre la coma decimal n lugares a la izquierda, en texto: 49500 -> 49.5.
function correr(v, n) {
  let [ent, dec = ''] = String(v).split('.');
  const neg = ent.startsWith('-'); if (neg) ent = ent.slice(1);
  ent = ent.padStart(n + 1, '0');
  let r = ent.slice(0, -n) + '.' + ent.slice(-n) + dec;
  r = r.replace(/^0+(?=\d)/, '').replace(/\.?0+$/, '');
  return (neg ? '-' : '') + r;
}

// Cantidad legible: 49500 g se muestra 49,5 kg. Sólo para mostrar; lo guardado sigue en base.
function cant(v, unidad) {
  if (v === null || v === undefined || v === '') return '';
  const mayor = { g: 'kg', ml: 'l' }[unidad];
  const abs = String(v).replace('-', '').split('.')[0];
  if (mayor && abs.length >= 4) return num(correr(v, 3)) + ' ' + mayor;
  return num(v) + ' ' + unidad;
}

// 'AAAA-MM-DD' -> 'DD/MM/AAAA' sin crear un Date (que lo movería de día por la zona horaria).
const fecha = v => v ? v.slice(0, 10).split('-').reverse().join('/') : '';
const fechaHora = v => v ? new Date(v).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '';
const hoy = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Días hasta una fecha 'AAAA-MM-DD', contando en calendario local.
function diasHasta(v) {
  if (!v) return null;
  const [a, m, d] = v.slice(0, 10).split('-').map(Number);
  const [ha, hm, hd] = hoy().split('-').map(Number);
  return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(ha, hm - 1, hd)) / 86400000);
}
function tagVence(v) {
  const d = diasHasta(v);
  if (d === null) return '';
  if (d < 0) return el('span', { className: 'tag mal', textContent: 'vencido' });
  if (d <= 3) return el('span', { className: 'tag mal', textContent: d === 0 ? 'vence hoy' : `vence en ${d} d` });
  if (d <= 7) return el('span', { className: 'tag aviso', textContent: `vence en ${d} d` });
  return '';
}

function filas(tbody, items, fila, vacio, columnas) {
  if (!items.length) return tbody.replaceChildren(el('tr', {}, el('td', { colSpan: columnas, className: 'vacio', textContent: vacio })));
  tbody.replaceChildren(...items.map(fila));
}
const td = (t, cls = '') => el('td', { className: cls }, t ?? '');

// Secciones agrupadas por para qué se usan. En el celular, las de `abajo` van en la barra
// inferior; el resto, en "Más".
const GRUPOS = [
  ['Operación', [['index.html', 'Panel'], ['stock.html', 'Stock'], ['movimientos.html', 'Movimientos'],
                 ['pedidos.html', 'Pedidos'], ['remitos.html', 'Remitos'], ['compras.html', 'Compras'],
                 ['produccion.html', 'Producción']]],
  ['Catálogo', [['productos.html', 'Productos'], ['recetas.html', 'Recetas'], ['proveedores.html', 'Proveedores']]],
  ['Finanzas', [['comprobantes.html', 'Comprobantes'], ['ordenes-pago.html', 'Órdenes de pago'],
                ['cuenta-corriente.html', 'Cuenta corriente'], ['tesoreria.html', 'Tesorería'], ['cheques.html', 'Cheques'],
                ['conciliacion.html', 'Conciliación']]],
  ['Control', [['frio.html', 'Frío'], ['trazabilidad.html', 'Trazabilidad'], ['etiquetas.html', 'Etiquetas']]],
  ['Configuración', [['sedes.html', 'Sedes'], ['almacenes.html', 'Almacenes'],
                     ['unidades-productivas.html', 'Unidades productivas'], ['unidades.html', 'Unidades de medida'],
                     ['usuarios.html', 'Usuarios']]],
];
// Secciones que sólo tienen sentido con cierto permiso. El servidor lo exige igual; esto es para
// no mostrar puertas que no abren.
const PERMISO_SECCION = { 'almacenes.html': 'gestionar', 'unidades.html': 'catalogo', 'usuarios.html': 'admin',
  'sedes.html': 'admin', 'unidades-productivas.html': 'gestionar',
  'comprobantes.html': 'finanzas', 'cuenta-corriente.html': 'finanzas', 'ordenes-pago.html': 'finanzas',
  'tesoreria.html': 'finanzas', 'cheques.html': 'finanzas', 'conciliacion.html': 'finanzas' };
const ICONOS = {
  panel: '<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"/>',
  stock: '<path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 16l9 4 9-4"/>',
  escanear: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 8v8M11 8v8M14 8v8M17 8v8"/>',
  productos: '<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  mas: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  volver: '<path d="M15 5l-7 7 7 7"/>',
  usuario: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  camara: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
};
function icono(nombre) {
  const s = el('span', { className: 'ico' });
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[nombre]}</svg>`;
  return s.firstChild;
}

function navegacion() {
  const actual = location.pathname.split('/').pop() || 'index.html';
  const sec = ([href, t]) => el('a', { href, textContent: t, className: 'sec' + (href === actual ? ' act' : '') });
  const grupos = () => GRUPOS.map(([g, secs]) => el('div', { className: 'grupo' }, el('span', { textContent: g }), ...secs.map(sec)));
  const btnEsc = () => el('button', { type: 'button', className: 'btn-escanear', onclick: escanear,
    ariaLabel: 'Escanear un código' }, icono('escanear'), el('span', { textContent: 'Escanear' }));

  const lateral = el('nav', { className: 'lateral', ariaLabel: 'Secciones' },
    el('a', { className: 'marca', href: './', textContent: 'ClauLogic' }), btnEsc(), ...grupos());

  // Barra inferior del celular: lo de todos los días y Escanear al centro.
  const abajo = [['index.html', 'Panel', 'panel'], ['stock.html', 'Stock', 'stock'], null,
                 ['productos.html', 'Productos', 'productos']];
  const enBarra = abajo.some(x => x && x[0] === actual);
  const hoja = el('dialog', { className: 'hoja', ariaLabel: 'Todas las secciones' }, ...grupos());
  hoja.addEventListener('click', e => { if (e.target === hoja) hoja.close(); });
  const esc = btnEsc(); esc.lastChild.hidden = true;
  const inferior = el('nav', { className: 'inferior', ariaLabel: 'Secciones' },
    ...abajo.map(x => x ? el('a', { href: x[0], className: x[0] === actual ? 'act' : '' }, icono(x[2]), el('span', { textContent: x[1] })) : esc),
    el('button', { type: 'button', className: enBarra ? '' : 'act', onclick: () => hoja.showModal() },
      icono('mas'), el('span', { textContent: 'Más' })));
  document.body.prepend(lateral);
  document.body.append(inferior, hoja);
  cargarSesion().then(d => {
    if (!d.usuario) return irA('login.html');
    const u = sesion = d.usuario;
    for (const [href, permiso] of Object.entries(PERMISO_SECCION))
      if (!u.puede[permiso]) $$(`a[href="${href}"]`).forEach(a => a.remove());
    // Las compras son del centro: quien sólo tiene rol en locales no las ve.
    if (!u.es_admin && !u.roles.some(r => r.tipo === 'centro')) $$('a[href="compras.html"]').forEach(a => a.remove());
    $$('.grupo').forEach(g => { if (!g.querySelector('a')) g.remove(); });
    // Quién está adentro, y las salidas: en la barra lateral abajo; en el celular, dentro de "Más".
    const acciones = () => [
      el('a', { href: 'cuenta.html', className: 'sec' + (actual === 'cuenta.html' ? ' act' : ''), textContent: 'Mi cuenta' }),
      d.dispositivo ? el('a', { href: 'login.html', className: 'sec', textContent: 'Cambiar de usuario' }) : null,
      el('a', { href: '#', className: 'sec', textContent: 'Salir', onclick: e => { e.preventDefault(); salir(); } })];
    const quien = () => el('div', { className: 'quien' }, icono('usuario'),
      el('div', {}, el('strong', { textContent: u.nombre }), el('span', { textContent: describirRoles(u) })));
    lateral.append(el('div', { className: 'grupo cuenta' }, quien(), ...acciones()));
    hoja.append(el('div', { className: 'grupo cuenta' }, quien(), ...acciones()));
  }).catch(() => {});
}

let sesion = null, _sesion;
const cargarSesion = () => _sesion ||= api('sesion');
function describirRoles(u) {
  if (u.es_admin) return 'Administrador';
  const R = { encargado: 'encargado', operador: 'operador', consulta: 'consulta' };
  return [u.finanzas ? 'Finanzas' : null, ...u.roles.map(r => `${r.sede}: ${R[r.rol]}`)].filter(Boolean).join(' · ') || 'Sin sedes asignadas';
}
async function salir() {
  await api('sesion/salir', { method: 'POST' }).catch(() => {});
  location.href = 'login.html';
}

// Escanear desde cualquier pantalla: un producto abre su ficha, un lote su trazabilidad, y un
// código que no está cargado lleva al alta con ese código. En el celular abre la cámara de una;
// en la computadora espera el lector (que tipea el código y un Enter).
function irALectura(d) {
  if (d.desconocido) return void (location.href = 'productos.html#nuevo/' + d.lectura.gtin);
  if (d.lote) return void (location.href = 'trazabilidad.html?lote_id=' + d.lote.id);
  if (d.lectura.lote) throw new Error(`${d.producto.nombre}: el lote ${d.lectura.lote} no está registrado.`);
  location.href = 'productos.html#p/' + d.producto.id;
}
function escanear() {
  const caja = escaner(async d => { irALectura(d); dlg.close(); }, { placeholder: 'Escaneá o escribí el código' });
  const dlg = el('dialog', {},
    el('h2', { textContent: 'Escanear' }),
    el('p', { className: 'ayuda', style: 'margin:0 0 14px',
      textContent: 'Un producto abre su ficha y un lote, su trazabilidad. Con lector, escaneá directamente; si escribís el código, tocá Enter.' }),
    caja,
    el('div', { className: 'acciones' }, el('button', { type: 'button', textContent: 'Cerrar', onclick: () => dlg.close() })));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal(); caja.input.focus();
  if (matchMedia('(pointer:coarse)').matches) caja.camara.click();
}
// El login no lleva navegación: no hay a dónde ir sin entrar.
if (!document.body.hasAttribute('data-sin-nav')) navegacion();

// Las sedes con las que el usuario trabaja: todas las activas si es administrador; si no, las de
// sus roles. `rol` dice qué puede hacer en cada una ('admin' para el administrador).
async function misSedes() {
  const { usuario: u } = await cargarSesion();
  if (u.es_admin) return (await api('sedes')).sedes.filter(s => s.activa).map(s => ({ ...s, rol: 'admin' }));
  return u.roles.map(r => ({ id: r.sede_id, nombre: r.sede, tipo: r.tipo, rol: r.rol }));
}
const operaEn = s => ['admin', 'encargado', 'operador'].includes(s.rol);

// Filtro de sede para pantallas de consulta: sólo aparece si el usuario ve más de una.
async function filtroSede(select, alCambiar) {
  const sedes = await misSedes();
  opciones(select, sedes.map(s => [s.id, s.nombre]), null, 'Todas las sedes');
  select.hidden = sedes.length < 2;
  select.onchange = alCambiar;
  return sedes;
}

// Cache de catálogos que usan varias pantallas.
const catalogo = {
  async productos() { return this._p ||= (await api('productos')).productos; },
  async almacenes() { return this._a ||= (await api('almacenes')).almacenes; },
  async unidades() { return this._u ||= (await api('unidades')).unidades; },
};
// Opciones de ubicación agrupadas por almacén ("Depósito central · Cámara 1").
// Con más de una sede a la vista, se antepone la sede: "Depósito · General" existe en cada local.
function opcionesUbicacion(select, almacenes, valor, vacio = 'Elegir…', filtro = () => true) {
  const items = [], multi = new Set(almacenes.map(a => a.sede_id)).size > 1;
  for (const a of almacenes.filter(a => a.activo))
    for (const u of a.ubicaciones.filter(u => u.activa && filtro(u, a)))
      items.push([u.id, `${multi ? a.sede + ' · ' : ''}${a.nombre} · ${u.nombre}`]);
  opciones(select, items, valor, vacio);
}
function unidadesCompatibles(unidades, base) {
  const mag = (unidades.find(u => u.codigo === base) || {}).magnitud;
  return unidades.filter(u => u.magnitud === mag);
}

// ── Lectura de códigos ───────────────────────────────────────────────────────────────────────
// Un campo que acepta lo que manda un lector USB o Bluetooth (tipea el código y un Enter) y un
// botón para leer con la cámara. Lo leído se interpreta en el servidor (/api/gs1/leer), que
// devuelve producto, presentación, lote y vencimiento según lo que traiga el código.
//
// El separador GS1 (GS) no es un carácter que se pueda tipear: los lectores en modo teclado lo
// mandan como Ctrl+]. Se lo captura y se lo inserta, porque sin él no se pueden separar dos
// campos de largo variable seguidos.
function escaner(onLeido, { placeholder = 'Escanear o tipear código (GTIN, SKU, lote)' } = {}) {
  const input = el('input', { type: 'text', placeholder, autocomplete: 'off', spellcheck: false });
  const aviso = el('span', { className: 'msg' });
  const camara = el('button', { type: 'button', className: 'icono', title: 'Leer con la cámara', ariaLabel: 'Leer con la cámara' }, icono('camara'));
  const caja = el('div', { className: 'escaner' }, el('div', { className: 'con-boton' }, input, camara), aviso);

  async function procesar(codigo) {
    if (!codigo.trim()) return;
    aviso.textContent = 'Leyendo…'; aviso.className = 'msg';
    try {
      const d = await api('gs1/leer?codigo=' + encodeURIComponent(codigo));
      aviso.textContent = ''; input.value = '';
      await onLeido(d);
    } catch (e) { aviso.textContent = e.message; aviso.className = 'msg mal'; input.select(); }
  }
  input.addEventListener('keydown', e => {
    if (e.ctrlKey && (e.key === ']' || e.code === 'BracketRight')) {
      e.preventDefault();
      const i = input.selectionStart;
      input.value = input.value.slice(0, i) + '\x1d' + input.value.slice(input.selectionEnd);
      input.selectionStart = input.selectionEnd = i + 1;
    } else if (e.key === 'Enter') { e.preventDefault(); procesar(input.value); }
  });
  camara.onclick = () => leerConCamara(procesar).catch(e => { aviso.textContent = e.message; aviso.className = 'msg mal'; });
  caja.input = input; caja.camara = camara; caja.procesar = procesar;
  return caja;
}

// Cámara: BarcodeDetector donde el navegador lo trae (Chrome en Android, macOS); si no, zxing,
// que se sirve desde la propia app. Se pide la cámara trasera.
let _zxing;
async function leerConCamara(onCodigo) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    throw new Error('Este navegador no da acceso a la cámara (hace falta https).');
  const video = el('video', { playsInline: true, muted: true, style: 'width:100%;border-radius:8px;background:#000' });
  const estado = el('p', { className: 'ayuda', textContent: 'Apuntá al código…' });
  const cerrar = el('button', { type: 'button', textContent: 'Cancelar' });
  const dlg = el('dialog', {}, el('h2', { textContent: 'Leer con la cámara' }), video, estado,
    el('div', { className: 'acciones' }, cerrar));
  document.body.append(dlg); dlg.showModal();
  let detener = () => {};
  const fin = () => { detener(); dlg.close(); dlg.remove(); };
  cerrar.onclick = fin; dlg.addEventListener('cancel', fin);
  const listo = texto => { fin(); onCodigo(texto); };

  try {
    const formatos = ['qr_code', 'data_matrix', 'ean_13', 'ean_8', 'upc_a', 'code_128', 'itf'];
    const nativo = 'BarcodeDetector' in window &&
      (await BarcodeDetector.getSupportedFormats()).some(f => formatos.includes(f));
    if (nativo) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream; await video.play();
      const det = new BarcodeDetector({ formats: (await BarcodeDetector.getSupportedFormats()).filter(f => formatos.includes(f)) });
      let vivo = true;
      detener = () => { vivo = false; stream.getTracks().forEach(t => t.stop()); };
      (async function ciclo() {
        while (vivo) {
          try { const r = await det.detect(video); if (r.length) return listo(r[0].rawValue); } catch {}
          await new Promise(res => setTimeout(res, 200));
        }
      })();
    } else {
      if (!_zxing) _zxing = new Promise((res, rej) => {
        const sc = el('script', { src: 'vendor/zxing/index.min.js', onload: res, onerror: () => rej(new Error('No se pudo cargar el lector.')) });
        document.head.append(sc);
      });
      await _zxing;
      const lector = new ZXing.BrowserMultiFormatReader();
      detener = () => lector.reset();
      await lector.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, r => { if (r) listo(r.getText()); });
    }
  } catch (e) {
    fin();
    throw new Error(e && e.name === 'NotAllowedError' ? 'No se dio permiso para usar la cámara.' : 'No se pudo abrir la cámara: ' + (e.message || e));
  }
}

// Describe una lectura en una línea, para avisar qué se reconoció.
function describirLectura(d) {
  if (d.desconocido) return `GTIN ${d.lectura.gtin} sin asignar a ningún producto.`;
  const partes = [d.producto.nombre];
  if (d.presentacion) partes.push(d.presentacion.nombre);
  const lote = d.lote ? d.lote.codigo : d.lectura.lote;
  if (lote) partes.push('lote ' + lote + (d.lote ? '' : ' (nuevo)'));
  const venc = d.lote ? d.lote.vencimiento : d.lectura.vencimiento;
  if (venc) partes.push('vence ' + fecha(venc));
  return partes.join(' · ');
}
