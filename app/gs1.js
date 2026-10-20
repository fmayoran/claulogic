// Lectura y armado de códigos GS1.
//
// Un lector entrega texto, y según el símbolo y la configuración del lector ese texto llega de
// formas distintas. Este módulo las reduce todas a lo mismo: { gtin, lote, vencimiento, ... }.
//   · GTIN suelto:          7791234567898  (EAN-8, UPC-A, EAN-13 o GTIN-14)
//   · Cadena de AIs:        ]d201077912345678981726102810L123   (con o sin prefijo de simbología,
//                           con o sin el separador GS entre campos de largo variable)
//   · Legible por humanos:  (01)07791234567898(17)261028(10)L123
//   · GS1 Digital Link:     https://dominio/01/07791234567898/10/L123?17=261028
//
// Sin dependencias: es aritmética y texto, y conviene poder leerlo entero.

const GS = '\x1d';

// Identificadores de aplicación (AI) que interesan a un almacén gastronómico. Largo fijo (`n`) o
// máximo (`max`). La lista completa de GS1 es mucho más larga; un AI desconocido corta la lectura
// en vez de adivinar.
const AIS = {
  '00': { n: 18, nombre: 'sscc' },
  '01': { n: 14, nombre: 'gtin' },
  '02': { n: 14, nombre: 'gtin_contenido' },
  '10': { max: 20, nombre: 'lote' },
  '11': { n: 6, nombre: 'elaboracion', fecha: true },
  '13': { n: 6, nombre: 'envasado', fecha: true },
  '15': { n: 6, nombre: 'consumir_preferentemente', fecha: true },
  '16': { n: 6, nombre: 'venta_hasta', fecha: true },
  '17': { n: 6, nombre: 'vencimiento', fecha: true },
  '21': { max: 20, nombre: 'serie' },
  '30': { max: 8, nombre: 'cantidad' },
  '37': { max: 8, nombre: 'cantidad_unidades' },
  '240': { max: 30, nombre: 'id_adicional' },
};
// 310n peso neto en kg y 315n volumen neto en litros: n = cantidad de decimales.
const MEDIDAS = { '310': 'peso_kg', '315': 'volumen_l' };

function digitoVerificador(cuerpo) {
  let s = 0;
  for (let i = 0; i < cuerpo.length; i++) {
    const d = +cuerpo[cuerpo.length - 1 - i];
    s += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (s % 10)) % 10;
}

// Cualquier GTIN de 8, 12, 13 o 14 dígitos -> 14 dígitos validado, o null.
function normalizarGtin(g) {
  const s = String(g || '').trim();
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(s)) return null;
  const g14 = s.padStart(14, '0');
  return digitoVerificador(g14.slice(0, 13)) === +g14[13] ? g14 : null;
}

// AAMMDD -> 'AAAA-MM-DD'. El siglo según la regla GS1 (el año queda entre 49 años atrás y 50
// adelante de hoy), y día 00 = último día del mes.
function fechaGs1(aammdd, hoy = new Date()) {
  if (!/^\d{6}$/.test(aammdd)) return null;
  const aa = +aammdd.slice(0, 2), mm = +aammdd.slice(2, 4);
  let dd = +aammdd.slice(4, 6);
  if (mm < 1 || mm > 12) return null;
  const actual = hoy.getFullYear(), siglo = Math.floor(actual / 100) * 100;
  let anio = siglo + aa;
  if (anio - actual > 50) anio -= 100; else if (actual - anio > 49) anio += 100;
  const ultimo = new Date(Date.UTC(anio, mm, 0)).getUTCDate();
  if (dd === 0) dd = ultimo;
  if (dd > ultimo) return null;
  return `${anio}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
// 'AAAA-MM-DD' -> AAMMDD, para armar códigos.
const aGs1Fecha = f => f ? f.slice(2, 4) + f.slice(5, 7) + f.slice(8, 10) : null;

function definicion(ai) {
  if (AIS[ai]) return { ai, ...AIS[ai] };
  const m = MEDIDAS[ai.slice(0, 3)];
  if (m && ai.length === 4 && /\d/.test(ai[3])) return { ai, n: 6, nombre: m, decimales: +ai[3] };
  return null;
}

// Busca el AI al comienzo del texto: los hay de 2, 3 y 4 dígitos.
function aiAlComienzo(s) {
  for (const largo of [2, 3, 4]) {
    const d = definicion(s.slice(0, largo));
    if (d) return d;
  }
  return null;
}

function asignar(out, d, valor) {
  if (d.fecha) {
    const f = fechaGs1(valor);
    if (!f) throw new Error(`Fecha inválida en el AI (${d.ai}): ${valor}`);
    out[d.nombre] = f;
  } else if (d.decimales !== undefined) {
    // "001250" con 3 decimales = "1.250", en texto (nada de float).
    const ent = valor.slice(0, 6 - d.decimales).replace(/^0+(?=\d)/, '');
    const dec = d.decimales ? valor.slice(6 - d.decimales) : '';
    out[d.nombre] = dec ? `${ent}.${dec}` : ent;
  } else {
    out[d.nombre] = valor;
  }
}

// Cadena de AIs sin paréntesis. Los campos de largo variable terminan en GS o al final del texto.
// Si el lector no manda GS (pasa con lectores configurados como teclado), un largo variable
// seguido de otro campo no se puede separar: se lo deja hasta el final, que es como lo imprimen
// los proveedores justamente por eso.
function leerElementos(s) {
  const out = {};
  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) { i++; continue; }
    const d = aiAlComienzo(s.slice(i));
    if (!d) throw new Error(`No reconozco el identificador de aplicación en "${s.slice(i, i + 4)}…".`);
    i += d.ai.length;
    let valor;
    if (d.n) {
      valor = s.slice(i, i + d.n);
      if (valor.length !== d.n) throw new Error(`El AI (${d.ai}) viene incompleto.`);
      i += d.n;
    } else {
      const fin = s.indexOf(GS, i);
      valor = s.slice(i, fin === -1 ? s.length : fin);
      if (valor.length > d.max) throw new Error(`El AI (${d.ai}) es más largo de lo permitido.`);
      i = fin === -1 ? s.length : fin + 1;
    }
    asignar(out, d, valor);
  }
  return out;
}

function leerParentesis(s) {
  const out = {};
  const re = /\((\d{2,4})\)([^(]*)/g;
  let m, visto = false;
  while ((m = re.exec(s))) {
    visto = true;
    const d = definicion(m[1]);
    if (!d) throw new Error(`No reconozco el identificador de aplicación (${m[1]}).`);
    asignar(out, d, m[2].trim());
  }
  return visto ? out : null;
}

// GS1 Digital Link: el camino trae pares AI/valor (/01/…/10/…) y la consulta, más AIs (?17=…).
function leerDigitalLink(s) {
  let u;
  try { u = new URL(s); } catch { return null; }
  const partes = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const i = partes.indexOf('01');
  if (i === -1 || !/^\d{8,14}$/.test(partes[i + 1] || '')) return null;
  const out = {};
  for (let k = i; k + 1 < partes.length; k += 2) {
    const d = definicion(partes[k]);
    if (d) asignar(out, d, partes[k + 1]);
  }
  for (const [k, v] of u.searchParams) {
    const d = definicion(k);
    if (d) asignar(out, d, v);
  }
  return out;
}

// Punto de entrada. Devuelve { formato, gtin?, lote?, vencimiento?, ... } o, si el texto no es
// GS1, { formato: 'texto', texto } para que quien llama lo busque como SKU o código de lote.
function leer(entrada) {
  let s = String(entrada || '').replace(/[\r\n]+$/, '').trim();
  if (!s) throw new Error('No llegó ningún código.');
  // Prefijos de simbología que agregan algunos lectores: ]C1 GS1-128, ]d2 DataMatrix, ]Q3 QR, ]e0 DataBar.
  let simbologia = null;
  const pref = s.match(/^\](C1|d2|Q3|e0|E0|E3|E4)/);
  if (pref) { simbologia = pref[1]; s = s.slice(3); }
  // Algunos lectores mandan el GS como texto; los más comunes, normalizados.
  s = s.replace(/<GS>|\{GS\}|\\x1d|␝/gi, GS);

  let out, formato;
  if (/^https?:\/\//i.test(s)) {
    out = leerDigitalLink(s); formato = 'digital_link';
    if (!out) return { formato: 'texto', texto: s };
  } else if (s.startsWith('(')) {
    out = leerParentesis(s); formato = 'parentesis';
    if (!out) return { formato: 'texto', texto: s };
  } else if (/^\d{8}$|^\d{12,14}$/.test(s) && !simbologia) {
    const g = normalizarGtin(s);
    if (!g) throw new Error('El código tiene el largo de un GTIN pero el dígito verificador no coincide: revisá la lectura.');
    return { formato: 'gtin', gtin: g };
  } else if (simbologia || s.includes(GS) || /^(00|01|02)\d{14}/.test(s)) {
    out = leerElementos(s); formato = 'elementos';
  } else {
    return { formato: 'texto', texto: s };
  }
  for (const k of ['gtin', 'gtin_contenido']) {
    if (out[k] === undefined) continue;
    const g = normalizarGtin(out[k]);
    if (!g) throw new Error(`El GTIN ${out[k]} tiene mal el dígito verificador.`);
    out[k] = g;
  }
  return { formato, ...out };
}

// ── Armado ───────────────────────────────────────────────────────────────────────────────────
// GS1 Digital Link de un lote: es lo que va en el QR. Lo lee cualquier celular (abre la ficha del
// lote en la app) y cualquier lector 2D que entienda Digital Link.
function digitalLink(base, { gtin, lote, vencimiento }) {
  let u = `${base.replace(/\/+$/, '')}/01/${gtin}`;
  if (lote) u += `/10/${encodeURIComponent(lote)}`;
  if (vencimiento) u += `?17=${aGs1Fecha(vencimiento)}`;
  return u;
}

// Texto legible que va debajo del código, con los AIs entre paréntesis como pide GS1.
function legible({ gtin, lote, vencimiento }) {
  return `(01)${gtin}` + (vencimiento ? `(17)${aGs1Fecha(vencimiento)}` : '') + (lote ? `(10)${lote}` : '');
}

module.exports = { leer, normalizarGtin, digitoVerificador, fechaGs1, digitalLink, legible, GS };
