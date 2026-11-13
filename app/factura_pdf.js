// Lectura de una factura electrónica de ARCA (el PDF del formato oficial: "Comprobante Autorizado", CAE) a partir de su
// texto. El navegador saca el texto del PDF con pdf.js, renglón por renglón (los fragmentos de una misma altura, de
// izquierda a derecha), y lo manda acá. Primera fuente: las facturas semanales de PedidosYa (Delivery Hero E-Commerce y
// Pagos Ya). Sólo lee: quien la usa controla que los importes cierren antes de guardar nada.
const { ErrorUsuario } = require('./util');

// Código de comprobante de ARCA → tipo y letra.
const CODIGOS = {
  1: ['factura', 'A'], 2: ['nota_debito', 'A'], 3: ['nota_credito', 'A'],
  6: ['factura', 'B'], 7: ['nota_debito', 'B'], 8: ['nota_credito', 'B'],
  11: ['factura', 'C'], 12: ['nota_debito', 'C'], 13: ['nota_credito', 'C'],
  51: ['factura', 'M'], 52: ['nota_debito', 'M'], 53: ['nota_credito', 'M'],
};

const NUM = '-?\\d+(?:\\.\\d+)?';
// Los importes del formato oficial van con punto decimal y sin separador de miles ("138880.07").
const imp = s => { const v = String(s).trim(); if (!/^-?\d+(\.\d+)?$/.test(v)) return null; const [e, d = ''] = v.split('.'); return e + '.' + (d + '00').slice(0, 2); };
const fechaIso = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s).trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const sinAcentos = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

// Las páginas que valen: el formato oficial repite el comprobante como ORIGINAL, DUPLICADO y TRIPLICADO. Se toman las del
// ORIGINAL (puede tener más de una); si ninguna lo dice, todas.
function paginasOriginal(paginas) {
  const orig = paginas.filter(p => /^\s*ORIGINAL\b/m.test(p) || /\bORIGINAL\b/.test(p.slice(0, 200)));
  return orig.length ? orig : paginas;
}

function leerFactura(paginas) {
  if (!Array.isArray(paginas) || !paginas.length || paginas.some(p => typeof p !== 'string')) throw new ErrorUsuario('No llegó el texto del PDF.');
  if (paginas.reduce((n, p) => n + p.length, 0) > 200000) throw new ErrorUsuario('El PDF es demasiado largo para una factura.');
  const texto = paginasOriginal(paginas).join('\n');
  const lineas = texto.split(/\r?\n/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const plano = lineas.join(' \n ');
  const busca = (re, i = 1) => { const m = re.exec(plano); return m ? m[i].trim() : null; };

  if (!/CAE/i.test(plano)) throw new ErrorUsuario('No parece una factura electrónica (no tiene CAE).');
  const cod = Number(busca(/COD\.?\s*0*(\d{1,3})/i));
  const tl = CODIGOS[cod];
  if (!tl) throw new ErrorUsuario(`No reconozco el tipo de comprobante (código ${cod || 'sin leer'}).`);
  const [tipo, letra] = tl;

  // Los CUIT en el orden en que aparecen: primero el emisor (cabecera), después el receptor. El receptor es el que viene en
  // el renglón de "Apellido y Nombre / Razón Social" o después; si no, el segundo.
  const cuits = [...plano.matchAll(/CUIT\s*:?\s*(\d{2}-?\d{8}-?\d)/gi)].map(m => m[1].replace(/-/g, ''));
  const unicos = [...new Set(cuits)];
  if (unicos.length < 2) throw new ErrorUsuario('No pude leer el CUIT del emisor y del receptor.');
  const emisorRazon = busca(/(?<!Nombre\s?\/\s?)Raz[oó]n Social\s*:\s*(.+?)(?=\s+COD\.|\s+Fecha|\s*\n|$)/i);
  const receptorRazon = busca(/Apellido y Nombre\s*\/\s*Raz[oó]n Social\s*:\s*(.+?)(?=\s*\n|$)/i);

  const pv = busca(/Punto de Venta\s*:?\s*(\d{1,5})/i), nro = busca(/Comp\.?\s*Nro\.?\s*:?\s*(\d{1,8})/i);
  const fecha = fechaIso(busca(/Fecha de Emisi[oó]n\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) || '');
  const cae = busca(/CAE\s*N[°º]?\s*:?\s*(\d{14})/i);
  const vence = fechaIso(busca(/Fecha de Vto\.? para el pago\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) || '');
  const desde = fechaIso(busca(/Per[ií]odo Facturado Desde\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) || '');
  const hasta = fechaIso(busca(/Hasta\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) || '');
  if (!pv || !nro || !fecha) throw new ErrorUsuario('No pude leer el punto de venta, el número o la fecha de la factura.');

  // Renglones: descripción, cantidad, unidad, precio, descuento, subtotal, alícuota, subtotal con IVA.
  const reItem = new RegExp(`^(.+?) (\\d+(?:\\.\\d+)?) ([A-Za-zÁÉÍÓÚáéíóúñ.]+) (${NUM}) (${NUM}) (${NUM}) (\\d+(?:\\.\\d+)?) (${NUM})$`);
  // Una descripción larga ocupa dos renglones en el PDF ("CARGOS POR RECLAMOS DE LOS USUARIOS (Di Ciucio Pasticceria E" /
  // "Caffe)") y los números quedan a media altura: llegan como tres líneas, la del medio sólo con números (factura de SORELLE
  // del 02/11/2026). La descripción se arma con la línea de arriba y, si dejó un paréntesis abierto, la de abajo.
  const reCola = new RegExp(`^(\\d+(?:\\.\\d+)?) ([A-Za-zÁÉÍÓÚáéíóúñ.]+) (${NUM}) (${NUM}) (${NUM}) (\\d+(?:\\.\\d+)?) (${NUM})$`);
  const abierto = s => (s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length;
  const suelta = s => s && !reItem.test(s) && !reCola.test(s) && !/\d+\.\d{2}/.test(s) && !/^(Producto|Comercial|IVA Subtotal|Otros Tributos)/i.test(s);
  const items = [];
  const usadas = new Set();
  lineas.forEach((l, i) => {
    let m = reItem.exec(l), desc, c;
    if (m) { desc = m[1]; c = m.slice(2); }
    else if ((m = reCola.exec(l)) && suelta(lineas[i - 1]) && !usadas.has(i - 1)) { desc = lineas[i - 1]; c = m.slice(1); usadas.add(i - 1); }
    else return;
    const cierra = (desc.match(/\)/g) || []).length > (desc.match(/\(/g) || []).length;
    if (cierra && suelta(lineas[i - 1]) && abierto(lineas[i - 1]) && !usadas.has(i - 1)) { desc = lineas[i - 1] + ' ' + desc; usadas.add(i - 1); }
    if (abierto(desc) && suelta(lineas[i + 1]) && /\)/.test(lineas[i + 1])) { desc += ' ' + lineas[i + 1]; usadas.add(i + 1); }
    items.push({ descripcion: desc, cantidad: c[0], unidad: c[1], precio: imp(c[2]), descuento: imp(c[3]), subtotal: imp(c[4]),
                 alicuota: String(Number(c[5])), con_iva: imp(c[6]) });
  });
  if (!items.length) throw new ErrorUsuario('No pude leer los renglones de la factura.');

  // Otros tributos: "Perc. IIBB BSAS 4.000 5555.27 ARS". Los que están en cero no se guardan.
  const tributos = [];
  for (const l of lineas) {
    const m = /^(.+?) (\d+\.\d{3}) (\d+\.\d{2}) ?ARS$/.exec(l); if (!m) continue;
    const importe = imp(m[3]); if (Number(importe) === 0) continue;
    const d = sinAcentos(m[1]);
    const t = /\biva\b/i.test(d) ? 'percepcion_iva' : /iibb|ingresos brutos/i.test(d) ? 'percepcion_iibb' : /ganancias/i.test(d) ? 'percepcion_ganancias' : 'otro';
    const jur = t === 'percepcion_iibb' ? ((/(?:iibb|ingresos brutos)\s+(.+)$/i.exec(d) || [])[1] || null) : null;
    tributos.push({ tipo: t, descripcion: m[1], jurisdiccion: jur, alicuota: String(Number(m[2])), importe });
  }

  const total = imp(busca(/Importe Total\s*:?\s*(\d+\.\d{2})/i) || '');
  const netoGravado = imp(busca(/Importe Neto Gravado\s*:?\s*(\d+\.\d{2})/i) || '0');
  const noGravado = imp(busca(/Importe Neto No Gravado\s*:?\s*(\d+\.\d{2})/i) || '0');
  const otros = imp(busca(/Importe Otros Tributos\s*:?\s*(\d+\.\d{2})/i) || '0');
  const iva = {};
  for (const m of plano.matchAll(/IVA (27|21|10\.5|5|2\.5)\s*%\s*:?\s*(\d+\.\d{2})/gi)) if (Number(m[2])) iva[String(Number(m[1]))] = imp(m[2]);
  if (!total) throw new ErrorUsuario('No pude leer el importe total de la factura.');
  // Lo leído tiene que explicar el total: si no, quedó un renglón sin leer (13/11/2026: en la de SORELLE del 02/11 faltaban
  // $8.400 + IVA y el error saltaba recién al registrar). Se avisa acá, con los renglones con importes que no se entendieron.
  const cts = v => Math.round(Number(v) * 100);
  const leido = items.reduce((a, x) => a + cts(x.con_iva), 0) + tributos.reduce((a, x) => a + cts(x.importe), 0);
  if (Math.abs(leido - cts(total)) > 100) {
    const reTrib = /^(.+?) (\d+\.\d{3}) (\d+\.\d{2}) ?ARS$/;
    const sueltas = lineas.filter(l => /\d+\.\d{2}/.test(l) && !reItem.test(l) && !reTrib.test(l)
      && !/importe|subtotal|iva \d|cae|cuit|fecha|periodo|total/i.test(sinAcentos(l))).slice(0, 6);
    const nombre = `${String(pv).padStart(5, '0')}-${String(nro).padStart(8, '0')}`;
    throw new ErrorUsuario(`Factura ${nombre}: lo leído suma $${(leido / 100).toFixed(2)} y el total es $${total}; falta leer $${((cts(total) - leido) / 100).toFixed(2)}.`
      + (sueltas.length ? ` Renglones que no entendí: ${sueltas.map(l => `"${l}"`).join('; ')}.` : ''));
  }

  return { tipo, letra, codigo: cod, punto_venta: Number(pv), numero: Number(nro), fecha, vencimiento: vence, cae,
           periodo: { desde, hasta }, emisor: { cuit: unicos[0], razon_social: emisorRazon }, receptor: { cuit: unicos[1], razon_social: receptorRazon },
           items, tributos, neto_gravado: netoGravado, no_gravado: noGravado, iva, otros_tributos: otros, total };
}

module.exports = { leerFactura, paginasOriginal };
