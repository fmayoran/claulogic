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
  // Lo que no es JSON no lo contestó la app: el proxy (502/504: la app no respondió o se reinició) u otra cosa.
  const d = await r.json().catch(() => ({ ok: false, error: [502, 503, 504].includes(r.status)
    ? `El servidor no respondió (HTTP ${r.status}): puede estar reiniciándose. Probá de nuevo en un minuto.`
    : `Respuesta inesperada del servidor (HTTP ${r.status} en ${url.split('?')[0]}).` }));
  // Sin sesión, al login; con clave temporal, a cambiarla. Vuelve a donde estaba después.
  if (r.status === 401 && d.sesion === false) irA('login.html');
  if (r.status === 403 && d.cambiar_clave) irA('cuenta.html');
  if (!d.ok) { _guardando = null; throw new Error(d.error || 'Error del servidor.'); }
  if (modifica && _guardando) { sinCambios(_guardando); _guardando = null; }
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
// Plata: en pesos enteros, sin coma (decisión de Fer). Lo calculado con centavos se redondea al peso
// para mostrarlo; en la base queda exacto.
const alPeso = v => { const c = centavos(v); return (c < 0n ? c - 50n : c + 50n) / 100n; };
const pesos = v => { if (v === null || v === undefined || v === '') return ''; const r = alPeso(v); return r < 0n ? '-$' + num(String(-r)) : '$' + num(String(r)); };
// Para precargar un campo de importe: "15.000".
const miles = v => v === null || v === undefined || v === '' ? '' : num(String(alPeso(v)));

// Plata en centavos enteros (BigInt) para sumar y comparar en el navegador sin float. Acepta
// "1234.5", "1.234,50" (tipeado) o "-20000.00" (de la API).
function centavos(v) {
  let s = String(v ?? '').trim();
  if (!s) return 0n;
  // Importe tipeado con puntos de miles y sin coma: "20.000" es veinte mil (los montos son enteros).
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
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
  ['Inicio', [['index.html', 'Panel'], ['tablero.html', 'Tablero']]],
  // Compras: pedir, recibir, facturar y pagar (la factura y el pago, con permiso de finanzas).
  ['Compras', [['abastecimiento.html', 'Proceso de abastecimiento'], ['compras.html', 'Compras'], ['comprobantes.html', 'Facturas de proveedor'], ['ordenes-pago.html', 'Órdenes de pago'],
               ['cuenta-corriente.html', 'Cuenta corriente'], ['proveedores.html', 'Proveedores']]],
  ['Stock', [['stock.html', 'Stock'], ['movimientos.html', 'Movimientos'], ['pedidos.html', 'Pedidos'], ['remitos.html', 'Remitos']]],
  ['Producción', [['recetas.html', 'Recetas'], ['produccion.html', 'Producción']]],
  ['Ingresos', [['cierre-diario.html', 'Cierre diario'], ['ventas.html', 'Ventas'], ['procesar-ventas.html', 'Procesar ventas'], ['platos.html', 'Platos de carta']]],
  ['Tesorería', [['tesoreria.html', 'Cajas y bancos'], ['medios-pago.html', 'Medios de pago'], ['cheques.html', 'Cheques'], ['conciliacion.html', 'Conciliación']]],
  ['Catálogo', [['productos.html', 'Productos'], ['categorias.html', 'Categorías'], ['unidades.html', 'Unidades de medida']]],
  ['Control', [['frio.html', 'Frío'], ['trazabilidad.html', 'Trazabilidad'], ['etiquetas.html', 'Etiquetas']]],
  ['Configuración', [['sedes.html', 'Sedes'], ['almacenes.html', 'Almacenes'],
                     ['unidades-productivas.html', 'Unidades productivas'], ['usuarios.html', 'Usuarios']]],
];
// Secciones que sólo tienen sentido con cierto permiso. El servidor lo exige igual; esto es para
// no mostrar puertas que no abren.
const PERMISO_SECCION = { 'cierre-diario.html': 'finanzas', 'abastecimiento.html': 'catalogo', 'medios-pago.html': 'finanzas', 'almacenes.html': 'gestionar', 'unidades.html': 'catalogo', 'categorias.html': 'catalogo', 'usuarios.html': 'admin',
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
  flecha: '<path d="M6 9l6 6 6-6"/>',
  usuario: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  camara: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
};
function icono(nombre) {
  const s = el('span', { className: 'ico' });
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[nombre]}</svg>`;
  return s.firstChild;
}

const menuAbiertos = () => { try { return JSON.parse(localStorage.getItem('menu-abiertos')) || []; } catch { return []; } };
function navegacion() {
  const actual = location.pathname.split('/').pop() || 'index.html';
  const sec = ([href, t]) => el('a', { href, textContent: t, className: 'sec' + (href === actual ? ' act' : '') });
  // Grupos desplegables: abierto el de la pantalla actual y los que el usuario dejó abiertos.
  const grupos = () => GRUPOS.map(([g, secs]) => {
    const abierto = secs.some(([href]) => href === actual) || menuAbiertos().includes(g);
    const items = el('div', { className: 'items', hidden: !abierto }, ...secs.map(sec));
    const cab = el('button', { type: 'button', className: 'cab' }, el('span', { textContent: g }), icono('flecha'));
    cab.setAttribute('aria-expanded', abierto);
    cab.onclick = () => {
      items.hidden = !items.hidden; cab.setAttribute('aria-expanded', !items.hidden);
      const otros = menuAbiertos().filter(x => x !== g);
      try { localStorage.setItem('menu-abiertos', JSON.stringify(items.hidden ? otros : [...otros, g])); } catch {}
    };
    return el('div', { className: 'grupo' }, cab, items);
  });
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
    // Puntos de venta: los configura el encargado y finanzas les asigna las cuentas de cobro.
    // El tablero: encargados (sus sedes) y finanzas (todas, con el flujo de caja).
    if (!u.puede.gestionar && !u.puede.finanzas) $$('a[href="tablero.html"]').forEach(a => a.remove());
    // Las compras son del centro: quien sólo tiene rol en locales no las ve.
    if (!u.es_admin && !u.finanzas && !u.roles.some(r => r.tipo === 'centro')) $$('a[href="compras.html"]').forEach(a => a.remove());
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

// ── Archivos CSV ─────────────────────────────────────────────────────────────────────────────
// Los usan la conciliación bancaria y la importación de ventas de los POS.
// Separador detectado de la primera línea (; , o tabulación) y comillas respetadas.
function parsearCSV(texto) {
  texto = texto.replace(/^﻿/, '');
  const primera = texto.split(/\r?\n/)[0];
  const sep = ['\t', ';', ','].map(s => [s, primera.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const filas = []; let fila = [], campo = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) {
      if (ch === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (ch === '"') comillas = false;
      else campo += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === sep) { fila.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.some(x => x.trim())) filas.push(fila);
      fila = [];
    } else campo += ch;
  }
  fila.push(campo); if (fila.some(x => x.trim())) filas.push(fila);
  return filas;
}

// Texto de un archivo. Bancos y sistemas viejos exportan en Latin-1: si al leerlo como UTF-8
// aparecen caracteres de reemplazo, se relee con esa codificación.
async function leerTexto(archivo) {
  const texto = await archivo.text();
  return texto.includes('\ufffd') ? new TextDecoder('latin1').decode(await archivo.arrayBuffer()) : texto;
}

// ── Guardar, sólo con algo que guardar ──────────────────────────────────────────────────────
// El botón Guardar (o Crear) de un formulario se ve apagado mientras no haya cambios, y vuelve a
// apagarse cuando el guardado sale bien. No usa `disabled`: las pantallas lo apagan mientras
// esperan al servidor y lo prenden al terminar, y se pisarían.
const ES_GUARDAR = /^\s*(Guardar|Crear)/;
let _guardando = null;
function estadoCambios(form, hay) {
  const bs = [...form.querySelectorAll('button[type=submit]')].filter(b => ES_GUARDAR.test(b.textContent));
  if (!bs.length) return;
  form.classList.toggle('sin-cambios', !hay);
  for (const b of bs) { b.classList.add('es-guardar'); b.setAttribute('aria-disabled', !hay); b.title = hay ? '' : 'No hay cambios para guardar'; }
}
const marcarCambios = form => estadoCambios(form, true);
const sinCambios = form => estadoCambios(form, false);
const formDe = t => t && t.closest ? t.closest('form') : null;
for (const ev of ['input', 'change']) document.addEventListener(ev, e => { const f = formDe(e.target); if (f) marcarCambios(f); }, true);
document.addEventListener('reset', e => { if (e.target.tagName === 'FORM') sinCambios(e.target); }, true);
document.addEventListener('click', e => {
  // Elegir otro registro de la lista: lo que se abre todavía no tiene cambios.
  if (e.target.closest && e.target.closest('.lista .item')) return $$('form').forEach(sinCambios);
  const b = e.target.closest && e.target.closest('button'), f = formDe(b);
  if (!f) return;
  if (b.classList.contains('es-guardar')) {
    if (f.classList.contains('sin-cambios')) { e.preventDefault(); e.stopImmediatePropagation(); }
    else _guardando = f;
  // Agregar o quitar un renglón también es un cambio; cerrar o volver, no.
  } else if (b.type === 'button' && !/^\s*(Cancelar|Volver|Cerrar|Descartar)/.test(b.textContent)) marcarCambios(f);
}, true);
document.addEventListener('submit', e => {
  const f = e.target;
  if (!f.classList.contains('sin-cambios')) { _guardando = f; return; }
  if (!e.submitter || e.submitter.classList.contains('es-guardar')) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
$$('form').forEach(sinCambios);
// Los formularios que se arman después (diálogos) arrancan igual.
new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes)
  if (n.nodeType === 1) (n.tagName === 'FORM' ? [n] : [...n.querySelectorAll('form')]).forEach(f => f.dataset.vista || (f.dataset.vista = 1, sinCambios(f))); })
  .observe(document.body, { childList: true, subtree: true });

// ── Ayuda de cada pantalla ──────────────────────────────────────────────────────────────────
// La descripción bajo el título ocupa lugar todo el tiempo y se lee una vez: queda detrás de un "?".
for (const p of $$('h1 + p.sub:not([id])')) {
  const h = p.previousElementSibling;
  const b = el('button', { type: 'button', className: 'ayuda-btn', textContent: '?', title: 'Qué es esta pantalla' });
  b.setAttribute('aria-expanded', false); b.setAttribute('aria-label', 'Qué es esta pantalla');
  b.onclick = () => { p.hidden = !p.hidden; b.setAttribute('aria-expanded', !p.hidden); };
  p.hidden = true; p.classList.add('desc'); h.classList.add('con-ayuda'); h.after(b);
}

// ── Pago rápido ─────────────────────────────────────────────────────────────────────────────
// Pagar un comprobante en un paso: importe, fecha y la cuenta de la que sale. Por detrás arma la
// orden de pago y la registra (queda igual en Órdenes de pago, con su número). Para cheques o
// retenciones, la orden de pago completa.
// Registra el pago de un comprobante desde una caja (efectivo) o un banco (transferencia): arma la
// orden de pago y la registra; si no se puede registrar, no deja el borrador suelto. Devuelve su id.
async function pagarComprobante({ proveedor_id, comprobante_id, cuenta, importe, fecha, referencia }) {
  let id = null;
  try {
    ({ id } = await api('fin/ordenes-pago', { method: 'POST', body: { proveedor_id, fecha,
      aplicaciones: [{ comprobante_id, importe }],
      valores: [{ medio: cuenta.tipo === 'caja' ? 'efectivo' : 'transferencia', cuenta_id: cuenta.id, importe, referencia }] } }));
    await api(`fin/ordenes-pago/${id}/registrar`, { method: 'POST' });
    return id;
  } catch (err) {
    if (id) await api('fin/ordenes-pago/' + id, { method: 'DELETE' }).catch(() => {});
    throw err;
  }
}
async function pagoRapido({ proveedor_id, comprobante_id, pendiente, nro, alPagar }) {
  const { cuentas } = await api('fin/cuentas');
  const usables = cuentas.filter(c => c.activa && (c.tipo === 'banco' || c.tipo === 'caja'));
  const completa = `ordenes-pago.html?proveedor=${proveedor_id}&comprobante=${comprobante_id}`;
  if (!usables.length) {
    if (confirm('No hay bancos ni cajas cargados en Tesorería para pagar. ¿Ir a cargar uno?')) location.href = 'tesoreria.html';
    return;
  }
  const f = el('form', { novalidate: true });
  const cuenta = el('select', { name: 'cuenta' }), importe = el('input', { name: 'importe', inputMode: 'decimal', value: miles(pendiente) });
  const fechaI = el('input', { name: 'fecha', type: 'date', value: hoy() }), ref = el('input', { name: 'ref', placeholder: 'nº de transferencia (opcional)' });
  opciones(cuenta, usables.map(c => [c.id, `${c.nombre} · ${c.tipo === 'caja' ? 'efectivo' : 'transferencia'} · saldo ${pesos(c.saldo)}`]));
  const m = el('span', { className: 'msg' });
  const btn = el('button', { type: 'submit', className: 'prim', textContent: 'Registrar pago' });
  const dlg = el('dialog', {}, el('h2', { textContent: 'Pagar ' + nro }),
    el('p', { className: 'ayuda', style: 'margin:0 0 12px', textContent: `Pendiente: ${pesos(pendiente)}. Se registra como orden de pago, con transferencia o efectivo.` }),
    f);
  f.append(el('div', { className: 'fila' }, el('label', {}, 'Sale de *', cuenta)),
    el('div', { className: 'fila' }, el('label', {}, 'Importe *', importe), el('label', {}, 'Fecha', fechaI)),
    el('div', { className: 'fila' }, el('label', {}, 'Referencia', ref)),
    el('div', { className: 'acciones' }, btn, el('button', { type: 'button', textContent: 'Cancelar', onclick: () => dlg.close() }), m),
    el('p', { className: 'ayuda' }, 'Con cheque o retenciones: ', el('a', { href: completa, textContent: 'orden de pago completa' }), '.'));
  f.onsubmit = async e => {
    e.preventDefault(); btn.disabled = true; m.textContent = 'Registrando…'; m.className = 'msg';
    try {
      const id = await pagarComprobante({ proveedor_id, comprobante_id, cuenta: usables.find(x => x.id === cuenta.value),
        importe: importe.value, fecha: fechaI.value, referencia: ref.value });
      dlg.close(); if (alPagar) alPagar(id);
    } catch (err) { m.textContent = err.message; m.className = 'msg mal'; }
    finally { btn.disabled = false; }
  };
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal(); importe.focus();
}

// ── Proveedor nuevo sin salir de la pantalla ────────────────────────────────────────────────
// Desde la factura o la compra: lo mínimo para cargarlo (el resto, en Proveedores). Devuelve el
// proveedor creado, o null si se canceló.
function nuevoProveedor() {
  return new Promise(resolve => {
    const f = el('form', { novalidate: true });
    const nombre = el('input', { name: 'nombre', maxLength: 120 }), cuit = el('input', { name: 'cuit', placeholder: '30-12345678-9' });
    const cond = el('select', { name: 'condicion_iva' }), plazo = el('input', { name: 'plazo', inputMode: 'numeric', placeholder: 'sin plazo' });
    opciones(cond, [['responsable_inscripto', 'Responsable inscripto'], ['monotributo', 'Monotributo'], ['exento', 'Exento'], ['no_categorizado', 'No categorizado']], null, 'Sin indicar');
    const m = el('span', { className: 'msg' }), btn = el('button', { type: 'submit', className: 'prim', textContent: 'Crear proveedor' });
    let creado = null;
    const dlg = el('dialog', {}, el('h2', { textContent: 'Nuevo proveedor' }), f);
    f.append(el('div', { className: 'fila' }, el('label', {}, 'Nombre *', nombre)),
      el('div', { className: 'fila' }, el('label', {}, 'CUIT', cuit), el('label', {}, 'Condición frente al IVA', cond)),
      el('div', { className: 'fila' }, el('label', {}, 'Plazo de pago (días)', plazo)),
      el('div', { className: 'acciones' }, btn, el('button', { type: 'button', textContent: 'Cancelar', onclick: () => dlg.close() }), m),
      el('p', { className: 'ayuda', textContent: 'Contacto, teléfono y notas se completan después en Proveedores.' }));
    f.onsubmit = async e => {
      e.preventDefault(); btn.disabled = true;
      try {
        const body = { nombre: nombre.value, cuit: cuit.value, condicion_iva: cond.value, plazo_pago_dias: plazo.value };
        const { id } = await api('proveedores', { method: 'POST', body });
        creado = { id, ...body, cuit: cuit.value.replace(/\D/g, '') || null, plazo_pago_dias: plazo.value || null, activo: true };
        dlg.close();
      } catch (err) { m.textContent = err.message; m.className = 'msg mal'; }
      finally { btn.disabled = false; }
    };
    dlg.addEventListener('close', () => { dlg.remove(); resolve(creado); });
    document.body.append(dlg); dlg.showModal(); nombre.focus();
  });
}

// ── "Agregar nuevo…" al final de una lista de valores ───────────────────────────────────────
// Si el dato que falta no está en la lista (un proveedor, una categoría), la última opción lo da de
// alta sin salir de la pantalla. `alta` devuelve [id, texto] del nuevo, o null si se canceló (vuelve a
// lo que estaba elegido). La pantalla recibe el "change" ya con el nuevo elegido.
const ALTA = '__alta';
function opcionesConAlta(select, items, valor, vacio, { texto, alta }) {
  opciones(select, items, valor, vacio);
  select.append(el('option', { value: ALTA, textContent: texto }));
  select.dataset.previo = select.value;
  if (select.dataset.conAlta) return;
  select.dataset.conAlta = '1';
  select.addEventListener('change', async e => {
    if (select.value !== ALTA) { select.dataset.previo = select.value; return; }
    e.stopImmediatePropagation();
    select.value = select.dataset.previo || '';
    const nuevo = await select._alta();
    if (!nuevo) return;
    select.insertBefore(el('option', { value: nuevo[0], textContent: nuevo[1] }), select.querySelector(`option[value="${ALTA}"]`));
    select.value = select.dataset.previo = nuevo[0];
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, true);
  select._alta = alta;
}
// Lo de siempre para proveedores: la lista y, al final, "Agregar proveedor nuevo…". `alAgregar` recibe el
// proveedor creado (para sumarlo a la lista de la pantalla).
function opcionesProveedor(select, proveedores, valor, vacio, alAgregar) {
  opcionesConAlta(select, proveedores.map(p => [p.id, p.nombre]), valor, vacio, { texto: '+ Agregar proveedor nuevo…',
    alta: async () => { const p = await nuevoProveedor(); if (!p) return null; if (alAgregar) alAgregar(p); return [p.id, p.nombre]; } });
}

// ── Producto nuevo sin salir de la pantalla ─────────────────────────────────────────────────
// Lo mínimo para empezar a comprarlo: nombre, categoría, unidad, perecedero e IVA. El SKU lo genera la
// base con el prefijo de la categoría; presentaciones, foto y el resto, después en Productos.
// Devuelve el producto (como lo da el listado) o null.
const NUEVO_PRODUCTO = '+ Crear producto nuevo';
function nuevoProducto(nombreInicial = '') {
  return new Promise(async resolve => {
    const f = el('form', { novalidate: true });
    const nombre = el('input', { name: 'nombre', maxLength: 120, value: nombreInicial === NUEVO_PRODUCTO ? '' : nombreInicial });
    const cat = el('select', { name: 'categoria_id' }), unidad = el('select', { name: 'unidad_base' }), iva = el('select', { name: 'alicuota_iva' });
    const perec = el('input', { type: 'checkbox', name: 'perecedero', checked: true });
    let { categorias } = await api('categorias');
    opcionesConAlta(cat, categorias.filter(c => c.activa).map(c => [c.id, c.nombre]), null, 'Elegir…', { texto: '+ Agregar categoría nueva…',
      alta: async () => { const n = prompt('Nombre de la categoría nueva'); if (!n || !n.trim()) return null;
        try { const { categoria } = await api('categorias', { method: 'POST', body: { nombre: n } }); return [categoria.id, categoria.nombre]; }
        catch (e) { alert(e.message); return null; } } });
    opciones(unidad, [['g', 'Peso (se lleva en gramos)'], ['ml', 'Volumen (se lleva en mililitros)'], ['u', 'Unidades']], 'g');
    opciones(iva, [['21', 'IVA 21%'], ['10.5', 'IVA 10,5%'], ['', 'Exento o no gravado']], '21');
    const m = el('span', { className: 'msg' }), btn = el('button', { type: 'submit', className: 'prim', textContent: 'Crear producto' });
    let creado = null;
    const dlg = el('dialog', {}, el('h2', { textContent: 'Producto nuevo' }), f);
    f.append(el('div', { className: 'fila' }, el('label', {}, 'Nombre *', nombre)),
      el('div', { className: 'fila' }, el('label', {}, 'Categoría *', cat), el('label', {}, 'Se mide en *', unidad)),
      el('div', { className: 'fila' }, el('label', {}, 'IVA habitual', iva)),
      el('label', { className: 'check' }, perec, 'Perecedero (se maneja por lote con vencimiento)'),
      el('div', { className: 'acciones' }, btn, el('button', { type: 'button', textContent: 'Cancelar', onclick: () => dlg.close() }), m),
      el('p', { className: 'ayuda', textContent: 'El SKU se genera solo. Presentaciones, código de barras y foto se completan después en Productos.' }));
    f.onsubmit = async e => {
      e.preventDefault(); btn.disabled = true;
      try {
        const { id } = await api('productos', { method: 'POST', body: { codigo: '', nombre: nombre.value, categoria_id: cat.value,
          unidad_base: unidad.value, perecedero: perec.checked, alicuota_iva: iva.value, presentaciones: [] } });
        catalogo._p = null;
        creado = (await catalogo.productos()).find(p => p.id === id) || null;
        dlg.close();
      } catch (err) { m.textContent = err.message; m.className = 'msg mal'; }
      finally { btn.disabled = false; }
    };
    dlg.addEventListener('close', () => { dlg.remove(); resolve(creado); });
    document.body.append(dlg); dlg.showModal(); nombre.focus();
  });
}

// ── Tablas que en el celular se leen como tarjetas ──────────────────────────────────────────
// Con la clase `movil`, cada fila pasa a ser una tarjeta y cada celda lleva el título de su columna
// (data-label, lo pone esta función a partir del encabezado). Se llama después de llenar la tabla.
function etiquetarTabla(tabla) {
  const titulos = [...tabla.querySelectorAll('thead th')].map(th => th.textContent.trim());
  tabla.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => { if (titulos[i]) td.dataset.label = titulos[i]; }));
}

// ── Medios de pago del grupo ────────────────────────────────────────────────────────────────
const TIPO_OP = { efectivo: 'Efectivo', transferencia: 'Transferencia', qr: 'Pago QR', debito: 'Tarjeta de débito', credito: 'Tarjeta de crédito', otro: 'Otro' };
const etiquetaMedio = m => m.procesador ? `${m.procesador} · ${TIPO_OP[m.tipo_operacion]}` : TIPO_OP[m.tipo_operacion];
// Alta rápida de un medio de pago: un procesador existente con un tipo nuevo, o un procesador nuevo
// (su cuenta a acreditar se crea sola). Devuelve [id, etiqueta] del medio.
function nuevoMedioPago() {
  return new Promise(async resolve => {
    const { procesadores } = await api('fin/procesadores');
    const f2 = el('form', { novalidate: true }), proc = el('select'), nombre = el('input', { placeholder: 'Mercado Pago, Getnet, Fudo Pagos…' });
    const tipo = el('select'); opciones(tipo, Object.entries(TIPO_OP).filter(([k]) => k !== 'efectivo'), 'qr');
    opciones(proc, procesadores.filter(p => p.activo).map(p => [p.id, p.nombre]), null, '— procesador nuevo —');
    const m = el('span', { className: 'msg' }); let hecho = null;
    const filaNombre = el('div', { className: 'fila' }, el('label', {}, 'Nombre del procesador nuevo *', nombre));
    proc.onchange = () => { filaNombre.hidden = !!proc.value; };
    const dlg = el('dialog', {}, el('h2', { textContent: 'Medio de pago nuevo' }), f2);
    f2.append(el('div', { className: 'fila' }, el('label', {}, 'Procesador', proc), el('label', {}, 'Tipo de operación *', tipo)), filaNombre,
      el('div', { className: 'acciones' }, el('button', { type: 'submit', className: 'prim', textContent: 'Agregar' }),
        el('button', { type: 'button', textContent: 'Cancelar', onclick: () => dlg.close() }), m),
      el('p', { className: 'ayuda', textContent: 'Un procesador nuevo acredita en su propia cuenta ("<nombre> a acreditar"), que se crea sola.' }));
    f2.onsubmit = async e => {
      e.preventDefault();
      try {
        const p = procesadores.find(x => x.id === proc.value);
        if (p) await api('fin/procesadores/' + p.id, { method: 'PUT', body: { nombre: p.nombre, cuenta_id: p.cuenta_id, activo: true, tipos: [...new Set([...p.tipos, tipo.value])] } });
        else await api('fin/procesadores', { method: 'POST', body: { nombre: nombre.value, tipos: [tipo.value] } });
        const { medios: mediosPago } = await api('pos/medios-pago');
        const n = mediosPago.find(x => x.tipo_operacion === tipo.value && (p ? x.procesador_id === p.id : (x.procesador || '').toLowerCase() === nombre.value.trim().toLowerCase()));
        hecho = n ? [n.id, etiquetaMedio(n)] : null; dlg.close();
      } catch (err) { m.textContent = err.message; m.className = 'msg mal'; }
    };
    dlg.addEventListener('close', () => { dlg.remove(); resolve(hecho); });
    document.body.append(dlg); dlg.showModal();
  });
}

