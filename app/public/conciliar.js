// Conciliación: lo que comparten la pantalla de Conciliación y el proceso de ingresos (paso de extractos y paso de
// conciliar). Dos piezas:
//   · Conc.importador: elegir el archivo, reconocer el formato (Mercado Pago pide el resumen y las liquidaciones
//     juntos), mapear las columnas de un CSV común e importar en una cuenta. En la cuenta de un procesador concilia en
//     el mismo paso.
//   · Conc.resolver: lo que falta resolver de una cuenta, agrupado, con el pareo sugerido de cada línea y su acción.
// Usa los helpers de comun.js (el, api, pesos, fecha, centavos…), que se cargan antes.
const Conc = (() => {
  const TIPO_OP = { transferencia: 'Transferencia', qr: 'Pago QR', debito: 'Tarjeta de débito', credito: 'Tarjeta de crédito', otro: 'Otro' };
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

  // Conciliación automática de la cuenta de un procesador; devuelve el resultado en una frase.
  async function automatica(cuentaId) {
    const d = await api('fin/conciliacion/automatica', { method: 'POST', body: { cuenta_id: cuentaId } });
    const costos = Object.values(d.gastos).reduce((s, v) => s + centavos(v), 0n);
    const p = [];
    if (d.acreditadas || costos) p.push(`Se conciliaron ${d.acreditadas} cobro(s) por ${pesos(d.acreditado)}` + (costos ? ` y ${pesos(deCentavos(costos))} de cargos e impuestos` : '') + '.');
    if (d.lotes_liquidados) p.push(`${d.lotes_liquidados} lote(s) nuevos esperando el depósito.`);
    if (d.lotes_confirmados) p.push(`${d.lotes_confirmados} lote(s) confirmados con el extracto.`);
    return p.length || d.compensadas ? p.join(' ') : 'No había nada nuevo para conciliar.';
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
      let txt = '';
      if (liqA || resA) {
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
      } else csv = leidos[0];
      formato.hidden = !csv.mp; formato.textContent = txt;
      ok.textContent = opc.procesador() ? 'Importar y conciliar' : 'Importar';
      opcCsv.hidden = mapaWrap.hidden = capCsv.hidden = !!csv.mp;
      ok.disabled = !!(csv.mp && csv.mp.incompleto);
      if (csv.mp) titulo.textContent = `Importar ${csv.nombre}`; else pintarMapa();
      caja.hidden = false; caja.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    encab.onchange = () => csv && pintarMapa();
    no.onclick = cerrar;
    ok.onclick = async () => {
      let filas, dec = decimal.value;
      if (csv.mp) { filas = csv.mp.filas; dec = '.'; }
      else {
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
        if (opc.procesador()) { opc.listo(t + ' Conciliando…', ''); t += ' ' + await automatica(opc.cuenta()); }
        opc.listo(t, 'ok');
      } catch (e) { avisar(e.message, 'mal'); ok.disabled = false; }
    };
    return { el: el('div', {}, archivo, caja), abrir: () => archivo.click() };
  }

  // ── Lo que falta resolver de una cuenta ──
  // d: respuesta de /fin/conciliacion; ctx: recargar() (después de cada acción) y aviso(texto, tipo).
  function resolver(d, ctx) {
    const conciliar = async body => {
      try { await api('fin/conciliacion', { method: 'POST', body }); ctx.aviso('Conciliado.', 'ok'); await ctx.recargar(); } catch (e) { alert(e.message); }
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
      const inicial = [...acc.childNodes];
      registrar.onclick = () => {
        const inp = el('input', { placeholder: l.importe.startsWith('-') ? 'Qué es: gasto bancario, impuesto…' : 'Qué es: aporte, reintegro…', value: pp.nombre });
        const ok = el('button', { type: 'button', className: 'prim', textContent: 'Registrar' });
        ok.onclick = () => inp.value.trim() ? conciliar({ linea_id: l.id, crear: { concepto: inp.value.trim() } }) : inp.focus();
        acc.replaceChildren(inp, ok, el('button', { type: 'button', textContent: 'Cancelar', onclick: () => acc.replaceChildren(...inicial, registrar) }));
        inp.focus(); inp.select();
      };
      acc.append(registrar);
      return el('div', { className: 'pend' },
        el('div', { className: 'q' }, el('b', { textContent: `${fecha(l.fecha)} · ${pp.nombre || 'Sin concepto'}` }),
          el('small', { textContent: [pp.numero && 'Nº ' + pp.numero, l.referencia].filter(Boolean).join(' · ') })),
        el('div', { className: 'imp' }, conSigno(l.importe)), sug, acc);
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
    if (ingresos.length) grupos.push(grupo('Ingresos sin identificar', ingresos,
      d.procesador ? 'No coinciden con ningún cobro de las ventas: puede ser una venta de un día que todavía no se importó (traela y volvé a conciliar) o un ingreso que no viene de ventas (registralo).'
        : 'Plata que entró a la cuenta y no tiene movimiento: registrala o conciliala con el movimiento que corresponde.', filaLinea));
    if (egresos.length) grupos.push(grupo('Egresos sin identificar', egresos,
      'Plata que salió de la cuenta y no tiene movimiento: un pago a un proveedor (se concilia con su orden de pago hecha desde esta cuenta) o un gasto que hay que registrar.', filaLinea));
    if (d.movimientos.length) grupos.push(grupo('En el sistema, pero no en el extracto', d.movimientos,
      'Movimientos que todavía no aparecieron en el extracto: puede que no se hayan acreditado o debitado todavía, o que el banco los haya registrado con otro importe.', filaMov));
    return grupos.length ? grupos : [el('section', { className: 'card vacio-ok' },
      el('b', { textContent: d.conciliado.lineas ? 'Nada para resolver' : 'Nada para resolver todavía' }),
      d.conciliado.lineas ? 'Todo lo importado está conciliado.' : 'Importá el extracto de la cuenta para empezar.')];
  }

  // El saldo del sistema contra el del extracto, en una frase (la diferencia la explican las líneas pendientes).
  function frenteExtracto(saldoSistema, p) {
    const e = (p && p.extracto) || {};
    const det = [el('span', {}, 'Saldo en el sistema ', el('b', { textContent: pesos(saldoSistema || '0') }))];
    if (p && e.saldo_final != null) {
      const dif = centavos(e.saldo_final) - centavos(p.saldo_sistema), expl = centavos(e.importe_pendiente || '0');
      det.push(' · según el extracto al ' + fecha(e.hasta) + ' ', el('b', { textContent: pesos(e.saldo_final) }));
      if (dif === 0n) det.push('. Coinciden.');
      else if (dif === expl) det.push('. La diferencia, ', el('b', { textContent: pesos(deCentavos(dif)) }), ', es lo que falta resolver.');
      else det.push('. Diferencia ', el('b', { textContent: pesos(deCentavos(dif)) }), `, de la que ${pesos(deCentavos(dif - expl))} no está en las líneas pendientes: revisá movimientos posteriores al extracto.`);
    }
    return det;
  }

  return { TIPO_OP, conSigno, partes, automatica, importador, resolver, frenteExtracto };
})();
