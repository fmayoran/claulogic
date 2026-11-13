// Conciliación: lo que comparten la pantalla de Conciliación y el proceso de ingresos (paso de extractos y paso de
// conciliar). Dos piezas:
//   · Conc.importador: elegir el archivo, reconocer el formato (Mercado Pago: el reporte de liberaciones solo, o el
//     resumen y las liquidaciones juntos), mapear las columnas de un CSV común e importar en una cuenta. En la cuenta de un procesador concilia en
//     el mismo paso.
//   · Conc.resolver: lo que falta resolver de una cuenta, agrupado, con el pareo sugerido de cada línea y su acción.
// Usa los helpers de comun.js (el, api, pesos, fecha, centavos…), que se cargan antes.
const Conc = (() => {
  const TIPO_OP = { transferencia: 'Transferencia', qr: 'Pago QR', debito: 'Tarjeta de débito', credito: 'Tarjeta de crédito', online: 'Pago online', otro: 'Otro' };
  const conSigno = v => el('span', { className: String(v).startsWith('-') ? 'neg' : '', textContent: pesos(v) });
  const suma = arr => deCentavos(arr.reduce((s, x) => s + centavos(x.importe), 0n));
  // "Recaudacion - 1580185668 (Bruto) " -> nombre "Recaudacion" y número de operación aparte.
  function partes(concepto) {
    const m = String(concepto || '').trim().match(/^(.*?)\s*-\s*(\d{6,})(?:\s*-\s*(.*?))?\s*(\([^)]*\))?\s*$/);
    return m ? { nombre: (m[3] ? `${m[1]} · ${m[3]}` : m[1]).trim(), numero: m[2] } : { nombre: String(concepto || '').trim(), numero: '' };
  }

  // ── Formatos ──
  const ROLES = [['', 'ignorar'], ['fecha', 'Fecha'], ['concepto', 'Concepto'], ['referencia', 'Referencia'], ['importe', 'Importe (con signo)'], ['debito', 'Débito'], ['credito', 'Crédito'], ['saldo', 'Saldo']];
  function adivinar(n) {
    n = (n || '').toLowerCase();
    if (/fecha|date/.test(n)) return 'fecha';
    if (/d[eé]bito|debe|egreso/.test(n)) return 'debito';
    if (/cr[eé]dito|haber|ingreso/.test(n)) return 'credito';
    if (/importe|monto|amount/.test(n)) return 'importe';
    if (/saldo/.test(n)) return 'saldo';
    if (/concepto|descrip|detalle/.test(n)) return 'concepto';
    if (/refer|comprob|n[uú]mero|obs|objs/.test(n)) return 'referencia';
    return '';
  }
  // Mercado Pago. El resumen de cuenta (account_statement) es el extracto: trae los saldos, los pagos y las
  // transferencias, pero cada liquidación de una venta viene por el neto. El reporte de liquidaciones (settlement) tiene,
  // por operación, el bruto, la comisión y los impuestos. Subidos juntos, cada liquidación del resumen se abre en cobro
  // (bruto), comisión (IVA incluido) e impuesto a los débitos y créditos, atados por el número de operación, y las tres
  // partes suman exacto el neto. El de liquidaciones solo no se importa: el resumen trae esas mismas operaciones y se
  // duplicarían. Los importes se pasan a punto decimal ("49.216,00" -> "49216.00"; los de liquidaciones ya lo traen).
  const MP_MEDIO = { available_money: 'dinero en cuenta', account_money: 'dinero en cuenta', bank_transfer: 'transferencia', debit_card: 'débito',
    credit_card: 'crédito', prepaid_card: 'prepaga', digital_currency: 'Mercado Crédito' };
  const aPunto = v => { let s = String(v ?? '').trim(); if (/,\d{1,2}$/.test(s) || /\.\d{3}(,|$)/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); return s; };
  const esCero = v => !v || Number(v) === 0;
  function liquidacionesMP(filas) {
    const enc = (filas[0] || []).map(x => String(x).trim().toUpperCase()), col = n => enc.indexOf(n);
    if (!['SOURCE_ID', 'TRANSACTION_AMOUNT', 'FEE_AMOUNT', 'TAXES_AMOUNT'].every(n => col(n) >= 0)) return null;
    const v = (f, n) => col(n) >= 0 ? String(f[col(n)] ?? '').trim() : '', m = new Map();
    for (const f of filas.slice(1)) {
      const id = v(f, 'SOURCE_ID'); if (!id) continue;
      m.set(id, { bruto: aPunto(v(f, 'TRANSACTION_AMOUNT')), fee: aPunto(v(f, 'FEE_AMOUNT')), imp: aPunto(v(f, 'TAXES_AMOUNT')), real: aPunto(v(f, 'REAL_AMOUNT')),
        medio: MP_MEDIO[v(f, 'PAYMENT_METHOD_TYPE')] || v(f, 'PAYMENT_METHOD_TYPE'), canal: v(f, 'SUB_UNIT') });
    }
    return m;
  }
  // El resumen de cuenta importado solo (pedido de Fer, 10/11/2026): no es el extracto (eso es el reporte de liberaciones), sino a
  // quién se pagó o de quién se recibió cada operación: "Transferencia enviada Disval S.a.", con el número de operación.
  function destinatariosMP(filas) {
    const fila0 = f => String((f || [])[0] ?? '').trim().toUpperCase();
    const iMov = filas.findIndex(f => fila0(f) === 'RELEASE_DATE');
    if (iMov < 0) return null;
    const enc = filas[iMov].map(x => String(x).trim().toUpperCase()), c = (f, n) => String(f[enc.indexOf(n)] ?? '').trim();
    if (enc.indexOf('TRANSACTION_TYPE') < 0 || enc.indexOf('REFERENCE_ID') < 0) return null;
    const out = new Map();
    for (const f of filas.slice(iMov + 1)) {
      const tipo = c(f, 'TRANSACTION_TYPE').replace(/\s+/g, ' '), id = c(f, 'REFERENCE_ID');
      // Sólo lo que nombra a alguien; los impuestos de una transferencia repiten el nombre y no son el pago.
      if (!id || !tipo || /^(liquidaci|cancelaci|rendimientos|pago de impuesto)/i.test(tipo) || out.has(id)) continue;
      out.set(id, { operacion: id, destinatario: tipo });
    }
    return [...out.values()];
  }
  function resumenMP(filas, liq) {
    const fila0 = f => String((f || [])[0] ?? '').trim().toUpperCase();
    const iSaldos = filas.findIndex(f => fila0(f) === 'INITIAL_BALANCE'), iMov = filas.findIndex(f => fila0(f) === 'RELEASE_DATE');
    if (iMov < 0) return null;
    const enc = filas[iMov].map(x => String(x).trim().toUpperCase()), col = n => enc.indexOf(n), c = (f, n) => String(f[col(n)] ?? '').trim();
    const iso = v => { const m = String(v).trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : String(v).trim(); };
    const movs = filas.slice(iMov + 1).filter(f => c(f, 'RELEASE_DATE'));
    const out = []; let abiertas = 0, netas = 0;
    for (const f of movs) {
      const fecha = iso(c(f, 'RELEASE_DATE')), tipo = c(f, 'TRANSACTION_TYPE').replace(/\s+/g, ' '), id = c(f, 'REFERENCE_ID'), neto = aPunto(c(f, 'TRANSACTION_NET_AMOUNT'));
      if (esCero(neto)) continue;
      const l = liq && liq.get(id), k = x => centavos(x || '0');
      if (l && !esCero(l.bruto) && k(l.real) === k(neto) && k(l.bruto) + k(l.fee) + k(l.imp) === k(neto)) {
        out.push({ fecha, importe: l.bruto, referencia: l.canal,
          concepto: Number(l.bruto) > 0 ? `Cobro Mercado Pago ${[l.canal, l.medio].filter(Boolean).join(' · ')} - ${id}` : `${tipo} - ${id}` });
        if (!esCero(l.fee)) out.push({ fecha, importe: l.fee, referencia: '#' + id, concepto: `Comisión Mercado Pago - ${id}` });
        if (!esCero(l.imp)) out.push({ fecha, importe: l.imp, referencia: '#' + id, concepto: `Impuesto débitos y créditos Mercado Pago - ${id}` });
        abiertas++;
      } else {
        // "Pago de impuestos <destinatario>" es el impuesto a los débitos y créditos de la transferencia de al lado.
        const imp = /^pago de impuestos/i.test(tipo);
        out.push({ fecha, importe: neto, referencia: imp ? '#' + id : '', concepto: imp ? `Impuesto débitos y créditos · ${tipo} - ${id}` : `${tipo} - ${id}` });
        if (/^liquidaci/i.test(tipo)) netas++;
      }
    }
    let saldos = null;
    if (iSaldos >= 0 && filas[iSaldos + 1] && movs.length) {
      const e = filas[iSaldos].map(x => String(x).trim().toUpperCase()), v = filas[iSaldos + 1];
      saldos = { inicial: aPunto(v[e.indexOf('INITIAL_BALANCE')]), final: aPunto(v[e.indexOf('FINAL_BALANCE')]) };
      out.unshift({ fecha: iso(c(movs[0], 'RELEASE_DATE')), concepto: 'Saldo inicial', saldo: saldos.inicial, importe: '' });
      out.push({ fecha: iso(c(movs.at(-1), 'RELEASE_DATE')), concepto: 'Saldo final', saldo: saldos.final, importe: '' });
    }
    return { filas: out, movimientos: movs.length, abiertas, netas, saldos };
  }

  // Mercado Pago en un solo archivo: el reporte de liberaciones (pedido de Fer, 01/11/2026), con las columnas
  // GROSS_AMOUNT, MP_FEE_AMOUNT, FINANCING_FEE_AMOUNT, TAXES_DISAGGREGATED, TRANSACTION_APPROVAL_DATE y BALANCE_AMOUNT
  // tildadas en su configuración. Cada fila es un movimiento de la cuenta con su saldo; una venta ("payment" que entra)
  // se abre en cobro (bruto), comisión e impuestos (débitos y créditos aparte de las retenciones de Ingresos Brutos,
  // SIRTAC y SIRCUPA), que suman exacto el neto. Las reservas que MP hace y libera al instante (reserve_for_*) y un
  // cobro devuelto entero se cancelan y no se importan. Si la venta se aprobó otro día (Point con crédito libera a los
  // ~10 días), el concepto lleva "venta del AAAA-MM-DD": el servidor parea contra ese día.
  function liberacionesMP(filas) {
    const enc = (filas[0] || []).map(x => String(x).trim().toUpperCase()), col = n => enc.indexOf(n);
    if (!['RECORD_TYPE', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT'].every(n => col(n) >= 0)) return null;
    const faltan = ['GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'TAXES_AMOUNT', 'BALANCE_AMOUNT'].filter(n => col(n) < 0);
    if (faltan.length) return { faltan };
    const v = (f, n) => col(n) >= 0 ? String(f[col(n)] ?? '').trim() : '', k = x => centavos(x || '0');
    const filasMP = filas.slice(1).map(f => ({ fecha: v(f, 'DATE').slice(0, 10), id: v(f, 'SOURCE_ID'), ref: v(f, 'EXTERNAL_REFERENCE'),
      tipo: v(f, 'RECORD_TYPE'), desc: v(f, 'DESCRIPTION'), neto: deCentavos(k(v(f, 'NET_CREDIT_AMOUNT')) - k(v(f, 'NET_DEBIT_AMOUNT'))),
      bruto: v(f, 'GROSS_AMOUNT') || '0', fee: deCentavos(k(v(f, 'MP_FEE_AMOUNT')) + k(v(f, 'FINANCING_FEE_AMOUNT'))), imp: v(f, 'TAXES_AMOUNT') || '0',
      desglose: v(f, 'TAXES_DISAGGREGATED'), aprobada: v(f, 'TRANSACTION_APPROVAL_DATE').slice(0, 10), aprobada_en: v(f, 'TRANSACTION_APPROVAL_DATE'), saldo: v(f, 'BALANCE_AMOUNT'), pos: v(f, 'POS_NAME') }));
    const ini = filasMP.find(f => f.tipo === 'initial_available_balance'), movs = filasMP.filter(f => f.tipo === 'release');
    // Lo que se cancela dentro del archivo: las reservas y un cobro con su devolución, por número de operación.
    const netoDe = new Map();
    for (const f of movs) if (/^(reserve_for_|payment$|refund$)/.test(f.desc)) {
      const c = (f.desc.startsWith('reserve_for_') ? 'r|' : 'p|') + f.id;
      netoDe.set(c, (netoDe.get(c) || 0n) + k(f.neto));
    }
    const devueltos = new Set(movs.filter(f => f.desc === 'refund' && netoDe.get('p|' + f.id) === 0n).map(f => f.id));
    const cancela = f => (f.desc.startsWith('reserve_for_') && netoDe.get('r|' + f.id) === 0n) || ((f.desc === 'payment' || f.desc === 'refund') && devueltos.has(f.id));
    // Impuestos del desglose (el CSV de MP no duplica las comillas del JSON: se lee con o sin ellas).
    const impuestos = f => [...f.desglose.matchAll(/"?amount"?\s*:\s*(-?[\d.]+)\s*,\s*"?detail"?\s*:\s*"?([a-z_]+)"?\s*,\s*"?financial_entity"?\s*:\s*"?([a-z_]+)/gi)]
      .map(m => ({ importe: m[1], detalle: m[2], ente: m[3] }));
    const nombreImp = x => x.ente === 'debitos_creditos' ? 'Impuesto débitos y créditos Mercado Pago'
      : `Retención IIBB ${x.ente === 'buenos_aires' ? x.detalle.replace(/^tax_withholding_/, '').toUpperCase() : x.ente.toUpperCase()} Mercado Pago`;
    const canal = f => f.ref === 'Venta presencial' ? 'Point' : /^INSTORE/.test(f.ref) || f.pos ? 'QR' : 'online';
    const QUE = { payout: 'Transferencia a banco', asset_management: 'Rendimiento dinero en cuenta', refund: 'Devolución de cobro' };
    const out = []; let cobros = 0, cancelados = 0, sinAbrir = 0;
    for (const f of movs) {
      if (esCero(f.neto)) continue;
      if (cancela(f)) { cancelados++; continue; }
      const reserva = /^POTS/.test(f.ref), meli = /^MELIPAYMENTS/.test(f.ref);
      const que = reserva ? (f.neto.startsWith('-') ? 'Reserva de dinero (apartado)' : 'Retiro de reserva (apartado)')
        : meli ? 'Cobro de deuda Mercado Libre' : f.desc === 'payment' ? (f.neto.startsWith('-') ? 'Pago desde Mercado Pago' : 'Cobro Mercado Pago') : QUE[f.desc] || f.desc;
      const venta = f.desc === 'payment' && !f.neto.startsWith('-') && !reserva;
      const imps = impuestos(f), sumaImps = imps.reduce((s, x) => s + k(x.importe), 0n);
      const partes = (venta ? [k(f.fee)] : []).concat(sumaImps === k(f.imp) ? imps.map(x => k(x.importe)) : [k(f.imp)]);
      // Se abre sólo si bruto + comisión + impuestos da exacto el neto; si no, va por el neto.
      if (!esCero(f.bruto) && k(f.bruto) + partes.reduce((s, x) => s + x, 0n) === k(f.neto) && !reserva) {
        const det = venta ? [canal(f), f.aprobada && f.aprobada !== f.fecha ? `venta del ${f.aprobada}` : ''].filter(Boolean).join(' · ') : f.ref && !/^\d+$/.test(f.ref) ? '' : f.ref;
        out.push({ fecha: f.fecha, importe: f.bruto, referencia: venta ? canal(f) : '', concepto: `${que}${det ? ' ' + det : ''} - ${f.id}`, ...(venta && f.aprobada_en ? { aprobada_en: f.aprobada_en } : {}) });
        if (venta && !esCero(f.fee)) out.push({ fecha: f.fecha, importe: f.fee, referencia: '#' + f.id, concepto: `Comisión Mercado Pago - ${f.id}` });
        if (sumaImps === k(f.imp)) for (const x of imps) { if (!esCero(x.importe)) out.push({ fecha: f.fecha, importe: x.importe, referencia: '#' + f.id, concepto: `${nombreImp(x)} - ${f.id}` }); }
        else if (!esCero(f.imp)) out.push({ fecha: f.fecha, importe: f.imp, referencia: '#' + f.id, concepto: `Impuestos Mercado Pago - ${f.id}` });
        if (venta) cobros++;
      } else {
        out.push({ fecha: f.fecha, importe: f.neto, referencia: '', concepto: `${que} - ${f.id}`, ...(venta && f.aprobada_en ? { aprobada_en: f.aprobada_en } : {}) });
        if (venta) sinAbrir++;
      }
    }
    // Un período sin movimientos (10/11/2026: MERCADO PAGO CF el 09/11) se importa igual: el saldo final es el inicial y el
    // extracto deja cubiertos esos días. El último día es la fecha más nueva del archivo (sin movimientos, la del saldo inicial).
    const ult = [...movs].reverse().find(f => f.saldo !== '')
      || (ini && !movs.length ? { fecha: filasMP.map(f => f.fecha).filter(Boolean).sort().at(-1), saldo: ini.saldo } : null);
    if (ini && ult) {
      out.unshift({ fecha: ini.fecha, concepto: 'Saldo inicial', saldo: ini.saldo, importe: '' });
      out.push({ fecha: ult.fecha, concepto: 'Saldo final', saldo: ult.saldo, importe: '' });
    }
    return { filas: out, movimientos: movs.length, cobros, cancelados, sinAbrir, saldos: ini && ult ? { inicial: ini.saldo, final: ult.saldo } : null };
  }

  // Conciliación automática de la cuenta de un procesador; devuelve el resultado en una frase.
  async function automatica(cuentaId) {
    const d = await api('fin/conciliacion/automatica', { method: 'POST', body: { cuenta_id: cuentaId } });
    const costos = Object.values(d.gastos).reduce((s, v) => s + centavos(v), 0n);
    const p = [];
    if (d.acreditadas || costos) p.push(`Se conciliaron ${d.acreditadas} cobro(s) por ${pesos(d.acreditado)}` + (costos ? ` y ${pesos(deCentavos(costos))} de cargos e impuestos` : '') + '.');
    if (d.lotes_liquidados) p.push(`${d.lotes_liquidados} lote(s) nuevos esperando el depósito.`);
    if (d.lotes_confirmados) p.push(`${d.lotes_confirmados} lote(s) confirmados con el extracto.`);
    if (d.reglas) p.push(`${d.reglas} línea(s) clasificadas por las reglas.`);
    return p.length || d.compensadas ? p.join(' ') : 'No había nada nuevo para conciliar.';
  }

  // ── Rubros del estado de resultados ──
  // Al registrar una línea se elige su rubro; "+ Nuevo rubro…" al final de la lista. Ventas y costo de mercadería
  // los arma el sistema y no se ofrecen.
  const LINEA = { cmv: 'Costo de mercadería', personal: 'Personal', cobro: 'Costos de cobro', locacion: 'Locación', operativos: 'Gastos operativos',
    comercializacion: 'Comercialización', administracion: 'Administración', impuestos: 'Impuestos', bancarios: 'Gastos bancarios',
    inversiones: 'Inversiones', diferencias: 'Diferencias', otros: 'Otros ingresos y gastos', fuera: 'No es resultado' };
  let rubrosCache = null;
  async function rubros(recargar) {
    if (!rubrosCache || recargar) rubrosCache = (await api('fin/rubros')).rubros.filter(r => r.activo && LINEA[r.linea] && r.clave !== 'cmv');
    return rubrosCache;
  }
  function nuevoRubro(lineaSugerida) {
    return new Promise(listo => {
      const nombre = el('input', { required: true }), linea = el('select');
      opciones(linea, Object.entries(LINEA), lineaSugerida);
      const msgR = el('span', { className: 'msg' });
      const dlg = el('dialog', {}, el('form', { method: 'dialog' }, el('h2', { textContent: 'Nuevo rubro' }),
        el('div', { className: 'fila' }, el('label', {}, 'Nombre *', nombre)), el('div', { className: 'fila' }, el('label', {}, 'Línea del estado de resultados', linea)),
        el('div', { className: 'acciones' }, el('button', { type: 'submit', className: 'prim', textContent: 'Crear' }),
          el('button', { type: 'button', textContent: 'Cancelar', onclick: () => { dlg.close(); } }), msgR)));
      dlg.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        try {
          const { id } = await api('fin/rubros', { method: 'POST', body: { nombre: nombre.value, linea: linea.value } });
          await rubros(true); listo([id, nombre.value.trim()]); dlg.remove();
        } catch (err) { msg(err.message, 'mal', msgR); }
      };
      dlg.addEventListener('close', () => { listo(null); dlg.remove(); });
      document.body.append(dlg); dlg.showModal(); nombre.focus();
    });
  }
  async function selectRubro(sel, valor, sale) {
    const rs = await rubros();
    opcionesConAlta(sel, rs.map(r => [r.id, `${r.nombre} · ${LINEA[r.linea]}`]), valor, 'Elegir rubro…',
      { texto: '+ Nuevo rubro…', alta: () => nuevoRubro(sale ? 'operativos' : 'otros') });
  }
  // El texto de la regla que se propone: el concepto sin números (los de operación cambian en cada línea).
  const patronDe = t => String(t || '').replace(/[#nº°]*\s*\d[\d./-]*/gi, ' ').replace(/\s+/g, ' ').replace(/[\s·:,#–-]+$/, '').trim();

  // Formatos de banco conocidos: se reconocen por el encabezado y se importan directo, sin mostrar el mapeo de columnas.
  const sinAcento = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const FORMATOS = [
    { nombre: 'estado de cuenta de Brubank', decimal: ',',
      columnas: { fecha: 'fecha', referencia: 'referencia', concepto: 'descripcion', credito: 'creditos', debito: 'debitos', saldo: 'saldo' },
      tambien: ['moneda', 'cuenta'] },
  ];
  function formatoDe(filas) {
    const enc = (filas[0] || []).map(sinAcento);
    for (const f of FORMATOS) {
      if (![...Object.values(f.columnas), ...f.tambien].every(c => enc.includes(c))) continue;
      return { nombre: f.nombre, decimal: f.decimal, mapa: Object.fromEntries(Object.entries(f.columnas).map(([rol, c]) => [rol, enc.indexOf(c)])) };
    }
    return null;
  }

  // ── Importador ──
  // opc: cuenta() -> id de la cuenta; procesador() -> si la cuenta es la de un procesador (concilia al importar);
  // ayuda: texto sobre qué archivo va; listo(texto): al terminar.
  function importador(opc) {
    let csv = null;
    const archivo = el('input', { type: 'file', accept: '.csv,.txt,text/csv', multiple: true, hidden: true });
    const titulo = el('h2', { textContent: 'Importar extracto' });
    const capCsv = el('p', { className: 'cap', textContent: 'Revisá qué es cada columna: hace falta la fecha y un importe con signo, o débito y crédito por separado. Con la columna de saldo se '
      + 'controla contra el saldo del extracto (y, si la cuenta no tiene movimientos, el saldo inicial queda como apertura).' });
    const formato = el('p', { className: 'ayuda', hidden: true });
    const decimal = el('select', {}); opciones(decimal, [[',', 'coma (1.234,56)'], ['.', 'punto (1,234.56)']]);
    const encab = el('input', { type: 'checkbox', checked: true });
    const opcCsv = el('div', { className: 'barra' }, el('label', {}, 'Decimales', decimal), el('label', { className: 'check' }, encab, ' La primera fila es el encabezado'));
    const mHead = el('thead'), mBody = el('tbody');
    const mapaWrap = el('div', { className: 'tabla-wrap' }, el('table', { className: 'datos mapa' }, mHead, mBody));
    const ok = el('button', { type: 'button', className: 'prim', textContent: 'Importar' });
    const no = el('button', { type: 'button', textContent: 'Cancelar' });
    const aviso = el('span', { className: 'msg' });
    const caja = el('section', { className: 'card importador', hidden: true }, el('div', { className: 'card-cab' }, titulo), capCsv, formato, opcCsv, mapaWrap,
      el('div', { className: 'acciones' }, ok, no, aviso));
    const cerrar = () => { csv = null; archivo.value = ''; caja.hidden = true; ok.disabled = false; aviso.textContent = ''; aviso.className = 'msg'; };
    const avisar = (t, tipo) => { aviso.textContent = t; aviso.className = 'msg ' + (tipo || ''); };
    function pintarMapa() {
      const enc = encab.checked, filas = csv.filas, cols = Math.max(...filas.map(f => f.length));
      titulo.textContent = `Importar ${csv.nombre} · ${filas.length - (enc ? 1 : 0)} filas`;
      mHead.replaceChildren(el('tr', {}, ...Array.from({ length: cols }, (_, i) => {
        const s = el('select'); opciones(s, ROLES, enc ? adivinar(filas[0][i]) : ''); s.dataset.col = i;
        return el('th', {}, el('div', { className: 'mut', textContent: enc ? filas[0][i] || '' : `Columna ${i + 1}` }), s);
      })));
      mBody.replaceChildren(...filas.slice(enc ? 1 : 0, (enc ? 1 : 0) + 4).map(f => el('tr', {}, ...Array.from({ length: cols }, (_, i) => td(f[i] || '')))));
    }
    archivo.onchange = async () => {
      const archivos = [...archivo.files]; if (!archivos.length) return;
      const leidos = await Promise.all(archivos.map(async a => ({ nombre: a.name, filas: parsearCSV(await leerTexto(a)) })));
      const liqA = leidos.find(x => liquidacionesMP(x.filas)), resA = leidos.find(x => x !== liqA && resumenMP(x.filas, null));
      const libA = leidos.find(x => liberacionesMP(x.filas));
      let txt = '';
      if (libA) {
        // El reporte de liberaciones solo alcanza: trae saldos, movimientos y el desglose de cada cobro.
        const lib = liberacionesMP(libA.filas);
        if (lib.faltan) {
          csv = { nombre: libA.nombre, mp: { incompleto: true } };
          txt = `Es el reporte de liberaciones de Mercado Pago, pero le faltan columnas: ${lib.faltan.join(', ')}. En Mercado Pago, en la configuración del `
            + 'reporte de liberaciones, tildá GROSS_AMOUNT, MP_FEE_AMOUNT, FINANCING_FEE_AMOUNT, TAXES_AMOUNT, TAXES_DISAGGREGATED, TRANSACTION_APPROVAL_DATE '
            + 'y BALANCE_AMOUNT, y generalo de nuevo.';
        } else {
          csv = { nombre: libA.nombre, mp: lib };
          txt = `Formato reconocido: reporte de liberaciones de Mercado Pago, ${lib.movimientos} movimiento(s)`
            + (lib.saldos ? `, saldo inicial ${pesos(lib.saldos.inicial)} y final ${pesos(lib.saldos.final)}` : '') + `. ${lib.cobros} cobro(s) se abren en bruto, comisión e impuestos.`
            + (lib.cancelados ? ` ${lib.cancelados} fila(s) se cancelan entre sí (reservas de Mercado Pago y cobros devueltos) y no se importan.` : '')
            + (lib.sinAbrir ? ` ${lib.sinAbrir} cobro(s) no cierran con su desglose y quedan por el neto.` : '');
        }
      } else if (resA && !liqA) {
        // Solo, el resumen de cuenta completa a quién se pagó en las líneas ya importadas (el extracto es el de liberaciones).
        const ds = destinatariosMP(resA.filas) || [];
        csv = { nombre: resA.nombre, dest: ds, mp: { dest: true } };
        txt = `Es el resumen de cuenta de Mercado Pago: no se importan líneas nuevas (el extracto es el reporte de liberaciones). `
          + `Se completa a quién se pagó o de quién se recibió en las líneas que ya están, por el número de operación: ${ds.length} operación(es) con nombre.`;
      } else if (liqA || resA) {
        const liq = liqA && liquidacionesMP(liqA.filas), res = resA && resumenMP(resA.filas, liq);
        // Hacen falta los dos: sin las liquidaciones, cada cobro queda por el neto y no se parea con las ventas; sin el
        // resumen, faltan los saldos, los pagos y las transferencias (y se duplicaría al llegar el resumen).
        const faltan = !res || !liq;
        csv = { nombre: [resA, liqA].filter(Boolean).map(x => x.nombre).join(' + '), mp: faltan ? { incompleto: true } : res };
        if (faltan) txt = `${res ? 'Es el resumen de cuenta' : 'Es el reporte de liquidaciones'} de Mercado Pago. Para conciliar hacen falta los dos juntos: `
          + 'elegí a la vez el resumen de cuenta (account_statement) y el reporte de liquidaciones (settlement). El resumen trae los saldos, los pagos y '
          + 'las transferencias; las liquidaciones, el bruto, la comisión y el impuesto de cada cobro.';
        else txt = `Formato reconocido: resumen de cuenta de Mercado Pago, ${res.movimientos} movimiento(s)`
          + (res.saldos ? `, saldo inicial ${pesos(res.saldos.inicial)} y final ${pesos(res.saldos.final)}` : '') + `. ${res.abiertas} cobro(s) se abren en bruto, comisión e impuesto.`
          + (res.netas ? ` ${res.netas} liquidación(es) no están en el reporte de liquidaciones y quedan por el neto.` : '');
      } else if (leidos.length === 1 && formatoDe(leidos[0].filas)) {
        // Un formato conocido se importa y se concilia en el acto.
        const fmt = formatoDe(leidos[0].filas);
        csv = { ...leidos[0], fmt };
        titulo.textContent = `Importar ${csv.nombre}`;
        formato.hidden = false; formato.textContent = `Formato reconocido: ${fmt.nombre}, ${csv.filas.length - 1} fila(s).`;
        opcCsv.hidden = mapaWrap.hidden = capCsv.hidden = true;
        ok.textContent = 'Importar y conciliar';
        caja.hidden = false; caja.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return importar();
      } else csv = leidos[0];
      formato.hidden = !csv.mp; formato.textContent = txt;
      ok.textContent = csv.dest ? 'Completar a quién se pagó' : 'Importar y conciliar';
      opcCsv.hidden = mapaWrap.hidden = capCsv.hidden = !!csv.mp;
      ok.disabled = !!(csv.mp && csv.mp.incompleto);
      if (csv.mp) titulo.textContent = `Importar ${csv.nombre}`; else pintarMapa();
      caja.hidden = false; caja.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    encab.onchange = () => csv && pintarMapa();
    no.onclick = cerrar;
    async function importar() {
      if (csv.dest) {
        ok.disabled = true; avisar('Completando…');
        try {
          const d = await api('fin/extractos/destinatarios', { method: 'POST', body: { cuenta_id: opc.cuenta(), filas: csv.dest } });
          const t = `Resumen de cuenta: ${d.completadas} línea(s) tomaron a quién se pagó o de quién se recibió` + (d.reglas ? `; las reglas clasificaron ${d.reglas}` : '') + '.';
          cerrar(); opc.listo(t, 'ok');
        } catch (e) { avisar(e.message, 'mal'); ok.disabled = false; }
        return;
      }
      let filas, dec = decimal.value;
      if (csv.mp) { filas = csv.mp.filas; dec = '.'; }
      else if (csv.fmt) {
        dec = csv.fmt.decimal;
        filas = csv.filas.slice(1).map(f => Object.fromEntries(Object.entries(csv.fmt.mapa).map(([k, i]) => [k, f[i] ?? ''])));
      } else {
        const mapa = {}; mHead.querySelectorAll('select').forEach(s => { if (s.value) mapa[s.value] = +s.dataset.col; });
        if (mapa.fecha === undefined || (mapa.importe === undefined && mapa.debito === undefined && mapa.credito === undefined))
          return avisar('Falta indicar la fecha y el importe (o débito y crédito).', 'mal');
        filas = csv.filas.slice(encab.checked ? 1 : 0).map(f => Object.fromEntries(Object.entries(mapa).map(([k, i]) => [k, f[i] ?? ''])));
      }
      ok.disabled = true; avisar('Importando…');
      try {
        const d = await api('fin/extractos', { method: 'POST', body: { cuenta_id: opc.cuenta(), archivo: csv.nombre, decimal: dec, filas, formato: csv.mp ? 'mercadopago' : null } });
        let t = `Importado: ${d.nuevas} línea(s) nueva(s)` + (d.repetidas ? `, ${d.repetidas} ya estaban` : '') + (d.apertura ? `; saldo de apertura ${pesos(d.apertura)}` : '') + '.';
        cerrar();
        // En la cuenta de un procesador se concilia en el mismo paso.
        // Se concilia en el mismo paso: los cobros de un procesador y, en cualquier cuenta, las reglas de clasificación.
        opc.listo(t + ' Conciliando…', ''); t += ' ' + await automatica(opc.cuenta());
        opc.listo(t, 'ok');
      } catch (e) { avisar(e.message, 'mal'); ok.disabled = false; }
    }
    ok.onclick = importar;
    return { el: el('div', {}, archivo, caja), abrir: () => archivo.click() };
  }

  // ── Lo que falta resolver de una cuenta ──
  // d: respuesta de /fin/conciliacion; ctx: recargar() (después de cada acción) y aviso(texto, tipo).
  function resolver(d, ctx) {
    const conciliar = async body => {
      try {
        const r = await api('fin/conciliacion', { method: 'POST', body });
        ctx.aviso(r.regla ? `Conciliado. Regla creada${r.regla.aplicadas ? `: clasificó y concilió ${r.regla.aplicadas} línea(s) más` : ''}.` : 'Conciliado.', 'ok');
        await ctx.recargar();
      } catch (e) { alert(e.message); }
    };
    const sugDe = id => (d.sugerencias || []).find(x => x.lineas.includes(id));
    // Pareo sugerido para una línea (de una venta pagada en partes, con una diferencia chica, o un lote): se confirma acá.
    function cajaSugerencia(l, x) {
      const p = x.pago || {}, venta = `la venta #${p.id_externo} del ${fecha(p.dia)} (${TIPO_OP[p.tipo_operacion] || p.tipo_operacion}, ${pesos(p.importe)})`;
      const ok = el('button', { type: 'button', className: 'prim', textContent: 'Confirmar' });
      const confirmar = async body => {
        ok.disabled = true;
        try { await api('fin/conciliacion/acreditar', { method: 'POST', body: { ticket_pago_id: p.id, linea_ids: x.lineas, ...body } }); ctx.aviso(`Acreditada la venta #${p.id_externo}.`, 'ok'); await ctx.recargar(); }
        catch (e) { alert(e.message); ok.disabled = false; }
      };
      if (x.tipo === 'lote_cobro' || x.tipo === 'lote_diferencia') {
        const lote = x.lotes[0], deLote = `el lote del ${fecha(lote.fecha)} (${lote.pagos} cobro(s), ${pesos(lote.neto)})`;
        const confirmarLote = async body => {
          ok.disabled = true;
          try { await api('fin/conciliacion/lote', { method: 'POST', body: { linea_id: l.id, lote_ids: x.lotes.map(y => y.id), ...body } }); ctx.aviso('Depósito confirmado.', 'ok'); await ctx.recargar(); }
          catch (e) { alert(e.message); ok.disabled = false; }
        };
        if (x.tipo === 'lote_cobro') {
          const c = x.pago, pct = num((100 - Number(x.neto_pago) / Number(c.importe) * 100).toFixed(2));
          ok.onclick = () => confirmarLote({ ticket_pago_id: c.id });
          return el('div', { className: 'sug' }, el('span', { className: 't' }, el('b', { textContent: 'Sugerencia: ' }),
            `es ${deLote} más el cobro de la venta #${c.id_externo} del ${fecha(c.dia)} (${c.medio}, ${pesos(c.importe)}), que el procesador no informó: neto ${pesos(x.neto_pago)}, costo ${pct}%.`), ok);
        }
        const mas = !x.diferencia.startsWith('-'), motivoL = el('input', { placeholder: 'Motivo de la diferencia', 'aria-label': 'Motivo de la diferencia' });
        ok.onclick = () => motivoL.value.trim() ? confirmarLote({ motivo: motivoL.value.trim() }) : (motivoL.focus(), ctx.aviso('Indicá el motivo de la diferencia.', 'mal'));
        return el('div', { className: 'sug' }, el('span', { className: 't' }, el('b', { textContent: 'Sugerencia: ' }),
          `es ${deLote}; el depósito tiene ${pesos(x.diferencia.replace('-', ''))} ${mas ? 'más' : 'menos'} (por ejemplo, cobros de ventas que no se importaron).`), motivoL, ok);
      }
      if (x.tipo === 'otro_procesador') {
        ok.onclick = () => confirmar({ otro_procesador: true });
        return el('div', { className: 'sug' }, el('span', { className: 't' }, el('b', { textContent: 'Sugerencia: ' }),
          `es la venta #${p.id_externo} del ${fecha(p.dia)}, que en el sistema de venta quedó cobrada con ${p.procesador_cargado} (${pesos(p.importe)}); `
          + 'ahí mismo se anuló un pago con este procesador por el mismo importe. La plata entró acá: se acredita acá y sale de lo que esperaba el otro.'), ok);
      }
      if (x.tipo === 'otro_por_fecha') {
        ok.onclick = () => confirmar({ otro_procesador: 'fecha' });
        return el('div', { className: 'sug' }, el('span', { className: 't' }, el('b', { textContent: 'Sugerencia: ' }),
          p.propio
            ? `es la venta #${p.id_externo} del ${fecha(p.dia)} de ${p.punto_venta}, cobrada con ${p.procesador_cargado} (${pesos(p.importe)}, mismo importe), `
              + 'que llegó al banco más tarde de lo normal. Se acredita con esta línea.'
            : `es la venta #${p.id_externo} del ${fecha(p.dia)} de ${p.punto_venta}, que en el sistema de venta quedó cobrada con ${p.procesador_cargado} `
              + `(${pesos(p.importe)}, mismo importe y fecha). La plata entró acá: se acredita acá y sale de lo que esperaba ${p.procesador_cargado}.`), ok);
      }
      if (x.tipo === 'en_efectivo') {
        ok.onclick = () => confirmar({ en_efectivo: true });
        return el('div', { className: 'sug' }, el('span', { className: 't' }, el('b', { textContent: 'Sugerencia: ' }),
          `es la venta #${p.id_externo} del ${fecha(p.dia)} de ${p.punto_venta}, que en el sistema de venta quedó cobrada en efectivo (${pesos(p.importe)}). `
          + 'La plata entró acá: se acredita acá y sale del efectivo a rendir del punto de venta.'), ok);
      }
      if (x.tipo === 'division') {
        const otras = x.lineas.filter(id => id !== l.id).map(id => d.lineas.find(y => y.id === id)).filter(Boolean);
        ok.onclick = () => confirmar({});
        return el('div', { className: 'sug' }, el('span', { className: 't' }, el('b', { textContent: 'Sugerencia: ' }),
          `es ${venta}, pagada en ${x.lineas.length} partes: esta y ` + otras.map(o => `${pesos(o.importe)} del ${fecha(o.fecha)}`).join(' y ') + '.'), ok);
      }
      const mas = !x.diferencia.startsWith('-'), dif = pesos(x.diferencia.replace('-', ''));
      const motivo = el('input', { placeholder: 'Motivo de la diferencia', 'aria-label': 'Motivo de la diferencia' });
      ok.onclick = () => motivo.value.trim() ? confirmar({ motivo: motivo.value.trim() }) : (motivo.focus(), ctx.aviso('Indicá el motivo de la diferencia.', 'mal'));
      return el('div', { className: 'sug' }, el('span', { className: 't' }, el('b', { textContent: 'Sugerencia: ' }),
        `es ${venta}; entró ${dif} ${mas ? 'más' : 'menos'}.`), motivo, ok);
    }
    function filaLinea(l) {
      const pp = partes(l.concepto), acc = el('div', { className: 'acc' });
      const x = sugDe(l.id);
      // De una venta en partes, la sugerencia va en la primera línea; las demás lo dicen.
      const sug = !x ? '' : x.tipo === 'division' && x.lineas[0] !== l.id
        ? el('div', { className: 'parte', textContent: `Es parte de la venta #${x.pago.id_externo} (la sugerencia está en la primera parte).` }) : cajaSugerencia(l, x);
      const k = l.candidatos[0];
      if (k) acc.append(el('button', { type: 'button', className: 'prim', textContent: k.tipo === 'cheque' ? 'Es el débito del ' + k.descripcion : `Conciliar con: ${k.descripcion} (${fecha(k.fecha)})`,
        onclick: () => conciliar({ linea_id: l.id, [k.tipo === 'cheque' ? 'cheque_id' : 'movimiento_id']: k.id }) }));
      const registrar = el('button', { type: 'button', textContent: k ? 'Otro: registrar movimiento' : 'Registrar movimiento' });
      let base = [];
      const restaurar = () => acc.replaceChildren(...base);
      // Registrar: qué es, su rubro (estado de resultados) y, si se tilda, la regla para que las próximas iguales se
      // clasifiquen y concilien solas.
      registrar.onclick = async () => {
        const sale = l.importe.startsWith('-');
        const inp = el('input', { placeholder: sale ? 'Qué es: gasto bancario, impuesto…' : 'Qué es: aporte, reintegro…', value: pp.nombre, 'aria-label': 'Concepto' });
        const rub = el('select', { 'aria-label': 'Rubro' });
        try { await selectRubro(rub, null, sale); } catch (e) { return alert(e.message); }
        const patron = el('input', { value: patronDe(`${l.concepto}`), 'aria-label': 'Texto de la regla' });
        const conRegla = el('input', { type: 'checkbox' });
        const regla = el('label', { className: 'regla' }, conRegla, el('span', { textContent: 'Aplicar a las próximas que digan' }), patron);
        const ok = el('button', { type: 'button', className: 'prim', textContent: 'Registrar' });
        ok.onclick = () => {
          if (!inp.value.trim()) return inp.focus();
          if (!rub.value) return (rub.focus(), ctx.aviso('Elegí el rubro.', 'mal'));
          if (conRegla.checked && patron.value.trim().length < 3) return (patron.focus(), ctx.aviso('El texto de la regla tiene que tener al menos 3 letras.', 'mal'));
          conciliar({ linea_id: l.id, crear: { concepto: inp.value.trim(), rubro_id: rub.value, regla: conRegla.checked ? patron.value.trim() : null } });
        };
        acc.replaceChildren(inp, rub, regla, ok, el('button', { type: 'button', textContent: 'Cancelar', onclick: restaurar }));
        inp.focus(); inp.select();
      };
      acc.append(registrar);
      // Pareo manual (pedido de Fer, 08/11/2026): un ingreso de la cuenta de un procesador que es el cobro de una venta, con
      // una diferencia que la sugerencia no cubre o una fecha lejana. Se elige el cobro; si no coincide, con motivo.
      const cobros = (d.cobros || []);
      if (d.procesador && cobros.length && !l.importe.startsWith('-')) {
        const vincular = el('button', { type: 'button', textContent: 'Es el cobro de una venta…' });
        vincular.onclick = () => {
          const L = centavos(l.importe), dist = c => { const x = centavos(c.importe) - L; return x < 0n ? -x : x; };
          const dd = c => Math.abs(Date.parse(l.fecha) - Date.parse(c.dia));
          const cand = cobros.filter(c => c.dia <= String(l.fecha).slice(0, 10))
            .sort((a, b) => (dist(a) < dist(b) ? -1 : dist(a) > dist(b) ? 1 : dd(a) - dd(b))).slice(0, 40);
          if (!cand.length) return ctx.aviso('No hay cobros pendientes de este procesador anteriores a la línea.', 'mal');
          const sel = el('select', { 'aria-label': 'Cobro' }, ...cand.map(c => el('option', { value: c.id,
            textContent: `Venta #${c.id_externo} del ${fecha(c.dia)} · ${TIPO_OP[c.tipo_operacion] || c.tipo_operacion} · ${pesos(c.importe)}` + (cobros.some(x => x.punto_venta !== c.punto_venta) ? ` · ${c.punto_venta}` : '') })));
          const motivo = el('input', { placeholder: 'Motivo de la diferencia', 'aria-label': 'Motivo de la diferencia' });
          const nota = el('small', { className: 'dif-nota' });
          const ver = () => {
            const c = cand.find(x => x.id === sel.value), D = L - centavos(c.importe);
            motivo.hidden = D === 0n;
            nota.textContent = D === 0n ? 'Mismo importe.' : `Entró ${pesos(deCentavos(D < 0n ? -D : D))} ${D > 0n ? 'más' : 'menos'} que el cobro.`;
          };
          sel.onchange = ver; ver();
          const ok = el('button', { type: 'button', className: 'prim', textContent: 'Confirmar' });
          ok.onclick = async () => {
            const c = cand.find(x => x.id === sel.value);
            if (!motivo.hidden && !motivo.value.trim()) return (motivo.focus(), ctx.aviso('Indicá el motivo de la diferencia.', 'mal'));
            ok.disabled = true;
            try {
              await api('fin/conciliacion/acreditar', { method: 'POST', body: { ticket_pago_id: c.id, linea_ids: [l.id], manual: true, motivo: motivo.hidden ? null : motivo.value.trim() } });
              ctx.aviso(`Acreditada la venta #${c.id_externo}.`, 'ok'); await ctx.recargar();
            } catch (e) { alert(e.message); ok.disabled = false; }
          };
          acc.replaceChildren(sel, nota, motivo, ok, el('button', { type: 'button', textContent: 'Cancelar', onclick: restaurar }));
          sel.focus();
        };
        acc.append(vincular);
      }
      // Transferencia con otra cuenta propia (el apartado de Mercado Pago, otro banco): se asientan las dos patas.
      const transferir = el('button', { type: 'button', textContent: 'Transferencia con otra cuenta…' });
      transferir.onclick = async () => {
        let cuentas;
        try { cuentas = (await api('fin/cuentas')).cuentas.filter(c => c.activa && c.id !== d.cuenta_id && c.tipo !== 'cartera'); } catch (e) { return alert(e.message); }
        const sale = l.importe.startsWith('-');
        const sel = el('select', { 'aria-label': sale ? 'Cuenta de destino' : 'Cuenta de origen' },
          el('option', { value: '', textContent: sale ? 'Pasó a la cuenta…' : 'Vino de la cuenta…' }),
          ...cuentas.sort((a, b) => a.nombre.localeCompare(b.nombre)).map(c => el('option', { value: c.id, textContent: c.nombre })));
        const inp = el('input', { value: pp.nombre, 'aria-label': 'Concepto' });
        const ok = el('button', { type: 'button', className: 'prim', textContent: 'Registrar' });
        ok.onclick = () => sel.value ? conciliar({ linea_id: l.id, transferir: { cuenta_id: sel.value, concepto: inp.value.trim() } })
          : (sel.focus(), ctx.aviso('Elegí la otra cuenta.', 'mal'));
        acc.replaceChildren(sel, inp, ok, el('button', { type: 'button', textContent: 'Cancelar', onclick: restaurar }));
        sel.focus();
      };
      // No tener en cuenta (decisión de Fer, 09/11/2026): no se va a conciliar nunca (un cobro de una venta anterior al
      // inicio de los cobros, algo anterior al inicio del control de la cuenta). No mueve plata y se puede volver a pendiente.
      const descartar = el('button', { type: 'button', textContent: 'No tener en cuenta…' });
      descartar.onclick = () => {
        const motivo = el('input', { placeholder: 'Por qué no se tiene en cuenta', 'aria-label': 'Motivo' });
        const ok = el('button', { type: 'button', className: 'prim', textContent: 'No tener en cuenta' });
        ok.onclick = async () => {
          if (!motivo.value.trim()) return (motivo.focus(), ctx.aviso('Indicá el motivo.', 'mal'));
          ok.disabled = true;
          try { await api('fin/conciliacion/descartar', { method: 'POST', body: { linea_ids: [l.id], motivo: motivo.value.trim() } }); ctx.aviso('La línea ya no se tiene en cuenta.', 'ok'); await ctx.recargar(); }
          catch (e) { alert(e.message); ok.disabled = false; }
        };
        acc.replaceChildren(motivo, ok, el('button', { type: 'button', textContent: 'Cancelar', onclick: restaurar }));
        motivo.focus();
      };
      acc.append(transferir, descartar);
      base = [...acc.childNodes];
      return el('div', { className: 'pend' },
        el('div', { className: 'q' }, el('b', { textContent: `${fecha(l.fecha)} · ${pp.nombre || 'Sin concepto'}` }),
          el('small', { textContent: [pp.numero && 'Nº ' + pp.numero, l.referencia].filter(Boolean).join(' · ') })),
        el('div', { className: 'imp' }, conSigno(l.importe)), sug, acc);
    }
    function filaCobro(c) {
      const acc = el('div', { className: 'acc' });
      const abrir = como => {
        const motivo = el('input', { placeholder: como === 'efectivo' ? 'Motivo: quién lo confirmó, cómo se cobró…' : 'Motivo: por qué no va a llegar', 'aria-label': 'Motivo' });
        const ok = el('button', { type: 'button', className: 'prim', textContent: como === 'efectivo' ? 'Pasar a efectivo' : 'Registrar diferencia' });
        ok.onclick = async () => {
          if (!motivo.value.trim()) return (motivo.focus(), ctx.aviso('Indicá el motivo.', 'mal'));
          ok.disabled = true;
          try {
            await api('fin/conciliacion/cobro-resuelto', { method: 'POST', body: { ticket_pago_id: c.id, como, motivo: motivo.value.trim() } });
            ctx.aviso(como === 'efectivo' ? `La venta #${c.id_externo} pasó al efectivo a rendir de ${c.punto_venta}.` : `La venta #${c.id_externo} quedó como diferencia.`, 'ok');
            await ctx.recargar();
          } catch (e) { alert(e.message); ok.disabled = false; }
        };
        acc.replaceChildren(motivo, ok, el('button', { type: 'button', textContent: 'Cancelar', onclick: inicial }));
        motivo.focus();
      };
      const inicial = () => acc.replaceChildren(
        ...(c.con_efectivo ? [el('button', { type: 'button', textContent: 'Se cobró en efectivo', onclick: () => abrir('efectivo') })] : []),
        el('button', { type: 'button', textContent: 'No va a llegar', onclick: () => abrir('no_llega') }));
      inicial();
      return el('div', { className: 'pend' },
        el('div', { className: 'q' }, el('b', { textContent: `${fecha(c.dia)} · Venta #${c.id_externo}` }),
          el('small', { textContent: [TIPO_OP[c.tipo_operacion] || c.tipo_operacion, c.punto_venta].join(' · ') })),
        el('div', { className: 'imp' }, pesos(c.importe)), acc);
    }
    const filaMov = m => el('div', { className: 'pend' },
      el('div', { className: 'q' }, el('b', { textContent: `${fecha(m.fecha)} · ${m.concepto || m.tipo}` }), el('small', { textContent: m.tipo })),
      el('div', { className: 'imp' }, conSigno(m.importe)));

    // Primero lo que tiene sugerencia (se resuelve con un toque); después lo demás.
    const conSug = l => sugDe(l.id) ? 0 : 1, orden = arr => arr.slice().sort((a, b) => conSug(a) - conSug(b));
    const egresos = orden(d.lineas.filter(l => l.importe.startsWith('-'))), ingresos = orden(d.lineas.filter(l => !l.importe.startsWith('-')));
    // Cada grupo muestra las primeras líneas; el resto, a pedido (una lista larga no dice qué hacer).
    const VISIBLES = 8;
    const grupo = (titulo, lista, cap, fila) => {
      const sec = el('section', { className: 'card grupo-p' },
        el('h3', {}, titulo, el('small', { textContent: `${lista.length} · ${pesos(suma(lista))}` })), el('p', { className: 'cap', textContent: cap }), ...lista.slice(0, VISIBLES).map(fila));
      if (lista.length > VISIBLES) {
        const mas = el('button', { type: 'button', className: 'ver-mas', textContent: `Ver ${lista.length - VISIBLES} más` });
        mas.onclick = () => mas.replaceWith(...lista.slice(VISIBLES).map(fila));
        sec.append(mas);
      }
      return sec;
    };
    const grupos = [];
    // Cobros de otro procesador por importe y fecha (pedido de Fer, 13/11/2026: con Pago24 caído, en CORTAFUEGO se cobró por
    // transferencia directa a BRUBANK lo que en Fudo quedó como Pago24). Se confirman todos juntos o uno por uno en su línea.
    const porFecha = (d.sugerencias || []).filter(x => x.tipo === 'otro_por_fecha');
    if (porFecha.length) {
      const todos = el('button', { type: 'button', className: 'prim', textContent: porFecha.length === 1 ? 'Confirmar' : `Confirmar los ${porFecha.length}` });
      todos.onclick = async () => {
        todos.disabled = true; let hechos = 0;
        for (const x of porFecha) {
          try { await api('fin/conciliacion/acreditar', { method: 'POST', body: { ticket_pago_id: x.pago.id, linea_ids: x.lineas, otro_procesador: 'fecha' } }); hechos++; }
          catch (e) { ctx.aviso(`Se acreditaron ${hechos}; la venta #${x.pago.id_externo} dio error: ${e.message}`, 'mal'); break; }
          todos.textContent = `Acreditando… ${hechos} de ${porFecha.length}`;
        }
        if (hechos === porFecha.length) ctx.aviso(`Se acreditaron los ${hechos} cobros.`, 'ok');
        await ctx.recargar();
      };
      const porProc = [...new Set(porFecha.map(x => x.pago.procesador_cargado))].join(', ');
      grupos.push(el('section', { className: 'card grupo-p' },
        el('h3', {}, 'Cobros que coinciden por importe y fecha', el('small', { textContent: `${porFecha.length} · ${pesos(deCentavos(porFecha.reduce((s, x) => s + centavos(x.pago.importe), 0n)))}` })),
        el('p', { className: 'cap', textContent: `Ingresos que coinciden en importe exacto con una venta pendiente de acreditar de hasta una semana antes (cobrada con ${porProc}): `
          + 'ventas cargadas con otro procesador que se cobraron por acá, o que llegaron al banco más tarde de lo normal. Confirmarlos los acredita acá y los saca de lo que '
          + 'esperaba el procesador de la venta. Es la excepción, no la regla: revisá la lista antes, el pareo es sólo por importe y día (con importes repetidos, la venta '
          + 'que toma cada línea es indistinta). Cada uno se puede confirmar también suelto, en su línea.' }),
        el('ul', { className: 'lista-sug' }, ...porFecha.map(x => { const l = d.lineas.find(y => y.id === x.lineas[0]) || {};
          return el('li', { textContent: `${fecha(l.fecha)} · ${pesos(l.importe)} · ${l.concepto || ''} → venta #${x.pago.id_externo} del ${fecha(x.pago.dia)} (${x.pago.procesador_cargado})` }); })),
        el('div', { className: 'acciones' }, todos)));
    }
    // Los cobros que en el sistema de venta quedaron como efectivo se confirman todos juntos (decisión de Fer, 02/11/2026).
    const enEfectivo = (d.sugerencias || []).filter(x => x.tipo === 'en_efectivo');
    if (enEfectivo.length) {
      const todos = el('button', { type: 'button', className: 'prim', textContent: `Confirmar los ${enEfectivo.length}` });
      todos.onclick = async () => {
        todos.disabled = true; let hechos = 0;
        for (const x of enEfectivo) {
          try { await api('fin/conciliacion/acreditar', { method: 'POST', body: { ticket_pago_id: x.pago.id, linea_ids: x.lineas, en_efectivo: true } }); hechos++; }
          catch (e) { ctx.aviso(`Se acreditaron ${hechos}; la venta #${x.pago.id_externo} dio error: ${e.message}`, 'mal'); break; }
          todos.textContent = `Acreditando… ${hechos} de ${enEfectivo.length}`;
        }
        if (hechos === enEfectivo.length) ctx.aviso(`Se acreditaron los ${hechos} cobros cargados como efectivo.`, 'ok');
        await ctx.recargar();
      };
      grupos.push(el('section', { className: 'card grupo-p' },
        el('h3', {}, 'Cobrados acá, cargados como efectivo', el('small', { textContent: `${enEfectivo.length} · ${pesos(deCentavos(enEfectivo.reduce((s, x) => s + centavos(x.pago.importe), 0n)))}` })),
        el('p', { className: 'cap', textContent: 'Cobros que coinciden en importe y día con ventas que en el sistema de venta quedaron cobradas en efectivo. Confirmarlos los '
          + 'acredita acá y los saca del efectivo a rendir del punto de venta (si ese efectivo ya se rindió, queda en negativo hasta corregir la rendición).' }),
        el('div', { className: 'acciones' }, todos)));
    }
    // Transferencias entre cuentas propias (pedido de Fer, 10/11/2026): la misma plata en dos extractos propios, o una reserva o
    // retiro del apartado de Mercado Pago. Se confirman juntas; cada una asienta las dos patas y concilia las dos líneas.
    const transf = d.transferencias || [];
    const enTransf = new Set(transf.map(x => x.linea_id));
    if (transf.length) {
      const todas = el('button', { type: 'button', className: 'prim', textContent: transf.length === 1 ? 'Confirmar' : `Confirmar las ${transf.length}` });
      todas.onclick = async () => {
        todas.disabled = true;
        try {
          const r = await api('fin/conciliacion/transferencias', { method: 'POST', trabajando: 'Registrando las transferencias…',
            body: { pares: transf.map(x => ({ linea_id: x.linea_id, otra_linea_id: x.otra_linea ? x.otra_linea.id : null, cuenta_id: x.cuenta_id })) } });
          ctx.aviso(`${r.hechas} transferencia(s) registradas y conciliadas.` + (r.errores.length ? ` No se pudieron: ${r.errores.join('; ')}` : ''), r.errores.length ? 'aviso' : 'ok');
        } catch (e) { ctx.aviso(e.message, 'mal'); }
        await ctx.recargar();
      };
      const fila = x => {
        const sale = x.linea.importe.startsWith('-'), o = x.otra_linea;
        return el('div', { className: 'pend' },
          el('div', { className: 'q' }, el('b', { textContent: `${fecha(x.linea.fecha)} · ${partes(x.linea.concepto).nombre || x.linea.concepto || 'Sin concepto'}` }),
            el('small', { textContent: (sale ? 'Va a ' : 'Viene de ') + x.cuenta + (o ? ` (en su extracto el ${fecha(o.fecha)}: ${partes(o.concepto).nombre || o.concepto || ''})` : ' (sin extracto)') })),
          el('div', { className: 'imp' }, conSigno(x.linea.importe)));
      };
      grupos.push(el('section', { className: 'card grupo-p' },
        el('h3', {}, 'Transferencias entre cuentas propias', el('small', { textContent: `${transf.length} · ${pesos(deCentavos(transf.reduce((t, x) => { const v = centavos(x.linea.importe); return t + (v < 0n ? -v : v); }, 0n)))}` })),
        el('p', { className: 'cap', textContent: 'La misma plata en el extracto de dos cuentas propias (mismo importe, hasta 2 días de diferencia), o una reserva o retiro del apartado. '
          + 'Confirmarlas asienta la transferencia entre las dos cuentas y concilia las dos líneas.' }),
        ...transf.map(fila), el('div', { className: 'acciones' }, todas)));
    }
    const sinTransf = arr => arr.filter(l => !enTransf.has(l.id));
    ingresos.splice(0, ingresos.length, ...sinTransf(ingresos)); egresos.splice(0, egresos.length, ...sinTransf(egresos));
    if (ingresos.length) grupos.push(grupo('Ingresos sin identificar', ingresos,
      d.procesador ? 'No coinciden con ningún cobro de las ventas: puede ser una venta de un día que todavía no se importó (traela y volvé a conciliar) o un ingreso que no viene de ventas (registralo).'
        : 'Plata que entró a la cuenta y no tiene movimiento: registrala o conciliala con el movimiento que corresponde.', filaLinea));
    if (egresos.length) grupos.push(grupo('Egresos sin identificar', egresos,
      'Plata que salió de la cuenta y no tiene movimiento: un pago a un proveedor (se concilia con su orden de pago hecha desde esta cuenta) o un gasto que hay que registrar.', filaLinea));
    // Cobros de ventas que ya deberían estar en el extracto y no están (pedido de Fer, 08/11/2026): se parean desde la línea
    // ("Es el cobro de una venta…") o, si no van a llegar por este procesador, se resuelven acá.
    const revisar = (d.cobros || []).filter(c => c.revisar);
    if (d.procesador && revisar.length) grupos.push(grupo('Cobros que no aparecen en el extracto', revisar,
      'Ventas cobradas con este procesador que el extracto ya debería traer. Si la plata entró con otro importe, conciliala desde su línea con '
      + '"Es el cobro de una venta…". Si se cobró en efectivo (mal cargado en el sistema de venta), pasa al efectivo a rendir del punto de venta; '
      + 'si no va a llegar, queda como diferencia de acreditación.', filaCobro));
    // Las que no se tienen en cuenta, al final y plegadas: se pueden volver a pendiente.
    const filaDescartada = l => {
      const pp = partes(l.concepto);
      const volver = el('button', { type: 'button', textContent: 'Volver a pendiente' });
      volver.onclick = async () => {
        volver.disabled = true;
        try { await api('fin/conciliacion/descartada/' + l.id, { method: 'DELETE', body: {} }); ctx.aviso('La línea volvió a pendiente.', 'ok'); await ctx.recargar(); }
        catch (e) { alert(e.message); volver.disabled = false; }
      };
      return el('div', { className: 'pend' },
        el('div', { className: 'q' }, el('b', { textContent: `${fecha(l.fecha)} · ${pp.nombre || 'Sin concepto'}` }),
          el('small', { textContent: `${l.descartada}` + (l.descartada_por ? ` (${l.descartada_por})` : '') })),
        el('div', { className: 'imp' }, conSigno(l.importe)), el('div', { className: 'acc' }, volver));
    };
    const fueraDeCuenta = () => {
      const lista = d.descartadas || [];
      if (!lista.length) return null;
      const det = el('details', { className: 'card grupo-p' },
        el('summary', {}, el('b', { textContent: 'No se tienen en cuenta' }), el('small', { textContent: ` ${lista.length} · ${pesos(suma(lista))}` })));
      det.addEventListener('toggle', () => { if (det.open && det.children.length === 1) det.append(
        el('p', { className: 'cap', textContent: 'Líneas del extracto que no se van a conciliar (por ejemplo, cobros de ventas anteriores al inicio de los cobros). No mueven plata: la diferencia con el saldo del sistema se resuelve con el saldo inicial.' }),
        ...lista.map(filaDescartada)); });
      return det;
    };
    if (d.movimientos.length) grupos.push(grupo('En el sistema, pero no en el extracto', d.movimientos,
      'Movimientos que todavía no aparecieron en el extracto: puede que no se hayan acreditado o debitado todavía, o que el banco los haya registrado con otro importe.', filaMov));
    const fuera = fueraDeCuenta();
    return [...(grupos.length ? grupos : [el('section', { className: 'card vacio-ok' },
      el('b', { textContent: d.conciliado.lineas ? 'Nada para resolver' : 'Nada para resolver todavía' }),
      d.conciliado.lineas ? 'Todo lo importado está conciliado.' : 'Importá el extracto de la cuenta para empezar.')]), ...(fuera ? [fuera] : [])];
  }

  // El saldo del sistema contra el del extracto, en una frase (la diferencia la explican las líneas pendientes).
  function frenteExtracto(saldoSistema, p) {
    const e = (p && p.extracto) || {};
    const det = [el('span', {}, 'Saldo en el sistema ', el('b', { textContent: pesos(saldoSistema || '0') }))];
    if (p && e.saldo_final != null) {
      const dif = centavos(e.saldo_final) - centavos(p.saldo_sistema), expl = centavos(e.importe_pendiente || '0') + centavos(e.importe_descartado || '0');
      det.push(' · según el extracto al ' + fecha(e.hasta) + ' ', el('b', { textContent: pesos(e.saldo_final) }));
      if (dif === 0n) det.push('. Coinciden.');
      else if (dif === expl) det.push('. La diferencia, ', el('b', { textContent: pesos(deCentavos(dif)) }), ', es lo que falta resolver' + (centavos(e.importe_descartado || '0') ? ' y lo que no se tiene en cuenta.' : '.'));
      else det.push('. Diferencia ', el('b', { textContent: pesos(deCentavos(dif)) }), `, de la que ${pesos(deCentavos(dif - expl))} no está en las líneas pendientes: revisá movimientos posteriores al extracto.`);
    }
    return det;
  }

  return { TIPO_OP, LINEA, conSigno, partes, automatica, importador, resolver, frenteExtracto, selectRubro, rubros, liberacionesMP };
})();
