// Adaptador del portal de Pago24 (Traxion), para traer el extracto de la Cta. Cte. Disponible sin bajar el archivo.
//
// Pago24 no publica una API (Fer lo confirmó el 03/11/2026). El portal lo arma el servidor con un framework propio
// ("Ajaxifier"), relevado ese día con la sesión de Fer en su navegador:
//   · Todo pasa por un único endpoint, /tr4?_s=<sesión>&_k=<clave>. `_s` es fija durante la sesión; `_k` cambia en
//     cada respuesta y hay que tomar la nueva de los links o del formulario de la última. La única cookie es
//     SERVERID (afinidad del balanceador), que hay que mantener.
//   · Los campos se llaman con números que cambian en cada carga: cada uno se ubica por su etiqueta o su tipo.
//   · El login es un formulario (usuario, clave y botón, más un campo de texto sin nombre que no se manda). La página
//     carga reCAPTCHA: si lo muestra, desde el servidor no se puede entrar y el extracto sigue por archivo.
//
// Etapa 1 (esta): entrar y contar qué se ve después ("Probar conexión"), sin guardar nada. El recorrido hasta la
// pestaña, la búsqueda por fechas y el paginado se arman con lo que devuelva esta prueba desde el servidor.
const ESPERA_MS = 30000;
class ErrorPago24 extends Error {}

// Lo mínimo de HTML que hace falta: atributos de una etiqueta y texto visible, sin dependencias.
const entidades = s => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const atributos = tag => Object.fromEntries([...tag.matchAll(/([a-zA-Z_:-][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)]
  .map(m => [m[1].toLowerCase(), entidades(m[3] ?? m[4] ?? m[5] ?? '')]));
const textoVisible = html => entidades(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Una sesión del portal: las cookies (SERVERID) y la última página, de donde sale la próxima `_k`.
class Sesion {
  constructor(base) { this.base = base; this.cookies = new Map(); }
  async pedir(url, { method = 'GET', cuerpo, ajax } = {}) {
    let r;
    try {
      r = await fetch(new URL(url, this.base), { method, redirect: 'manual', signal: AbortSignal.timeout(ESPERA_MS), headers: {
        Accept: '*/*', 'User-Agent': 'Mozilla/5.0 (ClauLogic)',
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(cuerpo ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(ajax ? { 'X-Requested-With': ajax } : {}) }, body: cuerpo });
    } catch (e) {
      throw new ErrorPago24(e.name === 'TimeoutError' ? 'El portal de Pago24 no respondió a tiempo.' : 'No se pudo conectar con el portal de Pago24.');
    }
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
      const [par] = c.split(';'), i = par.indexOf('=');
      if (i > 0) this.cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) return this.pedir(new URL(r.headers.get('location'), new URL(url, this.base)).href);
    const html = await r.text();
    if (!r.ok) throw new ErrorPago24(`El portal de Pago24 respondió ${r.status}.`);
    this.url = new URL(url, this.base).href; this.html = html;
    return html;
  }
}

// El formulario de entrada: el que tiene el campo de clave. Devuelve a dónde se manda y los campos con nombre.
function formularioDeEntrada(html) {
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const cuerpo = m[2];
    if (!/type\s*=\s*["']?password/i.test(cuerpo)) continue;
    const campos = [...cuerpo.matchAll(/<(input|button)\b[^>]*>/gi)].map(x => ({ etiqueta: x[1].toLowerCase(), ...atributos(x[0]) }));
    return { action: atributos(`<form ${m[1]}>`).action || '', campos, cuerpo };
  }
  return null;
}
const pideCaptcha = html => /class\s*=\s*["'][^"']*g-recaptcha|data-sitekey\s*=/i.test(html);

async function entrar(cred) {
  if (!cred.url) throw new ErrorPago24('Falta la dirección del portal de Pago24.');
  const s = new Sesion(cred.url);
  const inicio = await s.pedir(cred.url);
  const f = formularioDeEntrada(inicio);
  if (!f) throw new ErrorPago24('No se encontró el formulario de entrada en el portal de Pago24 (¿la dirección es la de la página de login?).');
  if (pideCaptcha(f.cuerpo)) throw new ErrorPago24('El portal de Pago24 pide un captcha para entrar: desde el servidor no se puede, el extracto sigue por archivo.');
  // Usuario: el primer campo de texto con nombre antes de la clave; clave: el de tipo password; el botón, con su valor.
  const conNombre = f.campos.filter(c => c.name);
  const iClave = conNombre.findIndex(c => (c.type || '').toLowerCase() === 'password');
  const usuario = conNombre.slice(0, iClave).reverse().find(c => c.etiqueta === 'input' && ['text', 'email', ''].includes((c.type || '').toLowerCase()));
  if (iClave < 0 || !usuario) throw new ErrorPago24('El formulario de entrada de Pago24 cambió: no se reconocen el usuario y la clave.');
  const datos = new URLSearchParams();
  for (const c of conNombre) {
    const tipo = (c.type || '').toLowerCase();
    if (c === usuario) datos.append(c.name, cred.usuario);
    else if (tipo === 'password') datos.append(c.name, cred.clave);
    else if (tipo === 'hidden') datos.append(c.name, c.value || '');
    else if (c.etiqueta === 'button' || ['submit', 'button'].includes(tipo)) datos.append(c.name, c.value || '');
  }
  const despues = await s.pedir(f.action || s.url, { method: 'POST', cuerpo: datos.toString(), ajax: 'Ajaxifier' });
  // Si vuelve el formulario con la clave, no entró: el motivo es el texto que muestre (usuario o clave, bloqueo, captcha).
  if (formularioDeEntrada(despues) || /type\s*=\s*["']?password/i.test(despues)) {
    if (pideCaptcha(despues)) throw new ErrorPago24('El portal de Pago24 pidió un captcha al entrar: desde el servidor no se puede, el extracto sigue por archivo.');
    const aviso = textoVisible(despues).match(/[^.]*(incorrect|invalid|inválid|bloquead|error|intente)[^.]*\.?/i);
    throw new ErrorPago24('Pago24 no aceptó el usuario o la clave' + (aviso ? `: "${aviso[0].trim().replace(/\.$/, '').slice(0, 160)}"` : '') + '.');
  }
  if (/codigo de (verificacion|seguridad)|token de seguridad|segundo factor|doble factor/.test(sinAcentos(textoVisible(despues))))
    throw new ErrorPago24('El portal de Pago24 pide un código de verificación al entrar: desde el servidor no se puede, el extracto sigue por archivo.');
  return s;
}

// Probar la conexión: entra y cuenta qué ve, para armar el resto del recorrido. Devuelve sólo textos de la pantalla
// (opciones del menú y pestañas): ni la sesión, ni las direcciones, ni importes.
async function probar(cred) {
  const s = await entrar(cred);
  const links = [...new Set([...s.html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(m => textoVisible(m[1])).filter(t => t && t.length <= 60))];
  const cuentas = [...new Set((textoVisible(s.html).match(/\b\d{6}\b/g) || []))].slice(0, 5);
  return { mensaje: `Entró al portal de Pago24${cuentas.length ? ` (cuenta ${cuentas.join(', ')})` : ''}.${links.length ? ` Ve ${links.length} opciones` : ''}`
      + `${links.some(t => /disponible/i.test(t)) ? ', entre ellas la Cta. Cte. Disponible' : ''}${links.length ? '.' : ''}`,
    opciones: links.slice(0, 80), cuentas, tamano: s.html.length };
}

// ── Etapa 2: el extracto de la Cta. Cte. Disponible ──
// Recorrido relevado desde el servidor el 03/11/2026 con el usuario de CORTAFUEGO:
//   · "Financiero" es un link común del menú; su página tiene el formulario con las pestañas (links, cada uno trae su
//     fragmento de campos) y los botones Buscar y Limpiar.
//   · La pestaña Disponible trae Desde y Hasta (dd/mm/aaaa), Agrupar (casilla, no se manda), Dist/PV, Producto (1 = pesos)
//     y un buscador de cuenta (select2) que no se manda en el formulario: elegir una cuenta es un pedido aparte que la
//     deja guardada en la sesión. El usuario ve la cuenta de distribuidor y la del punto de venta: se elige la del punto
//     de venta.
//   · Buscar es un POST del formulario (el botón con valor vacío); la tabla viene paginada de a 100, pero "Exportar a
//     Excel" baja en realidad un CSV de todo el rango (reporte.csv, `;`, coma decimal, ISO-8859-1), con el saldo inicial
//     y el final: Fecha;Descripción;Contraparte;Débitos;Créditos;Saldo;Objs.;V.
const hrefDe = (html, re) => {
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) if (re.test(textoVisible(m[2]))) {
    const h = (m[1].match(/href\s*=\s*"([^"]*)"/i) || [])[1]; if (h) return entidades(h);
  }
  return null;
};
const sesionDe = html => { const m = html.match(/_s=([^&"']+)&(?:amp;)?_k=([^&"']+)/); return m ? { s: m[1], k: m[2] } : null; };
// El campo que sigue a una etiqueta ("Desde fecha:"): su nombre numérico.
const campoDe = (html, etiqueta) => { const i = html.search(etiqueta); if (i < 0) return null; const m = html.slice(i).match(/<(?:input|select)\b[^>]*name="(\d+)"/); return m && m[1]; };
const dmy = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const cambio = qué => new ErrorPago24(`El portal de Pago24 cambió (${qué}): el extracto sigue por archivo hasta adaptar la conexión.`);

// Un CSV con `;` (y comillas si algún campo las trae), como filas de texto.
function filasCSV(texto) {
  const filas = []; let fila = [], campo = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) { if (ch === '"' && texto[i + 1] === '"') { campo += '"'; i++; } else if (ch === '"') comillas = false; else campo += ch; }
    else if (ch === '"') comillas = true;
    else if (ch === ';') { fila.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && texto[i + 1] === '\n') i++; fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else campo += ch;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.some(c => c.trim()));
}
// Las filas del reporte en el formato que recibe la importación de extractos (como las mapea la pantalla: Objs. es la
// referencia, donde viene el número de operación al que se refiere un cargo o un impuesto).
function filasExtracto(csv) {
  const [cab, ...resto] = filasCSV(csv);
  const col = n => cab.findIndex(c => sinAcentos(c).replace(/[^a-z]/g, '') === n);
  const ix = { fecha: col('fecha'), concepto: col('descripcion'), debito: col('debitos'), credito: col('creditos'), saldo: col('saldo'), referencia: col('objs') };
  if (Object.values(ix).some(i => i < 0)) throw cambio('columnas del reporte');
  return resto.map(f => Object.fromEntries(Object.entries(ix).map(([k, i]) => [k, (f[i] || '').trim()])));
}

async function extracto(cred, desde, hasta) {
  const s = await entrar(cred);
  const fin = await s.pedir(hrefDe(s.html, /^Financiero$/) || (() => { throw cambio('no está Financiero en el menú'); })());
  const boton = (fin.match(/name="(\d+)"\s+value="Buscar"/) || [])[1];
  const hTab = hrefDe(fin, /Cta\.?\s*Cte\.?\s*Disponible/i);
  if (!boton || !hTab) throw cambio('la pantalla Financiero');
  const tab = await s.pedir(hTab);
  const ses = sesionDe(tab);
  const f = { desde: campoDe(tab, /Desde fecha/i), hasta: campoDe(tab, /Hasta fecha/i), dist: campoDe(tab, /Dist\/PV/i), producto: campoDe(tab, /Producto/i),
              oculto: (tab.match(/name="(\d+)"\s+type="hidden"/) || [])[1] };
  if (!ses || Object.values(f).some(x => !x)) throw cambio('la pestaña Cta. Cte. Disponible');
  // La cuenta: la del punto de venta (o la que diga la ficha, si hubiera más de una).
  const fuente = (tab.match(/\.select2\(\{[\s\S]*?"url":"[^"]*&(\d+)"/) || [])[1];
  const elegir = tab.match(/"data":\["_s=[^"]+","_k=[^"]+","(\d+)","(\d+)="\+encodeURIComponent\(evt\.params\.data\.id\)/);
  if (!fuente || !elegir) throw cambio('el buscador de cuenta');
  let lista;
  try { lista = JSON.parse(await s.pedir(`/tr4?_s=${ses.s}&_k=${ses.k}&${fuente}&q=${encodeURIComponent(cred.cuenta || '')}&page=1`, { ajax: 'XMLHttpRequest' })); }
  catch (e) { if (e instanceof ErrorPago24) throw e; throw cambio('la lista de cuentas'); }
  const pvs = (lista.items || []).filter(g => /punto de venta/i.test(g.text || '')).flatMap(g => g.children || []);
  const cuenta = cred.cuenta ? pvs.find(x => String(x.text).startsWith(String(cred.cuenta))) : pvs.length === 1 ? pvs[0] : null;
  if (!cuenta) throw new ErrorPago24(pvs.length ? `El usuario de Pago24 tiene ${pvs.length} cuentas de punto de venta (${pvs.map(x => x.text).join(', ')}): falta indicar cuál.`
    : 'El usuario de Pago24 no tiene ninguna cuenta de punto de venta.');
  await s.pedir(`/tr4?_s=${ses.s}&_k=${ses.k}&${elegir[1]}&${elegir[2]}=${encodeURIComponent(cuenta.id)}`, { ajax: 'XMLHttpRequest' });
  const cuerpo = new URLSearchParams({ [f.desde]: dmy(desde), [f.oculto]: '', [f.hasta]: dmy(hasta), [f.dist]: '', [f.producto]: '1', [boton]: '' });
  const res = await s.pedir(`/tr4?_s=${ses.s}&_k=${ses.k}`, { method: 'POST', cuerpo: cuerpo.toString(), ajax: 'Ajaxifier' });
  const hExp = (res.match(/href="([^"]*)"[^>]*>(?:\s*<i[^>]*><\/i>)?\s*Exportar a Excel/i) || [])[1];
  if (!hExp) {
    const aviso = textoVisible(res).match(/[^.]*(no se encontr|sin datos|inv[aá]lid|error)[^.]*\.?/i);
    throw aviso ? new ErrorPago24(`Pago24 respondió: "${aviso[0].trim().slice(0, 160)}".`) : cambio('el resultado de la búsqueda');
  }
  // La descarga es un archivo común (no Ajaxifier), en ISO-8859-1.
  let r;
  try {
    r = await fetch(new URL(entidades(hExp), s.base), { signal: AbortSignal.timeout(ESPERA_MS),
      headers: { Accept: '*/*', 'User-Agent': 'Mozilla/5.0 (ClauLogic)', Cookie: [...s.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  } catch { throw new ErrorPago24('No se pudo bajar el reporte de Pago24.'); }
  if (!r.ok) throw new ErrorPago24(`Pago24 respondió ${r.status} al bajar el reporte.`);
  const csv = Buffer.from(await r.arrayBuffer()).toString('latin1');
  if (!/^\s*Fecha;/i.test(csv)) throw cambio('el archivo exportado');
  return { cuenta: cuenta.text, filas: filasExtracto(csv) };
}

module.exports = { probar, entrar, extracto, filasExtracto, ErrorPago24, formularioDeEntrada, textoVisible };
