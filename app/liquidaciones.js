// Liquidación semanal de PedidosYa (decisión de Fer, 09/11/2026; migración 20261138).
//
// PedidosYa liquida de lunes a domingo y paga lo vendido menos dos facturas A a la sociedad (Delivery Hero E-Commerce:
// comisión, publicidad, descuentos del local y reclamos, con una bonificación; Pagos Ya: el pago en línea), con IVA y
// percepciones. Por pedido ya se asentó, al cobrar cada día, lo que trae el orderDetails (comisión, pago en línea,
// descuentos, reclamos y el IVA de eso). Lo que sólo está en las facturas se calcula acá, contra lo ya asentado:
//   publicidad      = lo facturado antes de la bonificación − lo asentado por pedido sin IVA (por tienda)
//   IVA             = IVA de las facturas − IVA asentado + IVA de la bonificación (≈ 21% de la publicidad)
//   percepciones    = las de las facturas (IVA RG 5319 a "Otras retenciones", IIBB a Ingresos Brutos)
//   esperado        = suma de netos por pedido − publicidad − IVA − percepciones
// La bonificación no se asienta: PedidosYa resta de las ventas la bonificación con su IVA y la devuelve, el efecto sobre lo
// que paga es cero (verificado con la semana del 26/10 de SORELLE: esperado 2.699.471,50 = lo pagado, al centavo).
// Lo que paga PedidosYa lo dice el portal: si no coincide con el esperado, la diferencia queda como diferencia de
// acreditación (con motivo si pasa de $100).
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, texto, fecha, h, enTransaccion } = require('./util');
const { leerFactura } = require('./factura_pdf');
const { asentarLote } = require('./tesoreria');

const r = express.Router();
const centavos = v => { const s = String(v ?? 0), neg = s.startsWith('-'), [e, d = ''] = s.replace('-', '').split('.'); const c = BigInt(e || '0') * 100n + BigInt((d + '00').slice(0, 2)); return neg ? -c : c; };
const deCentavos = c => { const a = c < 0n ? -c : c; return (c < 0n ? '-' : '') + String(a / 100n) + '.' + String(a % 100n).padStart(2, '0'); };
// Lo que paga PedidosYa se copia del portal, con centavos ("2.699.471,50"): coma decimal y punto de miles. También
// "2699471.50" o "2.699.471" (sin centavos).
function importePortal(v, campo) {
  let s = String(v ?? '').trim().replace(/^\$\s*/, '');
  if (!s) throw new ErrorUsuario(`Falta ${campo}.`);
  if (s.includes(',')) { if (!/^\d{1,3}(\.\d{3})*,\d{1,2}$|^\d+,\d{1,2}$/.test(s)) throw new ErrorUsuario(`${campo}: "${v}" no es un importe válido.`); s = s.replace(/\./g, '').replace(',', '.'); }
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new ErrorUsuario(`${campo}: "${v}" no es un importe válido.`);
  return s;
}
const suma = xs => xs.reduce((a, b) => a + b, 0n);
const diaMas = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ddmm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const lunes = iso => { const d = new Date(iso + 'T12:00:00Z'); return diaMas(iso, -((d.getUTCDay() + 6) % 7)); };
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
// Reparte un importe en centavos en proporción a los pesos (enteros en centavos); lo que sobra del redondeo, al mayor.
function repartir(total, pesos) {
  const tot = suma(pesos.map(p => p > 0n ? p : 0n));
  if (tot === 0n) return pesos.map((_, i) => (i === 0 ? total : 0n));
  const partes = pesos.map(p => (p > 0n ? (total * p) / tot : 0n));
  const resto = total - suma(partes);
  let mayor = 0; pesos.forEach((p, i) => { if (p > pesos[mayor]) mayor = i; });
  partes[mayor] += resto;
  return partes;
}

async function procesadorPeya(c, id) {
  const { rows: [p] } = await c.query(
    `SELECT pr.id, pr.nombre, pr.cuenta_id, pr.cuenta_acredita_id, pr.sociedad_id, so.nombre AS sociedad, so.cuit AS sociedad_cuit, ca.nombre AS deposita
       FROM fin.procesador pr LEFT JOIN org.sociedad so ON so.id = pr.sociedad_id LEFT JOIN fin.cuenta ca ON ca.id = pr.cuenta_acredita_id
      WHERE pr.id = $1::uuid AND pr.marca = 'pedidosya'`, [id]);
  if (!p) throw new ErrorUsuario('Ese procesador no es de PedidosYa.');
  return p;
}

// Los cobros de una semana del procesador (desde la fecha de inicio de los cobros de cada local), con su tienda, local y
// comercio, y lo asentado por pedido.
async function cobrosSemana(c, procesadorId, desde, { bloquear = false } = {}) {
  const { rows } = await c.query(
    `SELECT p.id, p.importe::text, p.neto::text, p.costos, p.cobro_id, p.lote_id, p.acreditado_linea_id, p.resuelto_movimiento_id,
            t.tienda, t.dia, i.sede_id, s.nombre AS sede,
            (SELECT co.id FROM org.comercio co WHERE co.sede_id = i.sede_id AND co.activo AND t.tienda = ANY (co.tiendas) LIMIT 1) AS comercio_id,
            (SELECT co.nombre FROM org.comercio co WHERE co.sede_id = i.sede_id AND co.activo AND t.tienda = ANY (co.tiendas) LIMIT 1) AS comercio
       FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
       JOIN org.sede s ON s.id = i.sede_id
       JOIN pos.medio m ON m.id = p.medio_id JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
      WHERE mp.procesador_id = $1::uuid AND NOT p.anulado AND t.estado = 'cerrado'
        AND t.dia BETWEEN $2::date AND $2::date + 6 AND t.dia >= COALESCE(i.cobros_desde, t.dia)
      ${bloquear ? 'FOR UPDATE OF p' : ''}`, [procesadorId, desde]);
  return rows;
}

// Lo asentado por pedido, por tienda: bruto, neto, costos sin IVA, IVA y cada concepto (para reconocer la tienda de un
// renglón de la factura por su importe exacto, p. ej. el pago en línea).
function porTienda(cobros) {
  const ts = new Map();
  for (const p of cobros) {
    const k = p.tienda || '';
    const t = ts.get(k) || { tienda: k, sede_id: p.sede_id, sede: p.sede, comercio_id: p.comercio_id, comercio: p.comercio, pedidos: 0,
                             bruto: 0n, neto: 0n, sin_iva: 0n, iva: 0n, conceptos: new Map() };
    t.pedidos++; t.bruto += centavos(p.importe); t.neto += centavos(p.neto ?? p.importe);
    for (const x of p.costos || []) {
      const v = centavos(x.importe);
      if (x.gasto === 'iva_credito') t.iva += v; else t.sin_iva += v;
      t.conceptos.set(x.concepto, (t.conceptos.get(x.concepto) || 0n) + v);
    }
    ts.set(k, t);
  }
  return [...ts.values()];
}

// La tienda de cada renglón: lo que va entre paréntesis ("SERVICIOS PEDIDOSYA (Wera Sushi)"). Se reconoce primero por un
// importe que coincide exacto con un concepto de una sola tienda (el pago en línea de la factura de Pagos Ya es, al
// centavo, el de cada tienda), después por el nombre del comercio, y si queda una sola, es ésa.
function tiendasDeNombres(nombres, tiendas, renglones) {
  const mapa = new Map();
  for (const n of nombres) {
    for (const rg of renglones.filter(x => x.nombre === n)) {
      const cand = tiendas.filter(t => [...t.conceptos.values()].some(v => v === rg.base));
      if (cand.length === 1 && ![...mapa.values()].includes(cand[0])) { mapa.set(n, cand[0]); break; }
    }
  }
  for (const n of nombres.filter(n => !mapa.has(n))) {
    const w = norm(n);
    const libres = tiendas.filter(t => ![...mapa.values()].includes(t));
    const punt = libres.map(t => ({ t, p: norm(`${t.comercio || ''} ${t.sede || ''}`).filter(x => w.includes(x)).length })).sort((a, b) => b.p - a.p);
    if (punt.length && punt[0].p > 0 && (punt.length === 1 || punt[1].p < punt[0].p)) mapa.set(n, punt[0].t);
  }
  const sinNombre = nombres.filter(n => !mapa.has(n)), sinTienda = tiendas.filter(t => ![...mapa.values()].includes(t));
  if (sinNombre.length === 1 && sinTienda.length === 1) mapa.set(sinNombre[0], sinTienda[0]);
  return mapa;
}

// El cálculo completo de una semana con sus facturas (ya leídas). No guarda nada.
function calcular(cobros, facturas) {
  const tiendas = porTienda(cobros);
  const renglones = [];
  for (const f of facturas) for (const it of f.items) {
    const m = /\(([^()]+)\)\s*$/.exec(it.descripcion);
    const subtotal = centavos(it.subtotal), descuento = centavos(it.descuento) < 0n ? -centavos(it.descuento) : centavos(it.descuento);
    renglones.push({ nombre: m ? m[1].trim() : null, base: subtotal + descuento, descuento, alicuota: Number(it.alicuota) || 0 });
  }
  const nombres = [...new Set(renglones.map(x => x.nombre).filter(Boolean))];
  const mapa = tiendasDeNombres(nombres, tiendas, renglones);
  const avisos = [];
  const sinTienda = nombres.filter(n => !mapa.has(n));
  if (sinTienda.length) avisos.push(`No reconocí la tienda de: ${sinTienda.join(', ')}. Lo de esa parte se reparte por las ventas.`);

  const calculado = suma(tiendas.map(t => t.neto));
  const facturadoBase = suma(renglones.map(x => x.base));
  const asentadoSinIva = suma(tiendas.map(t => t.sin_iva)), asentadoIva = suma(tiendas.map(t => t.iva));
  const ivaFacturas = suma(facturas.map(f => suma(Object.values(f.iva).map(centavos))));
  // El IVA de la bonificación, como el de la factura: sobre la suma por alícuota (redondear renglón por renglón da un centavo de más).
  const porAlic = new Map();
  for (const x of renglones) porAlic.set(x.alicuota, (porAlic.get(x.alicuota) || 0n) + x.descuento);
  const ivaBonif = suma([...porAlic.entries()].map(([a, d]) => (d * BigInt(Math.round(a * 100)) + 5000n) / 10000n));
  const publicidad = facturadoBase - asentadoSinIva;
  const iva = ivaFacturas - asentadoIva + ivaBonif;
  const percIva = suma(facturas.flatMap(f => f.tributos.filter(t => t.tipo === 'percepcion_iva').map(t => centavos(t.importe))));
  const percIibb = suma(facturas.flatMap(f => f.tributos.filter(t => t.tipo === 'percepcion_iibb').map(t => centavos(t.importe))));
  const percOtras = suma(facturas.flatMap(f => f.tributos.filter(t => !['percepcion_iva', 'percepcion_iibb'].includes(t.tipo)).map(t => centavos(t.importe))));
  const esperado = calculado - publicidad - iva - percIva - percIibb - percOtras;
  if (publicidad < 0n) avisos.push('Lo facturado es menos que lo asentado por pedido: revisá que las facturas sean de esta semana y estén las dos.');

  // Por tienda: la publicidad exacta si se reconoció la tienda de sus renglones; lo que no, en proporción a las ventas.
  const pubT = tiendas.map(t => {
    const base = suma(renglones.filter(x => x.nombre && mapa.get(x.nombre) === t).map(x => x.base));
    return base ? base - t.sin_iva : 0n;
  });
  const pubSinTienda = publicidad - suma(pubT);
  const extraPub = repartir(pubSinTienda, tiendas.map(t => t.bruto));
  const pub = pubT.map((v, i) => v + extraPub[i]);
  const ivaT = repartir(iva, pub.map(v => (v > 0n ? v : 0n)).some(v => v > 0n) ? pub : tiendas.map(t => t.bruto));
  const pesoFact = tiendas.map(t => suma(renglones.filter(x => x.nombre && mapa.get(x.nombre) === t).map(x => x.base)) || t.bruto);
  const percIvaT = repartir(percIva, pesoFact), percIibbT = repartir(percIibb, pesoFact), percOtrasT = repartir(percOtras, pesoFact);

  return {
    calculado, publicidad, iva, perc_iva: percIva, perc_iibb: percIibb, perc_otras: percOtras, esperado, avisos,
    bonificacion: suma(renglones.map(x => x.descuento)),
    tiendas: tiendas.map((t, i) => ({ tienda: t.tienda, sede_id: t.sede_id, sede: t.sede, comercio_id: t.comercio_id, comercio: t.comercio,
      nombre: [...mapa.entries()].find(([, v]) => v === t)?.[0] || null, pedidos: t.pedidos, bruto: t.bruto, neto: t.neto,
      publicidad: pub[i], iva: ivaT[i], perc_iva: percIvaT[i], perc_iibb: percIibbT[i], perc_otras: percOtrasT[i] })),
  };
}
const aTexto = o => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? deCentavos(v) : v)));

// Facturas: cada una es la lista de textos de sus páginas. Se leen acá (nunca se toman ya leídas del navegador).
function leerFacturas(b) {
  const fs = Array.isArray(b.facturas) ? b.facturas : [];
  if (!fs.length || fs.length > 6) throw new ErrorUsuario('Elegí las facturas de la semana (entre una y seis).');
  const leidas = fs.map((pags, i) => { try { return leerFactura(pags); } catch (e) {
    if (e instanceof ErrorUsuario) { console.error('[liquidaciones] factura sin leer:', e.message, JSON.stringify(pags).slice(0, 4000)); throw new ErrorUsuario(`Factura ${i + 1}: ${e.message}`); }
    throw e; } });
  const claves = new Set();
  for (const f of leidas) {
    const k = `${f.emisor.cuit}-${f.codigo}-${f.punto_venta}-${f.numero}`;
    if (claves.has(k)) throw new ErrorUsuario(`La factura ${f.punto_venta}-${f.numero} está repetida.`);
    claves.add(k);
  }
  return leidas;
}

function controlarFacturas(p, desde, facturas) {
  const hasta = diaMas(desde, 6), avisos = [];
  for (const f of facturas) {
    const nro = `${String(f.punto_venta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}`;
    if (f.tipo !== 'factura') throw new ErrorUsuario(`La ${nro} no es una factura (las notas de crédito o débito se cargan en Facturas de proveedor).`);
    if (p.sociedad_cuit && f.receptor.cuit !== p.sociedad_cuit) throw new ErrorUsuario(`La ${nro} es para el CUIT ${f.receptor.cuit}, no para ${p.sociedad}.`);
    if (f.periodo.desde && (f.periodo.desde !== desde || f.periodo.hasta !== hasta))
      throw new ErrorUsuario(`La ${nro} es del período ${f.periodo.desde} al ${f.periodo.hasta}, no de la semana del ${desde} al ${hasta}.`);
  }
  if (!p.sociedad_cuit) avisos.push(`${p.sociedad || 'La sociedad'} no tiene el CUIT cargado (las facturas dicen ${facturas[0].receptor.cuit}): cargalo en Organización para el libro IVA.`);
  return avisos;
}

// ── Las semanas ──────────────────────────────────────────────────────────────────────────────
r.get('/fin/liquidaciones', h(async (req, res) => {
  const { rows: procs } = await pool.query(
    `SELECT pr.id, pr.nombre, pr.sociedad_id, so.nombre AS sociedad, ca.nombre AS deposita, pr.cuenta_acredita_id
       FROM fin.procesador pr LEFT JOIN org.sociedad so ON so.id = pr.sociedad_id LEFT JOIN fin.cuenta ca ON ca.id = pr.cuenta_acredita_id
      WHERE pr.marca = 'pedidosya' AND pr.activo ORDER BY pr.nombre`);
  const { rows: semanas } = await pool.query(
    `SELECT mp.procesador_id, to_char(date_trunc('week', t.dia), 'YYYY-MM-DD') AS desde, COUNT(*)::int AS pedidos,
            SUM(p.importe)::text AS bruto, SUM(COALESCE(p.neto, p.importe))::text AS neto,
            COUNT(*) FILTER (WHERE p.cobro_id IS NULL)::int AS sin_cobrar,
            COUNT(*) FILTER (WHERE p.lote_id IS NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL)::int AS libres,
            SUM(COALESCE(p.neto, p.importe)) FILTER (WHERE p.lote_id IS NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL)::text AS neto_libre
       FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
       JOIN pos.medio m ON m.id = p.medio_id JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id JOIN fin.procesador pr ON pr.id = mp.procesador_id
      WHERE pr.marca = 'pedidosya' AND NOT p.anulado AND t.estado = 'cerrado' AND t.dia >= COALESCE(i.cobros_desde, t.dia)
        AND t.dia >= current_date - 120
      GROUP BY 1, 2`);
  const { rows: liqs } = await pool.query(
    `SELECT l.id, l.procesador_id, to_char(l.desde, 'YYYY-MM-DD') AS desde, to_char(l.fecha_pago, 'YYYY-MM-DD') AS fecha_pago,
            l.calculado::text, l.total::text, l.fuera_gestion, l.motivo, lo.movimiento_id IS NOT NULL AS acreditada,
            to_char(mv.fecha, 'YYYY-MM-DD') AS acreditada_el, ca.nombre AS acreditada_en,
            EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.movimiento_id = lo.movimiento_id) AS conciliada,
            (SELECT json_agg(json_build_object('id', c.id, 'proveedor', pv.nombre, 'numero', lpad(c.punto_venta::text, 5, '0') || '-' || lpad(c.numero::text, 8, '0'),
                                               'total', c.total::text) ORDER BY c.punto_venta, c.numero)
               FROM fin.liquidacion_comprobante lc JOIN fin.comprobante c ON c.id = lc.comprobante_id JOIN logic.proveedor pv ON pv.id = c.proveedor_id
              WHERE lc.liquidacion_id = l.id) AS facturas
       FROM fin.liquidacion l JOIN fin.lote lo ON lo.id = l.lote_id
       LEFT JOIN fin.movimiento_tes mv ON mv.id = lo.movimiento_id LEFT JOIN fin.cuenta ca ON ca.id = mv.cuenta_id
      WHERE l.desde >= current_date - 180`);
  const hoy = (await pool.query("SELECT to_char(current_date, 'YYYY-MM-DD') AS d")).rows[0].d;
  const out = procs.map(pr => {
    const ws = new Map();
    for (const s of semanas.filter(x => x.procesador_id === pr.id)) ws.set(s.desde, { ...s });
    for (const l of liqs.filter(x => x.procesador_id === pr.id)) ws.set(l.desde, { ...(ws.get(l.desde) || { desde: l.desde }), liquidacion: l });
    const lista = [...ws.values()].map(w => {
      const hasta = diaMas(w.desde, 6), l = w.liquidacion;
      const estado = l ? (l.fuera_gestion ? 'fuera' : l.acreditada ? 'acreditada' : 'esperando')
        : !w.libres ? 'resuelta' : hasta >= hoy ? 'en_curso' : w.sin_cobrar ? 'faltan_cobros' : 'por_liquidar';
      return { ...w, hasta, estado, fecha_esperada: diaMas(w.desde, 18) };
    }).filter(w => w.estado !== 'resuelta').sort((a, b) => b.desde.localeCompare(a.desde));
    return { ...pr, semanas: lista };
  });
  res.json({ ok: true, procesadores: out });
}));

// Vista previa: las facturas leídas y la cuenta contra lo asentado por pedido.
r.post('/fin/liquidaciones/leer', h(async (req, res) => {
  const b = req.body, desde = fecha(b.desde, { campo: 'la semana', requerido: true });
  if (lunes(desde) !== desde) throw new ErrorUsuario('La semana empieza un lunes.');
  const p = await procesadorPeya(pool, texto(b.procesador_id, { campo: 'el procesador', requerido: true }));
  const facturas = leerFacturas(b);
  const avisos = controlarFacturas(p, desde, facturas);
  const cobros = (await cobrosSemana(pool, p.id, desde)).filter(x => !x.lote_id && !x.acreditado_linea_id && !x.resuelto_movimiento_id);
  if (!cobros.length) throw new ErrorUsuario('Esa semana no tiene cobros para liquidar.');
  const sinCobrar = cobros.filter(x => !x.cobro_id).length;
  if (sinCobrar) avisos.push(`${sinCobrar} pedido(s) de la semana todavía no tienen el cobro procesado: hay que procesarlos antes de confirmar.`);
  const calc = calcular(cobros, facturas);
  const { rows: provs } = await pool.query('SELECT cuit, nombre FROM logic.proveedor WHERE cuit = ANY($1::text[])', [facturas.map(f => f.emisor.cuit)]);
  res.json({ ok: true, avisos: [...avisos, ...calc.avisos], ...aTexto({ ...calc, avisos: undefined }),
    facturas: facturas.map(f => ({ ...f, proveedor: provs.find(x => x.cuit === f.emisor.cuit)?.nombre || null })),
    fecha_esperada: diaMas(desde, 18), deposita: p.deposita });
}));

// Confirmar: facturas registradas y compensadas, costos asentados y el lote esperado por lo que paga PedidosYa.
r.post('/fin/liquidaciones', h(async (req, res) => {
  const b = req.body, desde = fecha(b.desde, { campo: 'la semana', requerido: true }), hasta = diaMas(desde, 6);
  if (lunes(desde) !== desde) throw new ErrorUsuario('La semana empieza un lunes.');
  const fechaPago = fecha(b.fecha_pago, { campo: 'la fecha de pago', requerido: true });
  const total = importePortal(b.total, 'lo que paga PedidosYa');
  const motivo = texto(b.motivo);
  const facturas = leerFacturas(b);
  const out = await enTransaccion(async c => {
    const p = await procesadorPeya(c, texto(b.procesador_id, { campo: 'el procesador', requerido: true }));
    if (!p.cuenta_acredita_id) throw new ErrorUsuario(`${p.nombre} no tiene cuenta en "Deposita en" (Medios de pago).`);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['liquidacion:' + p.id]);
    if ((await c.query('SELECT 1 FROM fin.liquidacion WHERE procesador_id = $1 AND desde = $2', [p.id, desde])).rowCount)
      throw new ErrorUsuario('Esa semana ya está liquidada.');
    controlarFacturas(p, desde, facturas);
    const cobros = (await cobrosSemana(c, p.id, desde, { bloquear: true })).filter(x => !x.lote_id && !x.acreditado_linea_id && !x.resuelto_movimiento_id);
    if (!cobros.length) throw new ErrorUsuario('Esa semana no tiene cobros para liquidar.');
    const sinCobrar = cobros.filter(x => !x.cobro_id).length;
    if (sinCobrar) throw new ErrorUsuario(`${sinCobrar} pedido(s) de la semana no tienen el cobro procesado: procesalos en el paso 1 antes de liquidar.`);
    const calc = calcular(cobros, facturas);
    const T = centavos(total), dif = calc.esperado - T;
    if ((dif < 0n ? -dif : dif) > 10000n && !motivo)
      throw new ErrorUsuario(`Lo que paga PedidosYa (${deCentavos(T)}) no coincide con lo esperado (${deCentavos(calc.esperado)}): diferencia ${deCentavos(dif)}. Para confirmar igual, indicá el motivo.`, 409);

    // Facturas: proveedor por CUIT (se crea si no existe), comprobante registrado y compensado.
    const comprobantes = [];
    for (const f of facturas) {
      let { rows: [pv] } = await c.query('SELECT id FROM logic.proveedor WHERE cuit = $1', [f.emisor.cuit]);
      if (!pv) ({ rows: [pv] } = await c.query(
        `INSERT INTO logic.proveedor (nombre, cuit, condicion_iva, notas) VALUES ($1, $2, 'responsable_inscripto', 'Alta automática desde la liquidación de PedidosYa') RETURNING id`,
        [f.emisor.razon_social || `CUIT ${f.emisor.cuit}`, f.emisor.cuit]));
      const ya = await c.query(`SELECT 1 FROM fin.comprobante WHERE proveedor_id = $1 AND tipo = $2 AND letra = $3 AND punto_venta = $4 AND numero = $5 AND estado <> 'anulado'`,
        [pv.id, f.tipo, f.letra, f.punto_venta, f.numero]);
      const nro = `${String(f.punto_venta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}`;
      if (ya.rowCount) throw new ErrorUsuario(`La factura ${f.letra} ${nro} ya está cargada.`);
      const { rows: [cp] } = await c.query(
        `INSERT INTO fin.comprobante (proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, cae, notas, sociedad_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [pv.id, f.tipo, f.letra, f.punto_venta, f.numero, f.fecha, f.vencimiento && f.vencimiento >= f.fecha ? f.vencimiento : null, f.cae,
         `Liquidación ${p.nombre} del ${ddmm(desde)} al ${ddmm(hasta)}`, p.sociedad_id]);
      for (const [i, it] of f.items.entries()) {
        const cant = Number(it.cantidad) > 0 ? it.cantidad : '1';
        const desc = centavos(it.descuento) !== 0n ? `${it.descripcion} (bonificación ${deCentavos(centavos(it.descuento) < 0n ? -centavos(it.descuento) : centavos(it.descuento))})` : it.descripcion;
        await c.query(`INSERT INTO fin.comprobante_item (comprobante_id, orden, descripcion, cantidad, precio_unitario, alicuota) VALUES ($1,$2,$3,$4,$5::numeric / $4::numeric,$6)`,
          [cp.id, i, desc.slice(0, 300), cant, it.subtotal, f.letra === 'A' || f.letra === 'M' ? it.alicuota : null]);
      }
      for (const t of f.tributos)
        await c.query('INSERT INTO fin.comprobante_tributo (comprobante_id, tipo, jurisdiccion, descripcion, importe) VALUES ($1,$2,$3,$4,$5)',
          [cp.id, t.tipo, t.jurisdiccion, t.descripcion, t.importe]);
      await c.query('SELECT fin.registrar_comprobante($1::uuid, $2::numeric)', [cp.id, f.total]);
      const { rows: [mc] } = await c.query(
        `INSERT INTO fin.movimiento_cc (fecha, proveedor_id, tipo, comprobante_id, debe, detalle) VALUES ($1,$2,'pago',$3,$4,$5) RETURNING id`,
        [f.fecha, pv.id, cp.id, f.total, `Compensada con la liquidación ${p.nombre} del ${ddmm(desde)} al ${ddmm(hasta)}`]);
      comprobantes.push({ id: cp.id, total: f.total, cc: mc.id });
    }

    // Lote por lo que paga PedidosYa, esperado hasta el depósito.
    const { rows: [lote] } = await c.query('INSERT INTO fin.lote (procesador_id, fecha, pagos, bruto, neto) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [p.id, fechaPago, cobros.length, deCentavos(suma(cobros.map(x => centavos(x.importe)))), deCentavos(T)]);
    await c.query('UPDATE pos.ticket_pago SET lote_id = $1 WHERE id = ANY($2::uuid[])', [lote.id, cobros.map(x => x.id)]);
    const { rows: [liq] } = await c.query(
      `INSERT INTO fin.liquidacion (procesador_id, desde, hasta, fecha_pago, calculado, total, motivo, lote_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [p.id, desde, hasta, fechaPago, deCentavos(calc.calculado), deCentavos(T), motivo || null, lote.id]);
    for (const x of comprobantes)
      await c.query('INSERT INTO fin.liquidacion_comprobante (liquidacion_id, comprobante_id, importe, cc_movimiento_id) VALUES ($1,$2,$3,$4)', [liq.id, x.id, x.total, x.cc]);

    // Costos que sólo están en las facturas, por tienda, en el último día de la semana.
    const { rows: rubros } = await c.query("SELECT clave, id FROM fin.rubro WHERE clave IN ('marketing','iva_credito','retencion','iibb','dif_acreditacion')");
    const rubro = k => rubros.find(x => x.clave === k).id;
    const semana = `semana del ${ddmm(desde)} al ${ddmm(hasta)}`;
    const asentar = async (v, gasto, clave, concepto, t) => {
      if (v === 0n) return;
      const sale = v > 0n, abs = sale ? v : -v;
      const { rows: [m] } = await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, gasto) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [hasta, p.cuenta_id, sale ? 'egreso' : 'ingreso', sale ? 0 : deCentavos(abs), sale ? deCentavos(abs) : 0,
         `${concepto} · ${t ? (t.comercio || t.nombre || t.sede) + ' · ' : ''}${semana}`.slice(0, 300), gasto]);
      await c.query('INSERT INTO fin.clasificacion (movimiento_id, rubro_id, sede_id, comercio_id) VALUES ($1,$2,$3,$4)',
        [m.id, rubro(clave), t ? t.sede_id : null, t ? t.comercio_id : null]);
      await c.query('INSERT INTO fin.liquidacion_costo (liquidacion_id, movimiento_id) VALUES ($1,$2)', [liq.id, m.id]);
    };
    const difT = repartir(dif, calc.tiendas.map(t => t.bruto));
    for (const [i, t] of calc.tiendas.entries()) {
      await asentar(t.publicidad, 'marketing', 'marketing', 'Publicidad PedidosYa', t);
      await asentar(t.iva, 'iva_credito', 'iva_credito', 'IVA de las facturas PedidosYa (publicidad)', t);
      await asentar(t.perc_iva, 'retencion', 'retencion', 'Percepción IVA PedidosYa', t);
      await asentar(t.perc_iibb, 'retencion', 'iibb', 'Percepción IIBB PedidosYa', t);
      await asentar(t.perc_otras, 'retencion', 'retencion', 'Otros tributos PedidosYa', t);
      await asentar(difT[i], 'otro', 'dif_acreditacion', `Diferencia con la liquidación PedidosYa${motivo ? ': ' + motivo : ''}`, t);
    }
    return { id: liq.id, comprobantes: comprobantes.length, esperado: deCentavos(calc.esperado), diferencia: deCentavos(dif) };
  });
  res.status(201).json({ ok: true, ...out });
}));

// Una semana cobrada fuera de la gestión (decisión de Fer, 09/11/2026: la del 28/09 de SORELLE): lo que está en "a acreditar"
// sale como "No es resultado", sin facturas. Sus costos por pedido ya están asentados.
r.post('/fin/liquidaciones/fuera', h(async (req, res) => {
  const b = req.body, desde = fecha(b.desde, { campo: 'la semana', requerido: true }), hasta = diaMas(desde, 6);
  if (lunes(desde) !== desde) throw new ErrorUsuario('La semana empieza un lunes.');
  const motivo = texto(b.motivo, { campo: 'el motivo', requerido: true });
  const out = await enTransaccion(async c => {
    const p = await procesadorPeya(c, texto(b.procesador_id, { campo: 'el procesador', requerido: true }));
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['liquidacion:' + p.id]);
    if ((await c.query('SELECT 1 FROM fin.liquidacion WHERE procesador_id = $1 AND desde = $2', [p.id, desde])).rowCount)
      throw new ErrorUsuario('Esa semana ya está liquidada.');
    const cobros = (await cobrosSemana(c, p.id, desde, { bloquear: true })).filter(x => !x.lote_id && !x.acreditado_linea_id && !x.resuelto_movimiento_id);
    if (!cobros.length) throw new ErrorUsuario('Esa semana no tiene cobros pendientes.');
    if (cobros.some(x => !x.cobro_id)) throw new ErrorUsuario('Hay pedidos de esa semana sin el cobro procesado: procesalos antes.');
    const neto = suma(cobros.map(x => centavos(x.neto ?? x.importe))), fechaPago = diaMas(desde, 18);
    const { rows: [m] } = await c.query(
      `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto) VALUES ($1,$2,'egreso',$3,$4) RETURNING id`,
      [fechaPago, p.cuenta_id, deCentavos(neto), `Liquidación ${p.nombre} del ${ddmm(desde)} al ${ddmm(hasta)}, cobrada fuera de la gestión: ${motivo}`.slice(0, 300)]);
    await c.query(`INSERT INTO fin.clasificacion (movimiento_id, rubro_id) VALUES ($1, (SELECT id FROM fin.rubro WHERE clave = 'fuera'))`, [m.id]);
    const { rows: [lote] } = await c.query('INSERT INTO fin.lote (procesador_id, fecha, pagos, bruto, neto, movimiento_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [p.id, fechaPago, cobros.length, deCentavos(suma(cobros.map(x => centavos(x.importe)))), deCentavos(neto), m.id]);
    await c.query('UPDATE pos.ticket_pago SET lote_id = $1 WHERE id = ANY($2::uuid[])', [lote.id, cobros.map(x => x.id)]);
    const { rows: [liq] } = await c.query(
      `INSERT INTO fin.liquidacion (procesador_id, desde, hasta, fecha_pago, calculado, total, fuera_gestion, motivo, lote_id) VALUES ($1,$2,$3,$4,$5,$5,true,$6,$7) RETURNING id`,
      [p.id, desde, hasta, fechaPago, deCentavos(neto), motivo, lote.id]);
    return { id: liq.id, neto: deCentavos(neto), pedidos: cobros.length };
  });
  res.status(201).json({ ok: true, ...out });
}));

// Sin extracto del banco donde deposita (SANTANDER de SORELLE): el pago se confirma con lo que dice el portal, en la fecha
// en que se procesó. Cuando llegue el extracto, la línea se concilia con este movimiento.
r.post('/fin/liquidaciones/:id/confirmar', h(async (req, res) => {
  const f = fecha(req.body.fecha, { campo: 'la fecha del pago', requerido: true });
  await enTransaccion(async c => {
    const { rows: [l] } = await c.query('SELECT l.*, lo.movimiento_id FROM fin.liquidacion l JOIN fin.lote lo ON lo.id = l.lote_id WHERE l.id = $1::uuid FOR UPDATE OF l', [req.params.id]);
    if (!l) throw new ErrorUsuario('No existe esa liquidación.', 404);
    if (l.movimiento_id) throw new ErrorUsuario('Esa liquidación ya está acreditada.');
    await asentarLote(c, l.lote_id, f);
  });
  res.json({ ok: true });
}));

// Deshacer una liquidación todavía no acreditada (o una "fuera de la gestión"): se anulan las facturas (la compensación y la
// factura en la cuenta corriente) y los costos, y los cobros vuelven a quedar por liquidar.
r.delete('/fin/liquidaciones/:id', h(async (req, res) => {
  const motivo = texto(req.body.motivo) || 'Se deshizo la liquidación';
  await enTransaccion(async c => {
    const { rows: [l] } = await c.query(
      `SELECT l.*, lo.movimiento_id, EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.movimiento_id = lo.movimiento_id) AS conciliada
         FROM fin.liquidacion l JOIN fin.lote lo ON lo.id = l.lote_id WHERE l.id = $1::uuid FOR UPDATE OF l`, [req.params.id]);
    if (!l) throw new ErrorUsuario('No existe esa liquidación.', 404);
    if (l.conciliada) throw new ErrorUsuario('El pago ya está conciliado con el extracto: deshacé primero esa conciliación.');
    const anular = async id => {
      const { rows: patas } = await c.query(
        `SELECT * FROM fin.movimiento_tes x WHERE (x.id = $1 OR x.transferencia_id = (SELECT transferencia_id FROM fin.movimiento_tes WHERE id = $1))
            AND x.tipo <> 'anulacion' AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = x.id)`, [id]);
      for (const p of patas)
        await c.query(`INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, transferencia_id, anula_a) VALUES ($1,$2,'anulacion',$3,$4,$5,$6,$7)`,
          [p.fecha, p.cuenta_id, p.salida, p.entrada, `Anula: ${p.concepto || p.tipo} — ${motivo}`.slice(0, 300), p.transferencia_id, p.id]);
    };
    if (l.movimiento_id) await anular(l.movimiento_id);   // el pago confirmado con el portal, o el egreso de "fuera de la gestión"
    const { rows: costos } = await c.query('SELECT movimiento_id FROM fin.liquidacion_costo WHERE liquidacion_id = $1', [l.id]);
    for (const x of costos) await anular(x.movimiento_id);
    const { rows: comps } = await c.query(
      `SELECT lc.*, m.proveedor_id, m.detalle FROM fin.liquidacion_comprobante lc JOIN fin.movimiento_cc m ON m.id = lc.cc_movimiento_id WHERE lc.liquidacion_id = $1`, [l.id]);
    for (const x of comps) {
      await c.query(`INSERT INTO fin.movimiento_cc (fecha, proveedor_id, tipo, comprobante_id, debe, haber, detalle, anula_a) VALUES (current_date, $1, 'anulacion', $2, 0, $3, $4, $5)`,
        [x.proveedor_id, x.comprobante_id, x.importe, `Anula: ${x.detalle} — ${motivo}`.slice(0, 300), x.cc_movimiento_id]);
      await c.query('DELETE FROM fin.liquidacion_comprobante WHERE comprobante_id = $1', [x.comprobante_id]);
      await c.query('SELECT fin.anular_comprobante($1::uuid, $2)', [x.comprobante_id, motivo]);
    }
    await c.query('DELETE FROM fin.liquidacion_costo WHERE liquidacion_id = $1', [l.id]);
    await c.query('DELETE FROM fin.liquidacion WHERE id = $1', [l.id]);
    await c.query('UPDATE pos.ticket_pago SET lote_id = NULL WHERE lote_id = $1', [l.lote_id]);
    await c.query('DELETE FROM fin.lote WHERE id = $1', [l.lote_id]);
  });
  res.json({ ok: true });
}));

module.exports = r;
module.exports.calcular = calcular;
