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

module.exports = { probar, entrar, ErrorPago24, formularioDeEntrada, textoVisible };
