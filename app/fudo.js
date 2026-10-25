// Adaptador de Fudo (API pública v1alpha1). Trae las ventas cerradas o anuladas de un rango y las
// devuelve en el formato común de ClauLogic: { tickets: [{ id, cerrado_en, estado, total, tipo,
// mesa, mozo, personas, items: [{ codigo, nombre, cantidad, precio, anulado }], pagos: [{ codigo,
// nombre, importe, anulado }] }] }.
//
// Documentación: https://dev.fu.do/api (OpenAPI en https://api.fu.do/v1alpha1/openapi.yml).
//   · Token: POST https://auth.fu.do/api {apiKey, apiSecret} -> {token, exp}. Dura 24 h.
//   · Ventas: GET /sales con filter[closedAt]=and(gte.…,lte.…), include=items.product,payments.paymentMethod,
//     page[size] hasta 500; la última página es la que trae menos que page[size].
// La especificación no es del todo consistente con JSON:API (las relaciones a veces figuran como
// lista de {data}), así que se aceptan las dos formas.
//
// Las URLs se pueden cambiar por entorno (FUDO_AUTH_URL, FUDO_API_URL) para probar contra un
// servidor simulado; en producción son las de Fudo y no se toman de ningún otro lado.
const AUTH_URL = process.env.FUDO_AUTH_URL || 'https://auth.fu.do/api';
const API_URL = (process.env.FUDO_API_URL || 'https://api.fu.do/v1alpha1').replace(/\/+$/, '');
const TAMANO = 500, MAX_PAGINAS = 60, ESPERA_MS = 20000;

class ErrorFudo extends Error {}

// Token en memoria por integración, hasta 5 minutos antes de que venza.
const tokens = new Map();

async function pedir(url, opciones = {}) {
  let r;
  try {
    r = await fetch(url, { ...opciones, signal: AbortSignal.timeout(ESPERA_MS),
      headers: { Accept: 'application/json', ...(opciones.headers || {}) } });
  } catch (e) {
    throw new ErrorFudo(e.name === 'TimeoutError' ? 'Fudo no respondió a tiempo.' : 'No se pudo conectar con Fudo.');
  }
  const texto = await r.text();
  let cuerpo = null;
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch { /* respuesta que no es JSON */ }
  if (r.status === 401 || r.status === 403) throw new ErrorFudo('Fudo rechazó las credenciales (revisá apiKey y apiSecret, y los permisos del usuario de la API).');
  if (r.status === 429) throw new ErrorFudo('Fudo limitó la cantidad de pedidos: probá de nuevo en unos minutos.');
  // Con el detalle que da Fudo (JSON:API: errors[].detail), para saber qué rechazó.
  if (!r.ok) {
    const det = cuerpo && Array.isArray(cuerpo.errors) ? cuerpo.errors.map(e => e.detail || e.title).filter(Boolean).join(' / ') : texto.slice(0, 200);
    throw new ErrorFudo(`Fudo respondió ${r.status}${det ? ': ' + det : ''}.`);
  }
  if (!cuerpo) throw new ErrorFudo('Fudo devolvió una respuesta inválida.');
  return cuerpo;
}

async function token(integracionId, cred) {
  const t = tokens.get(integracionId);
  if (t && t.exp - 300 > Date.now() / 1000) return t.token;
  const r = await pedir(AUTH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: cred.apiKey, apiSecret: cred.apiSecret }) });
  if (!r.token) throw new ErrorFudo('Fudo no devolvió el token.');
  tokens.set(integracionId, { token: r.token, exp: Number(r.exp) || Date.now() / 1000 + 3600 });
  return r.token;
}
const olvidarToken = id => tokens.delete(id);

// Ids de una relación, en cualquiera de las dos formas.
function ids(rel) {
  if (!rel) return [];
  if (Array.isArray(rel)) return rel.map(x => x && x.data && x.data.id).filter(Boolean);
  if (Array.isArray(rel.data)) return rel.data.map(x => x.id);
  if (rel.data && rel.data.id) return [rel.data.id];
  return [];
}

// Ventas ABIERTAS entre dos instantes UTC ('AAAA-MM-DDTHH:MM:SSZ'), los dos incluidos: el día de una venta es el
// de su apertura, como lo cuenta Fudo. El filtro por apertura exige `and(gte.<desde>,lte.<hasta>)` (el de
// cierre, en cambio, exige `lt`: verificado contra la API real el 25/10/2026). Se importan las cerradas y las
// anuladas; las que siguen abiertas (mesas sin cerrar) sólo se cuentan por día (`abiertas`): llegan cuando se
// vuelva a sincronizar ese día (la importación no duplica).
// Las ventas vacías (sin productos ni pagos: se abrieron y cerraron sin cargar nada) se ignoran.
async function ventas(integracionId, cred, desdeUtc, hastaUtc) {
  const tk = await token(integracionId, cred);
  const tickets = [], abiertas = {};
  // Día de la cocina (Buenos Aires, UTC-3, sin horario de verano) de un instante UTC.
  const diaLocal = iso => new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 10);
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const q = new URLSearchParams({
      'filter[createdAt]': `and(gte.${desdeUtc},lte.${hastaUtc})`,
      include: 'items,items.product,payments,payments.paymentMethod,table,waiter',
      'page[size]': String(TAMANO), 'page[number]': String(pagina), sort: 'createdAt',
    });
    const r = await pedir(`${API_URL}/sales?${q}`, { headers: { Authorization: `Bearer ${tk}` } });
    const datos = Array.isArray(r.data) ? r.data : [];
    const incl = new Map((r.included || []).map(x => [`${x.type}:${x.id}`, x]));
    const de = (tipo, id) => incl.get(`${tipo}:${id}`);
    for (const v of datos) {
      const a = v.attributes || {}, rel = v.relationships || {};
      if (!['CLOSED', 'CANCELED'].includes(a.saleState) || !a.closedAt) {
        if (a.createdAt) abiertas[diaLocal(a.createdAt)] = (abiertas[diaLocal(a.createdAt)] || 0) + 1;
        continue;
      }
      // En Fudo, `price` es el total del RENGLÓN (2 × $20.000 viene como price 40000), no el unitario:
      // verificado contra la cuenta real (la suma de los renglones da el total de la venta).
      const items = ids(rel.items).map(id => de('Item', id)).filter(Boolean).map(it => {
        const ia = it.attributes || {}, pid = ids((it.relationships || {}).product)[0];
        const prod = pid && de('Product', pid), q = Number(ia.quantity ?? 0);
        return { codigo: pid ? String(pid) : 'sin-producto', nombre: prod ? (prod.attributes || {}).name || `Producto ${pid}` : 'Sin producto',
                 cantidad: String(ia.quantity ?? 0), importe: ia.price != null ? String(ia.price) : null,
                 precio: ia.price != null && q ? String(Math.round(Number(ia.price) / q * 10000) / 10000) : null, anulado: !!ia.canceled };
      }).filter(x => Number(x.cantidad) > 0);
      const pagos = ids(rel.payments).map(id => de('Payment', id)).filter(Boolean).map(p => {
        const pa = p.attributes || {}, mid = ids((p.relationships || {}).paymentMethod)[0];
        const m = mid && de('PaymentMethod', mid);
        return { codigo: mid ? String(mid) : 'sin-medio', nombre: m ? (m.attributes || {}).name || `Medio ${mid}` : 'Sin medio',
                 importe: String(pa.amount ?? 0), anulado: !!pa.canceled };
      });
      if (!items.length && !pagos.length) continue;
      const mesa = ids(rel.table)[0], mozo = ids(rel.waiter)[0];
      tickets.push({
        id: String(v.id), cerrado_en: a.closedAt, abierto_en: a.createdAt || null, estado: a.saleState === 'CANCELED' ? 'anulado' : 'cerrado',
        total: a.total != null ? String(a.total) : null, tipo: a.saleType === 'TAKEAWAY' ? 'para llevar' : 'salón',
        mesa: mesa ? ((de('Table', mesa) || {}).attributes || {}).number ?? mesa : null,
        mozo: mozo ? ((de('User', mozo) || {}).attributes || {}).name ?? null : null,
        personas: a.people ?? null, items, pagos,
      });
    }
    if (datos.length < TAMANO) return { tickets, abiertas };
  }
  throw new ErrorFudo(`El rango tiene más de ${MAX_PAGINAS * TAMANO} ventas: importalo en partes.`);
}

module.exports = { ventas, olvidarToken, ErrorFudo };
