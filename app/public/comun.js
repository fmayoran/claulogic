// Helpers comunes de las pantallas de ClauLogic.
//
// Los números llegan de la API como TEXTO (NUMERIC de la base) y se muestran formateando el
// texto, sin pasar por Number: así lo que se ve es exactamente lo que está guardado.

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

async function api(url, opt = {}) {
  const r = await fetch('api/' + url, {
    ...opt, headers: { 'content-type': 'application/json' },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const d = await r.json().catch(() => ({ ok: false, error: 'Respuesta inválida del servidor.' }));
  if (!d.ok) throw new Error(d.error || 'Error del servidor.');
  return d;
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
const pesos = v => v === null || v === undefined || v === '' ? '' : '$' + num(v, 2);

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

const SECCIONES = [
  ['index.html', 'Panel'], ['stock.html', 'Stock'], ['movimientos.html', 'Movimientos'],
  ['compras.html', 'Compras'], ['produccion.html', 'Producción'], ['recetas.html', 'Recetas'],
  ['frio.html', 'Frío'], ['productos.html', 'Productos'], ['almacenes.html', 'Almacenes'],
  ['proveedores.html', 'Proveedores'], ['unidades.html', 'Unidades'],
];
function encabezado() {
  const actual = location.pathname.split('/').pop() || 'index.html';
  const top = el('header', { className: 'top' },
    el('a', { className: 'marca', href: './', textContent: 'ClauLogic' }),
    el('nav', {}, ...SECCIONES.map(([href, t]) =>
      el('a', { href, textContent: t, className: href === actual ? 'act' : '' }))));
  document.body.prepend(top);
  const act = top.querySelector('a.act'); if (act) act.scrollIntoView({ inline: 'center', block: 'nearest' });
}
encabezado();

// Cache de catálogos que usan varias pantallas.
const catalogo = {
  async productos() { return this._p ||= (await api('productos')).productos; },
  async almacenes() { return this._a ||= (await api('almacenes')).almacenes; },
  async unidades() { return this._u ||= (await api('unidades')).unidades; },
};
// Opciones de ubicación agrupadas por almacén ("Depósito central · Cámara 1").
function opcionesUbicacion(select, almacenes, valor, vacio = 'Elegir…', filtro = () => true) {
  const items = [];
  for (const a of almacenes.filter(a => a.activo))
    for (const u of a.ubicaciones.filter(u => u.activa && filtro(u, a))) items.push([u.id, `${a.nombre} · ${u.nombre}`]);
  opciones(select, items, valor, vacio);
}
function unidadesCompatibles(unidades, base) {
  const mag = (unidades.find(u => u.codigo === base) || {}).magnitud;
  return unidades.filter(u => u.magnitud === mag);
}
