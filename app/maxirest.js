// Adaptador de Maxirest Cloud. Trae los comprobantes de un rango de días con su forma de pago y los devuelve en el
// formato común de ClauLogic (el mismo que el adaptador de Fudo): { tickets: [{ id, cerrado_en, abierto_en, estado,
// total, tipo, mesa, mozo, personas, items, pagos: [{ codigo, nombre, importe }] }], abiertas, abiertasDetalle }.
//
// Maxirest no publica una API: es el servicio que usa su propia página (cloud.maxirest.com), relevado el 01/11/2026
// con la sesión de Fer (decisión de Fer: usarlo sabiendo que puede cambiar sin aviso).
//   · Login, en dos pasos: POST <login>/auth {mail, password} -> {token (de usuario), clientes[{codigo, nombre}]};
//     POST <login>/login/cuentas/<codigo> con el token de usuario y cuerpo vacío -> {token (del restaurante)}. Los dos
//     duran 8 horas; no hay renovación: se vuelve a entrar.
//   · "Ventas detalladas": GET <informes>/totales/detalles?from=<ms>&to=<ms>&fechaComp=false con el token del
//     restaurante. from y to son el día a las 00:00 de Buenos Aires en milisegundos (con fechas en texto responde 500);
//     el rango incluye los dos días y viene entero, sin paginado. Una fila por comprobante y forma de pago: con una sola
//     forma, el importe es `total`; con dos, el comprobante se repite y `subtotal` es lo pagado con cada una (`total`
//     se repite). Así, octubre de Sorelle da 808 comprobantes y $55.200.445, como las dos pantallas de Maxirest.
//   · No trae los artículos de cada comprobante (sólo el total por artículo del día, en otro informe) ni las mesas
//     abiertas: sólo comprobantes emitidos.
//
// Las URLs se pueden cambiar por entorno (MAXIREST_LOGIN_URL, MAXIREST_INFORMES_URL) para probar contra un servidor
// simulado; en producción son las de Maxirest.
const LOGIN_URL = (process.env.MAXIREST_LOGIN_URL || 'https://cloud-api.maxirest.com/v1/maxirestonline/clientes/v1/usuarios').replace(/\/+$/, '');
const INFORMES_URL = (process.env.MAXIREST_INFORMES_URL || 'https://api-informes-legacy.backend.prod.maxirest.com/v1/maxirestonline/maxirestinformes/v1/ventas').replace(/\/+$/, '');
const ESPERA_MS = 30000;

class ErrorMaxirest extends Error {}
const TIPO_VENTA = { salon: 'salón', mostrador: 'para llevar', delivery: 'delivery' };
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

async function pedir(url, opciones = {}) {
  let r;
  try {
    r = await fetch(url, { ...opciones, signal: AbortSignal.timeout(ESPERA_MS),
      headers: { Accept: 'application/json', ...(opciones.headers || {}) } });
  } catch (e) {
    throw new ErrorMaxirest(e.name === 'TimeoutError' ? 'Maxirest no respondió a tiempo.' : 'No se pudo conectar con Maxirest.');
  }
  const texto = await r.text();
  let cuerpo = null;
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch { /* respuesta que no es JSON */ }
  if (r.status === 401 || r.status === 403)
    throw new ErrorMaxirest('Maxirest rechazó el usuario o la clave (revisalos en la ficha de la sede; si la clave venció, cambiala en Maxirest).');
  if (!r.ok) {
    const det = cuerpo && (cuerpo.mensaje || cuerpo.message) ? cuerpo.mensaje || cuerpo.message : texto.slice(0, 200);
    throw new ErrorMaxirest(`Maxirest respondió ${r.status}${det ? ': ' + det : ''}.`);
  }
  if (cuerpo == null) throw new ErrorMaxirest('Maxirest devolvió una respuesta inválida.');
  return cuerpo;
}

// Token del restaurante, en memoria por integración, hasta media hora antes de las 8 horas.
const tokens = new Map();
async function token(integracionId, cred) {
  const t = tokens.get(integracionId);
  if (t && t.vence > Date.now()) return t.token;
  const u = await pedir(`${LOGIN_URL}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mail: cred.mail, password: cred.password }) });
  if (!u.token) throw new ErrorMaxirest('Maxirest no devolvió el token de usuario.');
  const clientes = Array.isArray(u.clientes) ? u.clientes : [];
  // El restaurante: el código cargado en la ficha o, si el usuario tiene uno solo, ése.
  const cli = cred.cliente ? clientes.find(c => String(c.codigo) === String(cred.cliente)) : clientes.length === 1 ? clientes[0] : null;
  if (!cli) throw new ErrorMaxirest(cred.cliente
    ? `El usuario de Maxirest no tiene el restaurante ${cred.cliente}.`
    : `El usuario de Maxirest tiene ${clientes.length} restaurantes: indicá el código en la ficha de la sede (${clientes.map(c => `${c.codigo} ${c.nombre || ''}`.trim()).join(', ')}).`);
  if (cli.bloqueado) throw new ErrorMaxirest(`El restaurante ${cli.codigo} figura bloqueado en Maxirest.`);
  const r = await pedir(`${LOGIN_URL}/login/cuentas/${encodeURIComponent(cli.codigo)}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }, body: '{}' });
  if (!r.token) throw new ErrorMaxirest('Maxirest no devolvió el token del restaurante.');
  tokens.set(integracionId, { token: r.token, vence: Date.now() + 7.5 * 3600e3 });
  return r.token;
}
const olvidarToken = id => tokens.delete(id);

// Día del local (AAAA-MM-DD) a las 00:00 de Buenos Aires (UTC-3, sin horario de verano), en milisegundos.
const msDia = dia => { const [a, m, d] = dia.split('-').map(Number); return Date.UTC(a, m - 1, d, 3); };
const isoFecha = f => { const [d, m, a] = String(f).split('-'); return `${a}-${m}-${d}`; };   // dd-mm-aaaa
const instante = (dia, hora) => /^\d{1,2}:\d{2}$/.test(hora || '') ? `${dia}T${hora.padStart(5, '0')}:00-03:00` : null;
const sumarDia = dia => new Date(Date.parse(dia + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);

// Los comprobantes de los días `desde` a `hasta` (días del local, los dos incluidos).
async function ventas(integracionId, cred, desde, hasta) {
  const tk = await token(integracionId, cred);
  const q = new URLSearchParams({ from: String(msDia(desde)), to: String(msDia(hasta)), fechaComp: 'false' });
  let filas;
  try { filas = await pedir(`${INFORMES_URL}/totales/detalles?${q}`, { headers: { Authorization: `Bearer ${tk}` } }); }
  catch (e) { if (e instanceof ErrorMaxirest && /rechazó/.test(e.message)) olvidarToken(integracionId); throw e; }
  if (!Array.isArray(filas)) throw new ErrorMaxirest('Maxirest devolvió las ventas en un formato inesperado.');
  // Una fila por comprobante y forma de pago: se agrupan por comprobante.
  const porComp = new Map();
  for (const f of filas) {
    if (!f || !f.Comprobante) continue;
    if (!porComp.has(f.Comprobante)) porComp.set(f.Comprobante, []);
    porComp.get(f.Comprobante).push(f);
  }
  const tickets = [];
  for (const [comp, fs] of porComp) {
    const f = fs[0], dia = isoFecha(f.fecha);
    const abierto = instante(dia, f['Hora Entrada']);
    // La salida antes que la entrada es del día siguiente (una mesa que se cerró pasada la medianoche).
    const salidaDia = f['Hora Salida'] && f['Hora Entrada'] && f['Hora Salida'] < f['Hora Entrada'] ? sumarDia(dia) : dia;
    const cerrado = instante(salidaDia, f['Hora Salida']) || abierto || `${dia}T12:00:00-03:00`;
    tickets.push({
      id: String(comp), abierto_en: abierto || `${dia}T12:00:00-03:00`, cerrado_en: cerrado, estado: 'cerrado',
      total: f.total != null ? String(f.total) : null, tipo: TIPO_VENTA[sinAcentos(f['Nombre Concepto'])] || 'salón',
      mesa: f.Mesa != null && f.Mesa !== '' ? String(f.Mesa) : null,
      mozo: f['Codigo Mozo'] != null ? `Mozo ${f['Codigo Mozo']}` : null,
      personas: f.Cubiertos ?? null, items: [],
      pagos: fs.map(x => {
        const nombre = x['Forma Pago'] ? String(x['Forma Pago']).trim() : 'SIN NOMBRE';
        return { codigo: nombre.toUpperCase(), nombre, importe: String(fs.length > 1 ? x.subtotal ?? 0 : x.total ?? 0), anulado: false, id: null };
      }),
    });
  }
  return { tickets, abiertas: {}, abiertasDetalle: {} };
}

module.exports = { ventas, olvidarToken, ErrorMaxirest };
