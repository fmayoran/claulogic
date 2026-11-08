// API de tesorería: cuentas (bancos, cajas, cartera), movimientos, arqueos, cheques, órdenes de pago
// y conciliación bancaria. Todo /fin exige permiso de finanzas (auth.js); lo que mueve plata lo
// vuelve a verificar la base, que es donde se asientan los movimientos.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, monto, texto, fecha, h, enTransaccion } = require('./util');
const { aplicarReglas, crearRegla, rubroValido } = require('./resultados');
const crypto = require('./crypto');
const pago24 = require('./pago24');
// Plata exacta en centavos (BigInt) para sumar importes en texto sin pasar por float.
const centavos = v => { const s = String(v), neg = s.startsWith('-'), [e, d = ''] = s.replace('-', '').split('.'); const c = BigInt(e || '0') * 100n + BigInt((d + '00').slice(0, 2)); return neg ? -c : c; };
const deCentavos = c => { const a = c < 0n ? -c : c; return (c < 0n ? '-' : '') + String(a / 100n) + '.' + String(a % 100n).padStart(2, '0'); };

const r = express.Router();

const nroOP = n => 'OP-' + String(n).padStart(6, '0');
const nroComp = c => `${{ factura: 'FC', nota_debito: 'ND', nota_credito: 'NC' }[c.tipo]} ${c.letra} ${String(c.punto_venta).padStart(5, '0')}-${String(c.numero).padStart(8, '0')}`;
const importe = (v, campo) => monto(v, { campo, requerido: true, positivo: true });

// ── Cuentas ──────────────────────────────────────────────────────────────────────────────────
r.get('/fin/cuentas', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.tipo, c.sede_id, s.nombre AS sede, c.sociedad_id, so.nombre AS sociedad, c.banco, c.numero, c.cbu, c.alias, c.activa,
            sc.saldo::text, sc.ultimo_movimiento,
            COALESCE((SELECT SUM(importe) FROM fin.cheque ch WHERE ch.cuenta_id = c.id AND ch.tipo = 'propio' AND ch.estado = 'emitido'), 0)::text AS cheques_pendientes,
            (sc.saldo - COALESCE((SELECT SUM(importe) FROM fin.cheque ch WHERE ch.cuenta_id = c.id AND ch.tipo = 'propio' AND ch.estado = 'emitido'), 0))::text AS proyectado,
            (SELECT COUNT(*)::int FROM fin.extracto_linea l WHERE l.cuenta_id = c.id
                AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)) AS lineas_sin_conciliar,
            -- Para qué es la cuenta: la "a acreditar" de un procesador, donde deposita uno, o el efectivo de un punto de venta.
            (SELECT pr.nombre FROM fin.procesador pr WHERE pr.cuenta_id = c.id LIMIT 1) AS procesador_pendiente,
            (SELECT string_agg(pr.nombre, ', ' ORDER BY pr.nombre) FROM fin.procesador pr WHERE pr.cuenta_acredita_id = c.id) AS procesador_deposita,
            (SELECT i.nombre FROM pos.integracion i WHERE i.cuenta_efectivo_id = c.id ORDER BY i.sistema = 'pedidosya' LIMIT 1) AS punto_venta
       FROM fin.cuenta c
       JOIN fin.saldo_cuenta sc ON sc.cuenta_id = c.id
       LEFT JOIN org.sede s ON s.id = c.sede_id LEFT JOIN org.sociedad so ON so.id = c.sociedad_id
      ORDER BY c.activa DESC, CASE c.tipo WHEN 'banco' THEN 1 WHEN 'caja' THEN 2 ELSE 3 END, s.nombre NULLS FIRST, c.nombre`);
  res.json({ ok: true, cuentas: rows });
}));

// Lo cobrado con cada procesador que todavía no llegó a la cuenta donde deposita, por punto de venta: los cobros ya
// procesados, sin acreditar con el extracto ni en un lote confirmado. Para el tablero de Cajas y bancos, que lo reparte por la
// filial del punto de venta: una cuenta de cobro compartida (la cafetería y el bodegón de SORELLE) no es toda de la filial de la cuenta.
r.get('/fin/tesoreria/por-acreditar', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pr.id AS procesador_id, pr.nombre AS procesador, pr.cuenta_id, i.id AS integracion_id, i.nombre AS punto_venta, i.sede_id,
            (SELECT s.sociedad_id FROM org.sede s WHERE s.id = i.sede_id) AS sociedad_id,
            COUNT(*)::int AS pagos, SUM(CASE WHEN p.costos IS NOT NULL THEN p.neto ELSE p.importe END)::text AS importe, to_char(MIN(t.dia), 'YYYY-MM-DD') AS desde,
            COUNT(*) FILTER (WHERE p.lote_id IS NOT NULL)::int AS en_lote
       FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
       JOIN pos.medio m ON m.id = p.medio_id JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id JOIN fin.procesador pr ON pr.id = mp.procesador_id
      WHERE p.cobro_id IS NOT NULL AND NOT p.anulado AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL
        AND (p.lote_id IS NULL OR EXISTS (SELECT 1 FROM fin.lote l WHERE l.id = p.lote_id AND l.movimiento_id IS NULL))
      GROUP BY pr.id, pr.nombre, pr.cuenta_id, i.id, i.nombre ORDER BY pr.nombre, i.nombre`);
  res.json({ ok: true, por_acreditar: rows });
}));

// Cuándo entra lo que falta acreditar (los mismos cobros que /por-acreditar), por fecha y por el neto. Fudo Pagos informa
// por cobro la fecha de liquidación y el neto: eso es INFORMADO, y un lote esperado entra el día de su liquidación. Para
// los demás se ESTIMA con lo que ya se acreditó: la demora es la mediana de días entre la venta y el depósito (extracto o
// lote confirmado) del mismo procesador y tipo de operación, o del procesador si ese tipo no tiene historia; el neto,
// con el costo real por tipo (`resumenProcesador`). Sin historia, la fecha es el día siguiente a la venta y el neto, el
// bruto. Lo que debía entrar antes de hoy y no llegó va aparte, atrasado. No guarda nada: se deriva cada vez.
const sumarDias = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function porCobrar({ porSede = false, detalle = false } = {}) {
  const [{ rows: [{ hoy }] }, { rows: pagos }, { rows: demoras }, { rows: procs }, { rows: exts }] = await Promise.all([
    pool.query(`SELECT to_char(current_date, 'YYYY-MM-DD') AS hoy`),
    pool.query(
      `SELECT pr.id AS procesador_id, pr.nombre AS procesador, pr.cuenta_acredita_id, i.nombre AS punto_venta, i.sede_id,
              (SELECT s.sociedad_id FROM org.sede s WHERE s.id = i.sede_id) AS sociedad_id, mp.tipo_operacion, to_char(t.dia, 'YYYY-MM-DD') AS dia,
              p.importe::text, p.neto::text, to_char(COALESCE(l.fecha, p.liquida_el), 'YYYY-MM-DD') AS liquida_el, l.id IS NOT NULL AS en_lote,
              p.costos IS NOT NULL AS con_costos
         FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
         JOIN pos.medio m ON m.id = p.medio_id JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id JOIN fin.procesador pr ON pr.id = mp.procesador_id
         LEFT JOIN fin.lote l ON l.id = p.lote_id
        WHERE p.cobro_id IS NOT NULL AND NOT p.anulado AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL AND (p.lote_id IS NULL OR l.movimiento_id IS NULL)`),
    pool.query(
      `WITH h AS (
         SELECT mp.procesador_id, mp.tipo_operacion, (x.fecha - t.dia) AS d
           FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
           JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id JOIN fin.extracto_linea x ON x.id = p.acreditado_linea_id
          WHERE NOT p.anulado
         UNION ALL
         SELECT mp.procesador_id, mp.tipo_operacion, (mv.fecha - t.dia)
           FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
           JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id JOIN fin.lote lo ON lo.id = p.lote_id JOIN fin.movimiento_tes mv ON mv.id = lo.movimiento_id
          WHERE NOT p.anulado)
       SELECT procesador_id, tipo_operacion, percentile_disc(0.5) WITHIN GROUP (ORDER BY d) AS dias, COUNT(*)::int AS muestras
         FROM h WHERE d >= 0 GROUP BY GROUPING SETS ((procesador_id, tipo_operacion), (procesador_id))`),
    pool.query('SELECT id, nombre, cuenta_acredita_id FROM fin.procesador WHERE cuenta_acredita_id IS NOT NULL'),
    // Hasta dónde llega el extracto de cada cuenta donde deposita un procesador: lo que se esperaba antes de esa fecha y no
    // apareció hay que revisarlo; lo de después, todavía no puede estar.
    pool.query(`SELECT c.id, c.nombre, to_char(MAX(e.hasta), 'YYYY-MM-DD') AS hasta FROM fin.cuenta c
                  LEFT JOIN fin.extracto e ON e.cuenta_id = c.id
                 WHERE c.id IN (SELECT cuenta_acredita_id FROM fin.procesador WHERE cuenta_acredita_id IS NOT NULL) GROUP BY c.id`),
  ]);
  const extDe = new Map(exts.map(e => [e.id, e]));
  const det = new Map();
  // Costo real por tipo de operación (en centésimos de punto), del resumen de cada procesador; sin tipo, el del procesador.
  const costo = new Map();
  for (const pr of procs) {
    const rs = await resumenProcesador(pr.cuenta_acredita_id);
    const acc = new Map();
    for (const c of rs ? rs.costos : []) for (const k of [c.tipo_operacion, '']) {
      const a = acc.get(k) || { b: 0n, c: 0n }; a.b += centavos(c.bruto); a.c += centavos(c.costo); acc.set(k, a);
    }
    for (const [k, a] of acc) if (a.b > 0n) costo.set(pr.id + '|' + k, a.c * 10000n / a.b);
  }
  const demora = new Map(demoras.map(d => [d.procesador_id + '|' + (d.tipo_operacion || ''), { dias: Number(d.dias), muestras: d.muestras }]));
  const usadas = new Map();
  const dias = new Map(), atrasado = new Map();
  let tot = { pagos: 0, bruto: 0n, neto: 0n };
  for (const p of pagos) {
    let fecha, neto, fuente;
    const bruto = centavos(p.importe);
    if (p.liquida_el && p.neto != null) { fecha = p.liquida_el; neto = centavos(p.neto); fuente = 'informado'; }
    else {
      const dm = demora.get(p.procesador_id + '|' + p.tipo_operacion) || demora.get(p.procesador_id + '|');
      const cp = costo.get(p.procesador_id + '|' + p.tipo_operacion) ?? costo.get(p.procesador_id + '|') ?? null;
      fecha = p.liquida_el || sumarDias(p.dia, dm ? dm.dias : 1);
      // Con el neto informado por pago (PedidosYa, sin fecha de liquidación), el neto es ése.
      neto = p.neto != null ? centavos(p.neto) : cp == null ? bruto : bruto - bruto * cp / 10000n;
      fuente = dm ? 'estimado' : 'sin_historia';
      const k = p.procesador + '|' + p.tipo_operacion;
      if (!usadas.has(k)) usadas.set(k, { procesador: p.procesador, tipo_operacion: p.tipo_operacion, dias: dm ? dm.dias : null,
        muestras: dm ? dm.muestras : 0, costo_pct: cp == null ? null : (Number(cp) / 100).toFixed(2) });
    }
    tot.pagos++; tot.bruto += bruto; tot.neto += neto;
    // Con `detalle`, por qué no entró todavía (pedido de Fer, 07/11/2026: ver de dónde tiene que venir lo que falta cobrar):
    // sin cuenta donde deposita, liquidado en un lote que espera el banco, todavía no es la fecha, el extracto no llega a esa
    // fecha, o el extracto ya la cubre y no apareció (hay que revisarlo en la conciliación).
    if (detalle) {
      const ext = p.cuenta_acredita_id ? extDe.get(p.cuenta_acredita_id) : null;
      // Como la conciliación (que parea del día de la venta, o de su liquidación, hasta 4 días después): un cobro es para
      // revisar recién cuando el extracto pasó ese margen (08/11/2026: el tablero marcaba cobros del día anterior que la
      // conciliación todavía no mostraba). `limite`: hasta cuándo puede aparecer.
      const limite = [fecha, sumarDias(p.liquida_el || p.dia, 4)].sort()[1];
      const estado = !p.cuenta_acredita_id ? 'sin_deposito' : p.en_lote ? 'lote' : fecha >= hoy ? 'por_venir'
        : !ext || !ext.hasta || limite > ext.hasta ? 'falta_extracto' : 'revisar';
      const k = p.procesador_id + '|' + p.punto_venta + '|' + estado;
      const g = det.get(k) || { procesador_id: p.procesador_id, procesador: p.procesador, deposita: ext ? ext.nombre : null, extracto_hasta: ext ? ext.hasta : null,
        punto_venta: p.punto_venta, sede_id: p.sede_id, sociedad_id: p.sociedad_id, estado, pagos: 0, bruto: 0n, neto: 0n, saldo: 0n, ventas_desde: p.dia, ventas_hasta: p.dia, espera_desde: fecha, espera_hasta: fecha , limite };
      // `saldo`: lo que el cobro pesa en la cuenta "a acreditar" (PedidosYa asienta sus costos al cobrar: queda el neto).
      g.pagos++; g.bruto += bruto; g.neto += neto; g.saldo += p.con_costos ? centavos(p.neto) : bruto;
      if (p.dia < g.ventas_desde) g.ventas_desde = p.dia; if (p.dia > g.ventas_hasta) g.ventas_hasta = p.dia;
      if (fecha < g.espera_desde) g.espera_desde = fecha; if (fecha > g.espera_hasta) g.espera_hasta = fecha;
      if (limite > g.limite) g.limite = limite;
      det.set(k, g);
    }
    // Con `porSede`, cada renglón es además de una filial (la del punto de venta), para mostrarlo por filial en Cajas y bancos.
    const destino = fecha < hoy ? atrasado : dias, clave = (fecha < hoy ? '' : fecha) + '|' + p.procesador + '|' + fuente + (porSede ? '|' + p.sede_id : '');
    const g = destino.get(clave) || { fecha: fecha < hoy ? null : fecha, desde: fecha, procesador: p.procesador, fuente, pagos: 0, bruto: 0n, neto: 0n, en_lote: 0,
      ...(porSede ? { sede_id: p.sede_id, sociedad_id: p.sociedad_id } : {}) };
    g.pagos++; g.bruto += bruto; g.neto += neto; if (p.en_lote) g.en_lote++; if (fecha < g.desde) g.desde = fecha;
    destino.set(clave, g);
  }
  const salida = g => ({ ...g, bruto: deCentavos(g.bruto), neto: deCentavos(g.neto) });
  return {
    hoy, pagos: tot.pagos, bruto: deCentavos(tot.bruto), neto: deCentavos(tot.neto),
    dias: [...dias.values()].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.procesador.localeCompare(b.procesador)).map(salida),
    atrasado: [...atrasado.values()].sort((a, b) => a.desde.localeCompare(b.desde)).map(salida),
    estimaciones: [...usadas.values()].sort((a, b) => a.procesador.localeCompare(b.procesador) || a.tipo_operacion.localeCompare(b.tipo_operacion)),
    ...(detalle ? { detalle: [...det.values()].sort((a, b) => a.procesador.localeCompare(b.procesador) || a.punto_venta.localeCompare(b.punto_venta))
      .map(g => ({ ...salida(g), saldo: deCentavos(g.saldo) })) } : {}),
  };
}
r.get('/fin/tesoreria/por-cobrar', h(async (req, res) => {
  res.json({ ok: true, ...(await porCobrar({ porSede: req.query.por_sede === '1', detalle: req.query.detalle === '1' })) });
}));

// Tablero de Cajas y bancos (pedido de Fer, 03/11/2026, con el estilo del de ventas). No guarda nada: sale de `fin.movimiento_tes`.
// Lo DISPONIBLE son los bancos y cajas (también las cuentas donde depositan los procesadores), sin el efectivo de los puntos de
// venta, de la filial elegida (la sede de la cuenta; 'sin' = las que no tienen). Entradas y salidas son lo que entra o sale de ese
// conjunto: una transferencia entre dos cuentas disponibles no es flujo, una desde "a acreditar" es una acreditación y una desde el
// efectivo de un punto de venta, una rendición. Una anulación resta en la categoría de lo que anula, en su fecha, así el saldo
// inicial más entradas menos salidas da el final. El saldo de apertura de un extracto no es flujo (se informa aparte).
const CATEGORIA_TES = `
  WITH esc AS (
    SELECT c.id FROM fin.cuenta c
     WHERE c.tipo IN ('banco', 'caja') AND NOT EXISTS (SELECT 1 FROM pos.integracion i WHERE i.cuenta_efectivo_id = c.id)
       AND ($1::text = '' OR ($1 = 'sin' AND c.sociedad_id IS NULL) OR c.sociedad_id::text = $1)),
  -- MATERIALIZED: sin eso Postgres repite la búsqueda de la otra pata en cada lugar donde se nombra "otra" (14 s con octubre).
  m AS MATERIALIZED (
    SELECT m.id, m.fecha, m.cuenta_id, m.concepto, m.anula_a IS NOT NULL AS anulacion, b.tipo, b.gasto, b.entrada > 0 AS es_entrada,
           CASE WHEN b.entrada > 0 THEN m.entrada - m.salida ELSE m.salida - m.entrada END AS valor,
           b.orden_pago_id, b.cheque_id, b.concepto AS concepto_base, b.id AS base_id,
           (SELECT t.cuenta_id FROM fin.movimiento_tes t WHERE t.transferencia_id = b.transferencia_id AND t.id <> b.id
               AND t.anula_a IS NULL AND (t.entrada > 0) <> (b.entrada > 0) LIMIT 1) AS otra
      FROM fin.movimiento_tes m JOIN fin.movimiento_tes b ON b.id = COALESCE(m.anula_a, m.id)
     WHERE m.cuenta_id IN (SELECT id FROM esc) AND m.fecha BETWEEN $2::date AND $3::date),
  k AS MATERIALIZED (
    SELECT m.*, oc.tipo AS otra_tipo, oc.nombre AS otra_nombre, ru.id AS rubro_id, ru.nombre AS rubro,
           (SELECT p.marca FROM fin.procesador p WHERE p.cuenta_id = m.otra LIMIT 1) AS marca,
           EXISTS (SELECT 1 FROM pos.integracion i WHERE i.cuenta_efectivo_id = m.otra) AS otra_efectivo,
           m.otra IN (SELECT id FROM esc) AS interna
      FROM m LEFT JOIN fin.cuenta oc ON oc.id = m.otra
      LEFT JOIN fin.clasificacion cl ON cl.movimiento_id = m.base_id LEFT JOIN fin.rubro ru ON ru.id = cl.rubro_id),
  cat AS (
    SELECT k.*, CASE
        WHEN concepto_base = 'Saldo de apertura según extracto' THEN 'apertura'
        WHEN interna THEN 'interna'
        WHEN otra IS NOT NULL AND otra_tipo = 'cobranza' THEN 'acr:' || COALESCE(marca, 'otro')
        WHEN otra IS NOT NULL AND otra_efectivo THEN 'efectivo'
        WHEN otra IS NOT NULL THEN 'transf'
        WHEN rubro_id IS NOT NULL THEN 'rubro:' || rubro_id
        WHEN gasto IS NOT NULL THEN 'gasto:' || gasto
        WHEN orden_pago_id IS NOT NULL OR cheque_id IS NOT NULL THEN 'proveedores'
        WHEN tipo = 'cobro' THEN 'cobro'
        WHEN tipo = 'arqueo' THEN 'arqueo'
        ELSE 'sin' END AS cat
      FROM k)`;
const NOMBRE_CAT = { apertura: 'Saldo de apertura', efectivo: 'Rendiciones de efectivo', proveedores: 'Pagos a proveedores', cobro: 'Cobros de ventas',
  arqueo: 'Arqueos de caja', 'gasto:comision': 'Comisiones', 'gasto:iva_credito': 'IVA de comisiones', 'gasto:imp_debitos_creditos': 'Impuesto a los débitos y créditos',
  'gasto:retencion': 'Retenciones', 'gasto:otro': 'Otros gastos de cobro' };
const MARCA_NOMBRE = { mercadopago: 'Mercado Pago', pago24: 'Pago24', fudo: 'Fudo Pagos', getnet: 'Getnet', pedidosya: 'PedidosYa', otro: 'otros procesadores' };
const nombreCat = (cat, entrada, rubro) => cat.startsWith('acr:') ? `Acreditaciones ${MARCA_NOMBRE[cat.slice(4)] || cat.slice(4)}`
  : cat.startsWith('rubro:') ? rubro : cat === 'transf' ? (entrada ? 'Transferencias recibidas' : 'Transferencias a otras cuentas')
  : cat === 'sin' ? (entrada ? 'Otros ingresos sin clasificar' : 'Sin clasificar') : NOMBRE_CAT[cat] || cat;
function filialTes(v) {
  const f = texto(v) || '';
  if (f && f !== 'sin' && !/^[0-9a-f-]{36}$/i.test(f)) throw new ErrorUsuario('Filial inválida.');
  return f;
}
async function flujoTes(filial, desde, hasta) {
  const [{ rows: [ini] }, { rows: dias }, { rows: cats }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(m.entrada - m.salida), 0)::text AS saldo FROM fin.movimiento_tes m JOIN fin.cuenta c ON c.id = m.cuenta_id
        WHERE c.tipo IN ('banco', 'caja') AND NOT EXISTS (SELECT 1 FROM pos.integracion i WHERE i.cuenta_efectivo_id = c.id)
          AND ($1::text = '' OR ($1 = 'sin' AND c.sociedad_id IS NULL) OR c.sociedad_id::text = $1) AND m.fecha < $2::date`, [filial, desde]),
    pool.query(`${CATEGORIA_TES}
      SELECT to_char(fecha, 'YYYY-MM-DD') AS dia,
             COALESCE(SUM(valor) FILTER (WHERE es_entrada AND cat NOT IN ('interna', 'apertura')), 0)::text AS entradas,
             COALESCE(SUM(valor) FILTER (WHERE NOT es_entrada AND cat NOT IN ('interna', 'apertura')), 0)::text AS salidas,
             COALESCE(SUM(CASE WHEN es_entrada THEN valor ELSE -valor END), 0)::text AS neto,
             COALESCE(SUM(CASE WHEN es_entrada THEN valor ELSE -valor END) FILTER (WHERE cat = 'apertura'), 0)::text AS apertura
        FROM cat GROUP BY fecha ORDER BY fecha`, [filial, desde, hasta]),
    pool.query(`${CATEGORIA_TES}
      SELECT es_entrada, cat, MIN(rubro) AS rubro, SUM(valor)::text AS importe, COUNT(*) FILTER (WHERE NOT anulacion)::int AS movimientos
        FROM cat WHERE cat NOT IN ('interna', 'apertura') GROUP BY es_entrada, cat HAVING SUM(valor) <> 0 ORDER BY SUM(valor) DESC`, [filial, desde, hasta]),
  ]);
  const tot = k => deCentavos(dias.reduce((t, d) => t + centavos(d[k]), 0n));
  return { desde, hasta, saldo_inicial: ini.saldo, entradas: tot('entradas'), salidas: tot('salidas'), apertura: tot('apertura'),
    saldo_final: deCentavos(centavos(ini.saldo) + dias.reduce((t, d) => t + centavos(d.neto), 0n)), dias,
    categorias: cats.map(c => ({ lado: c.es_entrada ? 'entrada' : 'salida', cat: c.cat, nombre: nombreCat(c.cat, c.es_entrada, c.rubro), importe: c.importe, movimientos: c.movimientos })) };
}
const sumarDiasTes = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
r.get('/fin/tesoreria/tablero', h(async (req, res) => {
  const filial = filialTes(req.query.filial);
  const desde = fecha(req.query.desde, { campo: 'Desde', requerido: true }), hasta = fecha(req.query.hasta, { campo: 'Hasta', requerido: true });
  if (desde > hasta) throw new ErrorUsuario('"Desde" es posterior a "hasta".');
  // El período anterior, de la misma duración y pegado al elegido.
  const largo = Math.round((Date.parse(hasta) - Date.parse(desde)) / 864e5) + 1;
  const [actual, anterior, { rows: donde }] = await Promise.all([flujoTes(filial, desde, hasta), flujoTes(filial, sumarDiasTes(desde, -largo), sumarDiasTes(desde, -1)),
    // Dónde está el disponible al cierre del período (pedido de Fer, 03/11/2026): el saldo de cada banco y caja a esa fecha.
    pool.query(
      `SELECT c.id, c.nombre, c.tipo, COALESCE(s.nombre, 'Grupo') AS sede, SUM(m.entrada - m.salida)::text AS saldo
         FROM fin.movimiento_tes m JOIN fin.cuenta c ON c.id = m.cuenta_id LEFT JOIN org.sociedad s ON s.id = c.sociedad_id
        WHERE c.tipo IN ('banco', 'caja') AND NOT EXISTS (SELECT 1 FROM pos.integracion i WHERE i.cuenta_efectivo_id = c.id)
          AND ($1::text = '' OR ($1 = 'sin' AND c.sociedad_id IS NULL) OR c.sociedad_id::text = $1) AND m.fecha <= $2::date
        GROUP BY c.id, s.nombre HAVING SUM(m.entrada - m.salida) <> 0 ORDER BY SUM(m.entrada - m.salida) DESC`, [filial, hasta])]);
  res.json({ ok: true, ...actual, anterior, donde });
}));
// Los movimientos detrás del tablero: los del período (un día, una categoría o un lado), sin las transferencias internas.
r.get('/fin/tesoreria/tablero/movimientos', h(async (req, res) => {
  const filial = filialTes(req.query.filial);
  const desde = fecha(req.query.desde, { campo: 'Desde', requerido: true }), hasta = fecha(req.query.hasta, { campo: 'Hasta', requerido: true });
  const lado = ['entrada', 'salida'].includes(req.query.lado) ? req.query.lado : null, cat = texto(req.query.cat);
  const { rows } = await pool.query(`${CATEGORIA_TES}
    SELECT cat.id, to_char(cat.fecha, 'YYYY-MM-DD') AS fecha, cat.cuenta_id, cu.nombre AS cuenta, cat.concepto, cat.cat, cat.rubro, cat.anulacion,
           CASE WHEN es_entrada THEN 'entrada' ELSE 'salida' END AS lado, cat.valor::text AS importe, cat.otra_nombre
      FROM cat JOIN fin.cuenta cu ON cu.id = cat.cuenta_id
     WHERE cat NOT IN ('interna', 'apertura') AND ($4::text IS NULL OR cat = $4) AND ($5::text IS NULL OR es_entrada = ($5 = 'entrada'))
     ORDER BY cat.fecha DESC, cat.id DESC LIMIT 1001`, [filial, desde, hasta, cat, lado]);
  res.json({ ok: true, recortado: rows.length > 1000,
    movimientos: rows.slice(0, 1000).map(m => ({ ...m, categoria: nombreCat(m.cat, m.lado === 'entrada', m.rubro) })) });
}));

function leerCuenta(b) {
  const c = {
    nombre: texto(b.nombre, { campo: 'el nombre', requerido: true }),
    tipo: texto(b.tipo, { campo: 'el tipo', requerido: true }),
    sede_id: texto(b.sede_id), banco: texto(b.banco), numero: texto(b.numero),
    // Sin el campo se conserva la que tenía (o, al crearla, la de su sede).
    sociedad_id: b.sociedad_id === undefined ? undefined : texto(b.sociedad_id),
    cbu: texto(b.cbu) && texto(b.cbu).replace(/\D/g, ''), alias: texto(b.alias),
    activa: b.activa === undefined ? true : !!b.activa,
  };
  // Cobranza: tarjetas, QR y billeteras a acreditar. Lo cobrado por el POS entra ahí y pasa al banco
  // con una transferencia cuando se acredita.
  if (!['banco', 'caja', 'cobranza'].includes(c.tipo)) throw new ErrorUsuario('El tipo es banco, caja o cobranza (la cartera de cheques ya existe).');
  if (c.tipo === 'caja' && !c.sede_id) throw new ErrorUsuario('Una caja es de una sede: elegila.');
  if (c.cbu && c.cbu.length !== 22) throw new ErrorUsuario('El CBU tiene 22 dígitos.');
  return c;
}

r.post('/fin/cuentas', h(async (req, res) => {
  const c = leerCuenta(req.body);
  const { rows: [n] } = await pool.query(
    `INSERT INTO fin.cuenta (nombre, tipo, sede_id, banco, numero, cbu, alias, activa, sociedad_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::uuid, (SELECT sociedad_id FROM org.sede WHERE id = $3::uuid))) RETURNING id`,
    [c.nombre, c.tipo, c.sede_id, c.banco, c.numero, c.cbu, c.alias, c.activa, c.sociedad_id ?? null]);
  res.status(201).json({ ok: true, id: n.id });
}));

// Una cuenta con saldo no se desactiva, y una con movimientos no cambia de tipo: los movimientos
// pasarían a significar otra cosa.
r.put('/fin/cuentas/:id', h(async (req, res) => {
  const c = leerCuenta(req.body);
  await enTransaccion(async cn => {
    const { rows: [ant] } = await cn.query(
      `SELECT c.tipo, sc.saldo, EXISTS (SELECT 1 FROM fin.movimiento_tes m WHERE m.cuenta_id = c.id) AS con_movs
         FROM fin.cuenta c JOIN fin.saldo_cuenta sc ON sc.cuenta_id = c.id WHERE c.id = $1::uuid FOR UPDATE OF c`, [req.params.id]);
    if (!ant) throw new ErrorUsuario('No existe esa cuenta.', 404);
    if (ant.tipo === 'cartera') throw new ErrorUsuario('La cartera de cheques no se edita.');
    if (ant.con_movs && ant.tipo !== c.tipo) throw new ErrorUsuario('La cuenta tiene movimientos: no cambia de tipo.');
    if (!c.activa && Number(ant.saldo) !== 0) throw new ErrorUsuario('La cuenta tiene saldo: transferilo antes de desactivarla.');
    await cn.query(`UPDATE fin.cuenta SET nombre=$1, tipo=$2, sede_id=$3, banco=$4, numero=$5, cbu=$6, alias=$7, activa=$8,
                           sociedad_id = CASE WHEN $11 THEN sociedad_id ELSE COALESCE($10::uuid, (SELECT sociedad_id FROM org.sede WHERE id = $3::uuid)) END WHERE id=$9`,
      [c.nombre, c.tipo, c.sede_id, c.banco, c.numero, c.cbu, c.alias, c.activa, req.params.id, c.sociedad_id ?? null, c.sociedad_id === undefined]);
  });
  res.json({ ok: true, id: req.params.id });
}));

r.get('/fin/cuentas/:id/movimientos', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT m.id, m.fecha, m.ocurrido_en, m.tipo, m.entrada::text, m.salida::text, m.concepto, m.orden_pago_id,
              m.cheque_id, m.transferencia_id, m.anula_a, m.registrado_por,
              SUM(m.entrada - m.salida) OVER (ORDER BY m.fecha, m.id)::text AS saldo,
              EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.movimiento_id = m.id) AS conciliado,
              EXISTS (SELECT 1 FROM fin.movimiento_tes x WHERE x.anula_a = m.id) AS anulado
         FROM fin.movimiento_tes m WHERE m.cuenta_id = $1::uuid) t
      WHERE ($2::date IS NULL OR fecha >= $2) AND ($3::date IS NULL OR fecha <= $3)
      ORDER BY fecha, id`,
    [req.params.id, fecha(req.query.desde, { campo: 'Desde' }), fecha(req.query.hasta, { campo: 'Hasta' })]);
  res.json({ ok: true, movimientos: rows });
}));

// ── Movimientos manuales, transferencias y arqueos ───────────────────────────────────────────
r.post('/fin/transferencias', h(async (req, res) => {
  const b = req.body;
  await pool.query('SELECT fin.transferir($1::uuid, $2::uuid, $3::numeric, COALESCE($4::date, current_date), $5)',
    [texto(b.origen_id, { campo: 'la cuenta de origen', requerido: true }), texto(b.destino_id, { campo: 'la cuenta de destino', requerido: true }),
     importe(b.importe, 'El importe'), fecha(b.fecha, { campo: 'Fecha' }), texto(b.concepto) || 'Transferencia entre cuentas']);
  res.status(201).json({ ok: true });
}));

// Ingresos y egresos que no son pagos a proveedores: comisiones, impuestos bancarios, aportes,
// gastos de caja. El concepto es obligatorio: un egreso sin explicación es lo que no se puede auditar.
r.post('/fin/movimientos', h(async (req, res) => {
  const b = req.body;
  const tipo = texto(b.tipo, { campo: 'el tipo', requerido: true });
  if (!['ingreso', 'egreso'].includes(tipo)) throw new ErrorUsuario('El tipo es ingreso o egreso.');
  const cuenta = texto(b.cuenta_id, { campo: 'la cuenta', requerido: true });
  const { rows: [c] } = await pool.query('SELECT tipo FROM fin.cuenta WHERE id = $1::uuid', [cuenta]);
  if (!c) throw new ErrorUsuario('No existe esa cuenta.');
  if (c.tipo === 'cartera') throw new ErrorUsuario('La cartera de cheques se mueve cheque por cheque.');
  const imp = importe(b.importe, 'El importe');
  const { rows: [m] } = await pool.query(
    `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto)
     VALUES (COALESCE($1::date, current_date),$2,$3,$4,$5,$6) RETURNING id`,
    [fecha(b.fecha, { campo: 'Fecha' }), cuenta, tipo, tipo === 'ingreso' ? imp : 0, tipo === 'egreso' ? imp : 0,
     texto(b.concepto, { campo: 'el concepto', requerido: true })]);
  res.status(201).json({ ok: true, id: m.id });
}));

// Se anulan los movimientos manuales y las transferencias (las dos patas). Los de una orden de
// pago, un cheque o un arqueo se corrigen desde su documento.
r.post('/fin/movimientos/:id/anular', h(async (req, res) => {
  const motivo = texto(req.body.motivo, { campo: 'el motivo', requerido: true });
  await enTransaccion(async c => {
    const { rows: [m] } = await c.query('SELECT * FROM fin.movimiento_tes WHERE id = $1', [req.params.id]);
    if (!m) throw new ErrorUsuario('No existe ese movimiento.');
    if (!['ingreso', 'egreso', 'transferencia'].includes(m.tipo))
      throw new ErrorUsuario('Ese movimiento es de una orden de pago, un cheque o un arqueo: se corrige desde ahí.');
    if (m.ticket_pago_id || m.gasto)
      throw new ErrorUsuario('Ese movimiento lo creó la conciliación de un procesador: se deshace desde Conciliación (Deshacer en su línea).');
    const { rows: patas } = await c.query(
      m.transferencia_id ? 'SELECT * FROM fin.movimiento_tes WHERE transferencia_id = $1 AND anula_a IS NULL AND tipo <> \'anulacion\'' : 'SELECT * FROM fin.movimiento_tes WHERE id = $1',
      [m.transferencia_id || m.id]);
    for (const p of patas)
      await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, transferencia_id, anula_a)
         VALUES (current_date, $1, 'anulacion', $2, $3, $4, $5, $6)`,
        [p.cuenta_id, p.salida, p.entrada, 'Anula: ' + (p.concepto || p.tipo) + ' — ' + motivo, p.transferencia_id, p.id]);
  });
  res.json({ ok: true });
}));

r.post('/fin/arqueos', h(async (req, res) => {
  const b = req.body;
  const { rows: [{ id }] } = await pool.query('SELECT fin.arquear($1::uuid, $2::numeric, $3) AS id',
    [texto(b.cuenta_id, { campo: 'la caja', requerido: true }),
     monto(b.contado, { campo: 'Lo contado', requerido: true }), texto(b.motivo, { campo: 'el motivo', requerido: true })]);
  const { rows: [a] } = await pool.query('SELECT sistema::text, contado::text, diferencia::text FROM fin.arqueo WHERE id = $1', [id]);
  res.status(201).json({ ok: true, arqueo: a });
}));

r.get('/fin/arqueos', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.ocurrido_en, c.nombre AS cuenta, a.sistema::text, a.contado::text, a.diferencia::text, a.motivo, a.registrado_por
       FROM fin.arqueo a JOIN fin.cuenta c ON c.id = a.cuenta_id
      WHERE ($1::uuid IS NULL OR a.cuenta_id = $1) ORDER BY a.ocurrido_en DESC LIMIT 100`, [texto(req.query.cuenta)]);
  res.json({ ok: true, arqueos: rows });
}));

// ── Cheques ──────────────────────────────────────────────────────────────────────────────────
r.get('/fin/cheques', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ch.id, ch.tipo, ch.formato, ch.banco, ch.numero, ch.librador, ch.cuit_librador, ch.importe::text,
            ch.fecha_emision, ch.fecha_pago, (ch.fecha_pago - current_date) AS dias, ch.estado, ch.recibido_de, ch.notas,
            ch.cuenta_id, cu.nombre AS cuenta, ch.proveedor_id, pv.nombre AS proveedor, ch.orden_pago_id, op.numero AS op_numero
       FROM fin.cheque ch
       LEFT JOIN fin.cuenta cu ON cu.id = ch.cuenta_id
       LEFT JOIN logic.proveedor pv ON pv.id = ch.proveedor_id
       LEFT JOIN fin.orden_pago op ON op.id = ch.orden_pago_id
      WHERE ($1::text IS NULL OR ch.tipo = $1) AND ($2::text IS NULL OR ch.estado = $2)
      ORDER BY ch.fecha_pago, ch.creado_en LIMIT 500`, [texto(req.query.tipo), texto(req.query.estado)]);
  res.json({ ok: true, cheques: rows.map(c => ({ ...c, op: c.op_numero && nroOP(c.op_numero) })) });
}));

r.post('/fin/cheques', h(async (req, res) => {
  const b = req.body;
  const formato = texto(b.formato) || 'fisico';
  if (!['fisico', 'echeq'].includes(formato)) throw new ErrorUsuario('El formato es físico o e-cheq.');
  const { rows: [{ id }] } = await pool.query(
    'SELECT fin.ingresar_cheque($1, $2, $3, $4, $5, $6::numeric, $7::date, $8::date, $9, $10) AS id',
    [formato, texto(b.banco, { campo: 'el banco', requerido: true }), texto(b.numero, { campo: 'el número', requerido: true }),
     texto(b.librador), texto(b.cuit_librador), importe(b.importe, 'El importe'), fecha(b.fecha_emision, { campo: 'Emisión' }),
     fecha(b.fecha_pago, { campo: 'Fecha de pago', requerido: true }), texto(b.recibido_de), texto(b.notas)]);
  res.status(201).json({ ok: true, id });
}));

r.post('/fin/cheques/:id/depositar', h(async (req, res) => {
  await pool.query('SELECT fin.depositar_cheque($1::uuid, $2::uuid, COALESCE($3::date, current_date))',
    [req.params.id, texto(req.body.cuenta_id, { campo: 'el banco', requerido: true }), fecha(req.body.fecha, { campo: 'Fecha' })]);
  res.json({ ok: true });
}));

r.post('/fin/cheques/:id/debitar', h(async (req, res) => {
  await pool.query('SELECT fin.debitar_cheque($1::uuid, COALESCE($2::date, current_date))', [req.params.id, fecha(req.body.fecha, { campo: 'Fecha' })]);
  res.json({ ok: true });
}));

// ── Órdenes de pago ──────────────────────────────────────────────────────────────────────────
r.get('/fin/ordenes-pago', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.id, o.numero, o.fecha, o.estado, o.proveedor_id, pv.nombre AS proveedor, o.sociedad_id, so.nombre AS sociedad,
            COALESCE(o.total_valores + o.total_retenciones,
                     (SELECT SUM(importe) FROM fin.orden_pago_valor v WHERE v.orden_pago_id = o.id), 0)::text AS total
       FROM fin.orden_pago o JOIN logic.proveedor pv ON pv.id = o.proveedor_id JOIN org.sociedad so ON so.id = o.sociedad_id
      WHERE ($1::uuid IS NULL OR o.proveedor_id = $1) AND ($2::text IS NULL OR o.estado = $2) AND ($3::uuid IS NULL OR o.sociedad_id = $3)
      ORDER BY o.fecha DESC, o.numero DESC LIMIT 300`, [texto(req.query.proveedor), texto(req.query.estado), texto(req.query.sociedad)]);
  res.json({ ok: true, ordenes: rows.map(o => ({ ...o, nro: nroOP(o.numero) })) });
}));

// Lo que se le puede pagar a un proveedor: facturas y notas de débito con pendiente, y notas de
// crédito sin factura con crédito disponible. Con ?sociedad=, sólo los de esa sociedad (una orden paga los de una sola).
r.get('/fin/pendientes', h(async (req, res) => {
  const proveedor = texto(req.query.proveedor, { campo: 'el proveedor', requerido: true }), soc = texto(req.query.sociedad);
  const [deudas, creditos, saldo] = await Promise.all([
    pool.query(`SELECT comprobante_id, tipo, letra, punto_venta, numero, fecha, vencimiento, pendiente::text, sociedad_id,
                       (vencimiento - current_date) AS dias
                  FROM fin.comprobante_pendiente WHERE proveedor_id = $1::uuid AND pendiente > 0 AND ($2::uuid IS NULL OR sociedad_id = $2)
                 ORDER BY vencimiento, fecha`, [proveedor, soc]),
    pool.query(`SELECT comprobante_id, 'nota_credito' AS tipo, letra, punto_venta, numero, fecha, disponible::text, sociedad_id
                  FROM fin.credito_pendiente WHERE proveedor_id = $1::uuid AND disponible > 0 AND ($2::uuid IS NULL OR sociedad_id = $2)
                 ORDER BY fecha`, [proveedor, soc]),
    pool.query(`SELECT COALESCE(SUM(saldo), 0)::text AS saldo FROM fin.saldo_proveedor_sociedad
                 WHERE proveedor_id = $1::uuid AND ($2::uuid IS NULL OR sociedad_id = $2)`, [proveedor, soc]),
  ]);
  res.json({ ok: true, deudas: deudas.rows.map(c => ({ ...c, nro: nroComp(c) })), creditos: creditos.rows.map(c => ({ ...c, nro: nroComp(c) })),
             saldo: saldo.rows[0] ? saldo.rows[0].saldo : '0' });
}));

r.get('/fin/ordenes-pago/:id', h(async (req, res) => {
  const { rows: [o] } = await pool.query(
    `SELECT o.*, o.total_valores::text, o.total_retenciones::text, o.total_aplicado::text, o.a_cuenta::text,
            pv.nombre AS proveedor, pv.cuit, so.nombre AS sociedad
       FROM fin.orden_pago o JOIN logic.proveedor pv ON pv.id = o.proveedor_id JOIN org.sociedad so ON so.id = o.sociedad_id
      WHERE o.id = $1::uuid`, [req.params.id]);
  if (!o) throw new ErrorUsuario('No existe esa orden de pago.', 404);
  const [ap, ret, val, tes] = await Promise.all([
    pool.query(`SELECT a.comprobante_id, a.importe::text, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha, c.total::text
                  FROM fin.orden_pago_aplicacion a JOIN fin.comprobante c ON c.id = a.comprobante_id
                 WHERE a.orden_pago_id = $1 ORDER BY c.fecha`, [o.id]),
    pool.query(`SELECT id, impuesto, jurisdiccion, regimen, certificado, importe::text FROM fin.orden_pago_retencion WHERE orden_pago_id = $1`, [o.id]),
    pool.query(`SELECT v.id, v.medio, v.cuenta_id, cu.nombre AS cuenta, v.cheque_id, v.importe::text, v.referencia,
                       v.cheque_numero, v.cheque_formato, v.cheque_fecha_pago, ch.banco AS cheque_banco, ch.numero AS cheque_nro,
                       ch.fecha_pago AS cheque_pago, ch.estado AS cheque_estado
                  FROM fin.orden_pago_valor v LEFT JOIN fin.cuenta cu ON cu.id = v.cuenta_id LEFT JOIN fin.cheque ch ON ch.id = v.cheque_id
                 WHERE v.orden_pago_id = $1`, [o.id]),
    pool.query(`SELECT m.id, m.ocurrido_en, cu.nombre AS cuenta, m.tipo, m.entrada::text, m.salida::text, m.concepto
                  FROM fin.movimiento_tes m JOIN fin.cuenta cu ON cu.id = m.cuenta_id WHERE m.orden_pago_id = $1 ORDER BY m.id`, [o.id]),
  ]);
  res.json({ ok: true, orden: { ...o, nro: nroOP(o.numero), aplicaciones: ap.rows.map(a => ({ ...a, nro: nroComp(a) })),
    retenciones: ret.rows, valores: val.rows, movimientos: tes.rows } });
}));

const IMPUESTOS = ['ganancias', 'iva', 'iibb', 'suss', 'otra'];
const MEDIOS = ['transferencia', 'efectivo', 'cheque_propio', 'cheque_tercero'];

function leerOrden(b) {
  const o = {
    proveedor_id: texto(b.proveedor_id, { campo: 'el proveedor', requerido: true }),
    // La sociedad que paga; sin elegir, la de los comprobantes que aplica (sociedadDeOrden).
    sociedad_id: texto(b.sociedad_id),
    fecha: fecha(b.fecha, { campo: 'Fecha' }), notas: texto(b.notas),
  };
  o.aplicaciones = (Array.isArray(b.aplicaciones) ? b.aplicaciones : []).filter(a => a.importe).map((a, i) => ({
    comprobante_id: texto(a.comprobante_id, { campo: `el comprobante ${i + 1}`, requerido: true }),
    importe: importe(a.importe, `Importe aplicado ${i + 1}`) }));
  o.retenciones = (Array.isArray(b.retenciones) ? b.retenciones : []).filter(x => x.importe).map((x, i) => {
    const t = { impuesto: texto(x.impuesto, { campo: `el impuesto de la retención ${i + 1}`, requerido: true }),
                jurisdiccion: texto(x.jurisdiccion), regimen: texto(x.regimen), certificado: texto(x.certificado),
                importe: importe(x.importe, `Importe de la retención ${i + 1}`) };
    if (!IMPUESTOS.includes(t.impuesto)) throw new ErrorUsuario(`Impuesto inválido en la retención ${i + 1}.`);
    return t;
  });
  o.valores = (Array.isArray(b.valores) ? b.valores : []).filter(x => x.importe || x.cheque_id).map((x, i) => {
    const v = { medio: texto(x.medio, { campo: `el medio del valor ${i + 1}`, requerido: true }), cuenta_id: texto(x.cuenta_id),
                cheque_id: texto(x.cheque_id), importe: importe(x.importe, `Importe del valor ${i + 1}`), referencia: texto(x.referencia),
                cheque_numero: texto(x.cheque_numero), cheque_formato: texto(x.cheque_formato) || null,
                cheque_fecha_pago: fecha(x.cheque_fecha_pago, { campo: `Fecha de pago del cheque ${i + 1}` }) };
    if (!MEDIOS.includes(v.medio)) throw new ErrorUsuario(`Medio de pago inválido en el valor ${i + 1}.`);
    if (v.medio !== 'cheque_tercero') v.cheque_id = null;
    if (v.medio === 'cheque_tercero') v.cuenta_id = null;
    if (v.medio !== 'cheque_propio') { v.cheque_numero = null; v.cheque_fecha_pago = null; v.cheque_formato = null; }
    if (v.medio !== 'cheque_tercero' && !v.cuenta_id) throw new ErrorUsuario(`Falta la cuenta del valor ${i + 1}.`);
    if (v.medio === 'cheque_tercero' && !v.cheque_id) throw new ErrorUsuario(`Falta elegir el cheque del valor ${i + 1}.`);
    if (v.medio === 'cheque_propio' && (!v.cheque_numero || !v.cheque_fecha_pago))
      throw new ErrorUsuario(`El cheque propio del valor ${i + 1} necesita número y fecha de pago.`);
    return v;
  });
  return o;
}

// La sociedad de la orden: la elegida o la de sus comprobantes (todos de la misma: lo controla la base).
async function sociedadDeOrden(c, o) {
  if (o.sociedad_id) return o.sociedad_id;
  const ids = o.aplicaciones.map(a => a.comprobante_id);
  const { rows } = ids.length ? await c.query('SELECT DISTINCT sociedad_id FROM fin.comprobante WHERE id = ANY($1::uuid[])', [ids]) : { rows: [] };
  if (rows.length > 1) throw new ErrorUsuario('Los comprobantes elegidos son de sociedades distintas: una orden de pago paga los de una sola.');
  if (!rows.length) throw new ErrorUsuario('Elegí la sociedad que paga.');
  return rows[0].sociedad_id;
}
async function guardarDetalleOrden(c, id, o) {
  for (const t of ['orden_pago_aplicacion', 'orden_pago_retencion', 'orden_pago_valor'])
    await c.query(`DELETE FROM fin.${t} WHERE orden_pago_id = $1`, [id]);
  for (const a of o.aplicaciones)
    await c.query('INSERT INTO fin.orden_pago_aplicacion (orden_pago_id, comprobante_id, importe) VALUES ($1,$2,$3)', [id, a.comprobante_id, a.importe]);
  for (const t of o.retenciones)
    await c.query('INSERT INTO fin.orden_pago_retencion (orden_pago_id, impuesto, jurisdiccion, regimen, certificado, importe) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, t.impuesto, t.jurisdiccion, t.regimen, t.certificado, t.importe]);
  for (const v of o.valores)
    await c.query(
      `INSERT INTO fin.orden_pago_valor (orden_pago_id, medio, cuenta_id, cheque_id, importe, referencia, cheque_numero, cheque_formato, cheque_fecha_pago)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, v.medio, v.cuenta_id, v.cheque_id, v.importe, v.referencia, v.cheque_numero, v.cheque_formato, v.cheque_fecha_pago]);
}

r.post('/fin/ordenes-pago', h(async (req, res) => {
  const o = leerOrden(req.body);
  const id = await enTransaccion(async c => {
    const { rows: [n] } = await c.query('INSERT INTO fin.orden_pago (proveedor_id, fecha, notas, sociedad_id) VALUES ($1,COALESCE($2::date, current_date),$3,$4) RETURNING id',
      [o.proveedor_id, o.fecha, o.notas, await sociedadDeOrden(c, o)]);
    await guardarDetalleOrden(c, n.id, o);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

r.put('/fin/ordenes-pago/:id', h(async (req, res) => {
  const o = leerOrden(req.body);
  await enTransaccion(async c => {
    // El detalle se borra antes de cambiar la cabecera: con renglones la orden no cambia de sociedad (lo controla la base).
    for (const t of ['orden_pago_aplicacion', 'orden_pago_retencion', 'orden_pago_valor'])
      await c.query(`DELETE FROM fin.${t} WHERE orden_pago_id = $1::uuid`, [req.params.id]);
    const { rowCount } = await c.query(
      `UPDATE fin.orden_pago SET proveedor_id=$1, fecha=COALESCE($2::date, fecha), notas=$3, sociedad_id=$5 WHERE id=$4::uuid AND estado = 'borrador'`,
      [o.proveedor_id, o.fecha, o.notas, req.params.id, await sociedadDeOrden(c, o)]);
    if (!rowCount) throw new ErrorUsuario('La orden de pago no existe o ya no está en borrador.');
    await guardarDetalleOrden(c, req.params.id, o);
  });
  res.json({ ok: true, id: req.params.id });
}));

r.delete('/fin/ordenes-pago/:id', h(async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM fin.orden_pago WHERE id = $1::uuid AND estado = 'borrador'`, [req.params.id]);
  if (!rowCount) throw new ErrorUsuario('Sólo se borra una orden de pago en borrador.');
  res.json({ ok: true });
}));

r.post('/fin/ordenes-pago/:id/registrar', h(async (req, res) => {
  await pool.query('SELECT fin.registrar_orden_pago($1::uuid)', [req.params.id]);
  res.json({ ok: true });
}));

r.post('/fin/ordenes-pago/:id/anular', h(async (req, res) => {
  await pool.query('SELECT fin.anular_orden_pago($1::uuid, $2)', [req.params.id, texto(req.body.motivo, { campo: 'el motivo', requerido: true })]);
  res.json({ ok: true });
}));

// ── Retenciones practicadas (CSV para el contador) ───────────────────────────────────────────
r.get('/fin/retenciones', h(async (req, res) => {
  const mes = texto(req.query.mes, { campo: 'el mes', requerido: true });
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new ErrorUsuario('El mes va como AAAA-MM.');
  // De una sociedad (el agente de retención es la sociedad que paga).
  const { rows: [so] } = await pool.query('SELECT id, nombre FROM org.sociedad WHERE id = $1::uuid',
    [texto(req.query.sociedad, { campo: 'la sociedad', requerido: true })]);
  if (!so) throw new ErrorUsuario('No existe esa sociedad.');
  const { rows } = await pool.query(
    `SELECT to_char(o.fecha, 'DD/MM/YYYY') AS fecha, o.numero, pv.nombre AS proveedor, pv.cuit, r.impuesto, r.jurisdiccion,
            r.regimen, r.certificado, r.importe::text,
            (SELECT SUM(a.importe) FILTER (WHERE c.tipo <> 'nota_credito') - COALESCE(SUM(a.importe) FILTER (WHERE c.tipo = 'nota_credito'), 0)
               FROM fin.orden_pago_aplicacion a JOIN fin.comprobante c ON c.id = a.comprobante_id WHERE a.orden_pago_id = o.id)::text AS base
       FROM fin.orden_pago_retencion r JOIN fin.orden_pago o ON o.id = r.orden_pago_id JOIN logic.proveedor pv ON pv.id = o.proveedor_id
      WHERE o.estado = 'registrada' AND to_char(o.fecha, 'YYYY-MM') = $1 AND o.sociedad_id = $2 ORDER BY o.fecha, o.numero`, [mes, so.id]);
  const IMP = { ganancias: 'Ganancias', iva: 'IVA', iibb: 'Ingresos Brutos', suss: 'SUSS', otra: 'Otra' };
  const esc = s => s == null ? '' : /[;"\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s);
  const csv = '﻿' + ['Fecha;Orden de pago;Proveedor;CUIT;Impuesto;Jurisdicción;Régimen;Certificado;Base (aplicado);Importe retenido',
    ...rows.map(x => [x.fecha, nroOP(x.numero), esc(x.proveedor), x.cuit || '', IMP[x.impuesto], esc(x.jurisdiccion), esc(x.regimen),
      esc(x.certificado), (x.base || '').replace('.', ','), x.importe.replace('.', ',')].join(';'))].join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="retenciones-${so.nombre.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '')}-${mes}.csv"`);
  res.send(csv);
}));

// ── Conciliación bancaria ────────────────────────────────────────────────────────────────────
// Importe del extracto -> texto NUMERIC. El usuario dice cuál es el separador decimal: "1.234" no
// se puede adivinar (¿mil doscientos treinta y cuatro, o uno con 234?). Paréntesis = negativo.
function importeExtracto(v, decimal, n) {
  let s = String(v ?? '').trim().replace(/[$\s]/g, '');
  // Vacío o un guion solo (Brubank pone "-" en la columna que no corresponde): no hay importe.
  if (!s || s === '-') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  s = decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new ErrorUsuario(`Fila ${n}: "${v}" no es un importe.`);
  return (neg ? '-' : '') + s;
}
function fechaExtracto(v, n) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!m) throw new ErrorUsuario(`Fila ${n}: "${v}" no es una fecha (se espera DD/MM/AAAA).`);
  const anio = m[3].length === 2 ? '20' + m[3] : m[3];
  const [d, mes] = [+m[1], +m[2]];
  if (mes < 1 || mes > 12 || d < 1 || d > new Date(Date.UTC(+anio, mes, 0)).getUTCDate())
    throw new ErrorUsuario(`Fila ${n}: "${v}" no es una fecha válida.`);
  return `${anio}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// El número de operación del procesador al que se refiere una línea: un cargo o un impuesto lo nombran en la
// referencia ("Gasto por transferencia: 1580009466", "... Ingreso #1580009466", "Pago Cliente - 1580387104"); un
// ingreso es su propio número, el que va en el concepto ("Transferencia Bancaria Ingreso - 1580009466").
const numeroEnConcepto = l => (String(l.concepto).match(/\b(\d{6,})\b/) || [])[1] || null;
function operacionDe(l) {
  const m = String(l.referencia).match(/(?:#|Pago Cliente\s*-\s*|transferencia:\s*)(\d{6,})/i);
  return m ? m[1] : numeroEnConcepto(l);
}

// Un extracto con el formato de un procesador (el de Pago24 por sus conceptos; el de Mercado Pago lo reconoce la
// pantalla) va en la cuenta donde deposita ese procesador: en otra cuenta se conciliaría contra lo que no es (pasó con
// el de Pago24 importado en Brubank).
const FORMATOS = [
  { nombre: 'Pago24', marca: 'pago24',
    es: f => /^(recaudaci[oó]n|gasto transacci[oó]n|liquidaci[oó]n impuesto|pago cliente|transferencia bancaria (egreso|ingreso))\s*-\s*\d{6,}/i.test(String(f.concepto || '').trim())
      || /AR_(IVA|DCB|IIBB|GAN)\b/.test(String(f.referencia || '')) },
  { nombre: 'Mercado Pago', marca: 'mercadopago', es: f => /^(cobro|comisi[oó]n) mercado pago/i.test(String(f.concepto || '').trim()) },
];
async function exigirCuentaDelFormato(cuenta, filas, formato) {
  const conDatos = filas.filter(f => String(f.fecha ?? '').trim());
  const fmt = formato === 'mercadopago' ? FORMATOS[1]
    : FORMATOS.find(x => conDatos.length && conDatos.filter(x.es).length * 5 >= conDatos.length);   // la quinta parte alcanza
  if (!fmt) return;
  const { rows } = await pool.query(
    `SELECT p.nombre, p.marca, p.cuenta_acredita_id, c.nombre AS cuenta FROM fin.procesador p LEFT JOIN fin.cuenta c ON c.id = p.cuenta_acredita_id WHERE p.activo`);
  // Puede haber más de un procesador del mismo tipo (Mercado Pago de CORTAFUEGO y de SORELLE): vale la cuenta de cualquiera.
  const prs = rows.filter(x => x.marca === fmt.marca), pr = prs[0];
  if (!pr || prs.some(x => x.cuenta_acredita_id === cuenta)) return;
  const cuentas = prs.filter(x => x.cuenta_acredita_id).map(x => x.cuenta);
  if (!cuentas.length) throw new ErrorUsuario(`Es un extracto de ${fmt.nombre}: primero indicá en Medios de pago en qué cuenta deposita ${pr.nombre}.`);
  throw new ErrorUsuario(`Es un extracto de ${fmt.nombre}: va en ${cuentas.length > 1 ? 'una de las cuentas ' + cuentas.join(' o ') : 'la cuenta ' + cuentas[0]}, no en esta.`);
}

// Con la columna de saldo, cada fila tiene que cerrar con la anterior: saldo anterior + importe = saldo (en un archivo de
// la fecha más nueva a la más vieja, al revés). Si casi todas cierran restando, los débitos y los créditos quedaron
// cruzados al elegir las columnas (pasó con un extracto de Pago24: los cobros entraron como egresos y los cargos como
// ingresos, y no se pareó nada). Un archivo sin orden no se puede controlar y pasa.
function controlarSaldos(filas) {
  const pares = [];
  for (let i = 1; i < filas.length; i++) if (filas[i].imp !== null) pares.push([filas[i - 1], filas[i]]);
  if (pares.length < 5) return;
  const c = centavos, contar = f => pares.filter(f).length;
  const bien = Math.max(contar(([a, b]) => c(a.saldo) + c(b.imp) === c(b.saldo)),
                        contar(([a, b]) => a.imp !== null && c(b.saldo) + c(a.imp) === c(a.saldo)));
  const cruzado = Math.max(contar(([a, b]) => c(a.saldo) - c(b.imp) === c(b.saldo)),
                           contar(([a, b]) => a.imp !== null && c(b.saldo) - c(a.imp) === c(a.saldo)));
  if (cruzado >= pares.length * 0.8 && bien < pares.length * 0.2)
    throw new ErrorUsuario('Los débitos y los créditos están cruzados: según la columna de saldo, lo que figura como débito suma y lo que figura '
      + 'como crédito resta. Revisá las columnas (Débito y Crédito al revés, o el importe con el signo cambiado) y volvé a importar.');
}

// El período que declara el nombre del archivo ("2026-10-01 al 2026-10-31", "… a …"), si contiene todas las líneas, no es
// del futuro y no pasa de 62 días: si no, no se toma.
function periodoDeclarado(archivo, fechas) {
  const m = String(archivo || '').match(/(\d{4}-\d{2}-\d{2})\s+(?:al?|-)\s+(\d{4}-\d{2}-\d{2})/i);
  if (!m) return null;
  const [, desde, hasta] = m, hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  if (!(desde <= hasta) || hasta >= hoy || Number.isNaN(Date.parse(desde)) || Number.isNaN(Date.parse(hasta))) return null;
  if ((Date.parse(hasta) - Date.parse(desde)) / 864e5 > 62) return null;
  if (fechas.length && (fechas[0] < desde || fechas.at(-1) > hasta)) return null;
  return { desde, hasta };
}

// Importar un extracto ya separado en columnas (fecha, concepto, referencia, débito y crédito o importe, saldo): lo usan la
// pantalla (que mapea las columnas del archivo) y el portal de Pago24 (que baja el CSV). Reimportar no duplica.
async function importarExtracto(b) {
  const cuenta = texto(b.cuenta_id, { campo: 'la cuenta', requerido: true });
  const decimal = b.decimal === '.' ? '.' : ',';
  const filas = Array.isArray(b.filas) ? b.filas : [];
  if (!filas.length) throw new ErrorUsuario('El extracto no tiene filas.');
  if (filas.length > 5000) throw new ErrorUsuario('Demasiadas filas: importá el extracto por mes.');
  await exigirCuentaDelFormato(cuenta, filas, b.formato);
  const lineas = [], vistas = new Map(), conSaldo = [];
  let saldoInicial = null, saldoFinal = null;
  filas.forEach((f, i) => {
    // Filas sin fecha: totales al pie y renglones en blanco.
    if (!String(f.fecha ?? '').trim()) return;
    // Los saldos que trae el extracto (si se indicó la columna): el inicial y el final, para controlar.
    if (f.saldo !== undefined && /saldo\s+inicial/i.test(f.concepto || '')) {
      saldoInicial = { fecha: fechaExtracto(f.fecha, i + 1), saldo: importeExtracto(f.saldo, decimal, i + 1) };
      conSaldo.push({ imp: null, saldo: saldoInicial.saldo }); return;
    }
    if (f.saldo !== undefined && /saldo\s+final/i.test(f.concepto || '')) { saldoFinal = importeExtracto(f.saldo, decimal, i + 1); return; }
    // Débito y crédito en columnas separadas o un solo importe con signo: las dos formas existen.
    let imp = f.importe !== undefined && f.importe !== '' ? importeExtracto(f.importe, decimal, i + 1) : null;
    if (imp === null) {
      const deb = importeExtracto(f.debito, decimal, i + 1), cred = importeExtracto(f.credito, decimal, i + 1);
      if (deb && !/^-?0+(\.0+)?$/.test(deb)) imp = '-' + deb.replace('-', '');
      else if (cred && !/^-?0+(\.0+)?$/.test(cred)) imp = cred.replace('-', '');
    }
    if (imp === null || /^-?0+(\.0+)?$/.test(imp)) return;   // saldos iniciales, filas vacías
    const sal = f.saldo !== undefined && String(f.saldo).trim() !== '' && String(f.saldo).trim() !== '-' ? importeExtracto(f.saldo, decimal, i + 1) : null;
    if (sal !== null) conSaldo.push({ imp, saldo: sal });
    const l = { fecha: fechaExtracto(f.fecha, i + 1), concepto: String(f.concepto || '').trim().slice(0, 300),
                referencia: String(f.referencia || '').trim().slice(0, 100), importe: imp };
    l.operacion = operacionDe(l);
    const clave = [l.fecha, l.importe, l.concepto, l.referencia].join('|');
    l.ocurrencia = (vistas.get(clave) || 0) + 1; vistas.set(clave, l.ocurrencia);
    lineas.push(l);
  });
  controlarSaldos(conSaldo);
  // Sin filas de saldo inicial y final (Brubank trae el saldo en cada fila): salen de la columna de saldo, siempre que
  // todas las filas cierren con la anterior, en orden ascendente o descendente. Si no, no se adivina.
  if (!saldoInicial && conSaldo.length >= 2 && conSaldo.length === lineas.length) {
    const k = centavos, n = conSaldo.length;
    const sube = conSaldo.every((b, i) => i === 0 || k(conSaldo[i - 1].saldo) + k(b.imp) === k(b.saldo));
    const baja = !sube && conSaldo.every((b, i) => i === 0 || k(b.saldo) + k(conSaldo[i - 1].imp) === k(conSaldo[i - 1].saldo));
    if (sube || baja) {
      const [pri, ult] = sube ? [conSaldo[0], conSaldo[n - 1]] : [conSaldo[n - 1], conSaldo[0]];
      saldoInicial = { fecha: lineas.map(l => l.fecha).sort()[0], saldo: deCentavos(k(pri.saldo) - k(pri.imp)) };
      if (saldoFinal === null) saldoFinal = ult.saldo;
    }
  }
  const out = await enTransaccion(async c => {
    const { rows: [cu] } = await c.query('SELECT tipo FROM fin.cuenta WHERE id = $1::uuid', [cuenta]);
    if (!cu || cu.tipo !== 'banco') throw new ErrorUsuario('El extracto es de una cuenta bancaria.');
    const fechas = lineas.map(l => l.fecha).sort();
    // El período del extracto: el de sus líneas, ampliado al que declara el nombre del archivo (Brubank: "[2026-10-01 al
    // 2026-10-31]"). Un fin de semana sin movimientos al final no es un día que falte (03/11/2026: el de octubre terminaba
    // el viernes 30 y el paso 3 pedía el 31).
    const per = periodoDeclarado(b.archivo, fechas);
    const desde = [(saldoInicial && saldoInicial.fecha) || fechas[0], per && per.desde].filter(Boolean).sort()[0] || null;
    const hasta = [fechas.at(-1), per && per.hasta].filter(Boolean).sort().at(-1) || null;
    const { rows: [e] } = await c.query(
      'INSERT INTO fin.extracto (cuenta_id, archivo, saldo_inicial, saldo_final, desde, hasta) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [cuenta, texto(b.archivo), saldoInicial && saldoInicial.saldo, saldoFinal, desde, hasta]);
    // Una cuenta que recién empieza (sin movimientos) toma como apertura el saldo inicial del extracto, el día
    // anterior: así su saldo puede coincidir con el del extracto desde el primer día (decisión de Fer).
    let apertura = null;
    if (saldoInicial && !/^-?0+(\.0+)?$/.test(saldoInicial.saldo)) {
      // Lo anulado no cuenta: una cuenta a la que se le deshizo todo (03/11/2026, Pago24) vuelve a empezar.
      const { rows: [{ hay }] } = await c.query(
        `SELECT EXISTS (SELECT 1 FROM fin.movimiento_tes m WHERE m.cuenta_id = $1 AND m.anula_a IS NULL
                          AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = m.id)) AS hay`, [cuenta]);
      if (!hay) {
        const neg = saldoInicial.saldo.startsWith('-');
        await c.query(
          `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto) VALUES ($1::date - 1, $2, $3, $4, $5, 'Saldo de apertura según extracto')`,
          [saldoInicial.fecha, cuenta, neg ? 'egreso' : 'ingreso', neg ? 0 : saldoInicial.saldo, neg ? saldoInicial.saldo.slice(1) : 0]);
        apertura = saldoInicial.saldo;
      }
    }
    let nuevas = 0;
    for (const l of lineas) {
      const { rowCount } = await c.query(
        `INSERT INTO fin.extracto_linea (extracto_id, cuenta_id, fecha, concepto, referencia, importe, ocurrencia, operacion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [e.id, cuenta, l.fecha, l.concepto, l.referencia, l.importe, l.ocurrencia, l.operacion]);
      nuevas += rowCount;
    }
    await c.query('UPDATE fin.extracto SET lineas_nuevas = $1, lineas_repetidas = $2 WHERE id = $3', [nuevas, lineas.length - nuevas, e.id]);
    return { nuevas, repetidas: lineas.length - nuevas, apertura, saldo_final: saldoFinal };
  });
  return out;
}
r.post('/fin/extractos', h(async (req, res) => { res.status(201).json({ ok: true, ...await importarExtracto(req.body) }); }));

// Lo que falta conciliar de una cuenta, con candidatos para cada línea: movimientos sin conciliar
// del mismo importe y cheques propios emitidos por ese importe, con la fecha más cercana primero.
r.get('/fin/conciliacion', h(async (req, res) => {
  const cuenta = texto(req.query.cuenta, { campo: 'la cuenta', requerido: true });
  const lado = ['ingresos', 'egresos'].includes(req.query.lado) ? req.query.lado : null;
  const [lineas, movs, cheques, hechas] = await Promise.all([
    pool.query(`SELECT l.id, l.fecha, l.concepto, l.referencia, l.importe::text FROM fin.extracto_linea l
                 WHERE l.cuenta_id = $1::uuid AND l.compensa_a IS NULL AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)
                 ORDER BY l.fecha, l.id`, [cuenta]),
    // Los movimientos que deberían aparecer en el extracto: desde que empiezan los extractos importados (la apertura
    // y lo anterior no van a aparecer nunca), y sin los anulados ni sus anulaciones (se cancelan entre sí).
    pool.query(`SELECT m.id, m.fecha, m.tipo, m.concepto, m.gasto, (m.entrada - m.salida)::text AS importe FROM fin.movimiento_tes m
                 WHERE m.cuenta_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.movimiento_id = m.id)
                   AND m.tipo <> 'anulacion' AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = m.id)
                   AND m.fecha >= COALESCE((SELECT MIN(desde) FROM fin.extracto e WHERE e.cuenta_id = m.cuenta_id), '-infinity'::date)
                 ORDER BY m.fecha, m.id`, [cuenta]),
    pool.query(`SELECT id, numero, fecha_pago, (-importe)::text AS importe, proveedor_id FROM fin.cheque
                 WHERE cuenta_id = $1::uuid AND tipo = 'propio' AND estado = 'emitido'`, [cuenta]),
    pool.query(`SELECT COUNT(*)::int AS lineas, COALESCE(SUM(l.importe) FILTER (WHERE l.importe > 0), 0)::text AS ingresos,
                       COALESCE(-SUM(l.importe) FILTER (WHERE l.importe < 0), 0)::text AS egresos,
                       (SELECT COUNT(*)::int FROM fin.extracto_linea c WHERE c.cuenta_id = $1::uuid AND c.compensa_a IS NOT NULL) AS compensadas
                  FROM fin.extracto_linea l WHERE l.cuenta_id = $1::uuid AND EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)`, [cuenta]),
  ]);
  // Importes exactos (texto NUMERIC normalizado), distancia de fechas en días: no hay float en juego.
  const norm = v => { let [e, d = ''] = String(v).split('.'); return e + '.' + (d + '00').slice(0, 2); };
  const dias = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
  const out = lineas.rows.map(l => {
    const cand = [
      ...movs.rows.filter(m => norm(m.importe) === norm(l.importe) && dias(m.fecha, l.fecha) <= 10)
        .map(m => ({ tipo: 'movimiento', id: m.id, fecha: m.fecha, descripcion: m.concepto || m.tipo, dias: dias(m.fecha, l.fecha) })),
      ...cheques.rows.filter(ch => norm(ch.importe) === norm(l.importe))
        .map(ch => ({ tipo: 'cheque', id: ch.id, fecha: ch.fecha_pago, descripcion: `Cheque propio Nº ${ch.numero} (vence ${ch.fecha_pago})`, dias: dias(ch.fecha_pago, l.fecha) })),
    ].sort((a, b) => a.dias - b.dias);
    return { ...l, lado: ladoDe(l), candidatos: cand };
  }).filter(l => !lado || l.lado === lado);
  // Un movimiento que todavía no está en el extracto: lo que entra es de ingresos; lo que sale, de egresos.
  const movsLado = movs.rows.map(m => ({ ...m, lado: String(m.importe).startsWith('-') && !m.gasto ? 'egresos' : 'ingresos' }))
    .filter(m => !lado || m.lado === lado);
  const { rows: extractos } = await pool.query(
    `SELECT e.id, e.archivo, e.importado_en, e.importado_por, to_char(e.desde, 'YYYY-MM-DD') AS desde, to_char(e.hasta, 'YYYY-MM-DD') AS hasta,
            (SELECT COUNT(*)::int FROM fin.extracto_linea l WHERE l.extracto_id = e.id) AS lineas,
            (SELECT COUNT(*)::int FROM fin.extracto_linea l WHERE l.extracto_id = e.id
                AND (l.compensa_a IS NOT NULL OR EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id))) AS conciliadas
       FROM fin.extracto e WHERE e.cuenta_id = $1::uuid ORDER BY e.importado_en DESC LIMIT 20`, [cuenta]);
  // Los cobros del procesador de la cuenta que esperan el extracto (no los de lotes): para parear a mano una línea, y los que
  // ya deberían estar (4 días después de la venta o de su liquidación, dentro del extracto), para resolverlos.
  const { rows: cobros } = lado === 'egresos' ? { rows: [] } : await pool.query(
    `SELECT p.id, t.id_externo, to_char(t.dia, 'YYYY-MM-DD') AS dia, p.importe::text, mp.tipo_operacion, i.nombre AS punto_venta,
            (i.cuenta_efectivo_id IS NOT NULL) AS con_efectivo,
            COALESCE(p.liquida_el, t.dia) + 4 <= (SELECT MAX(e.hasta) FROM fin.extracto e WHERE e.cuenta_id = $1::uuid) AS revisar
       FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
       JOIN pos.medio m ON m.id = p.medio_id JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
       JOIN fin.procesador pr ON pr.id = mp.procesador_id AND pr.cuenta_acredita_id = $1::uuid
      WHERE NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL
        AND p.lote_id IS NULL
      ORDER BY t.dia, t.id_externo`, [cuenta]);
  res.json({ ok: true, lado, lineas: out, movimientos: movsLado, conciliado: hechas.rows[0], procesador: await resumenProcesador(cuenta),
    sugerencias: lado === 'egresos' ? [] : await sugerenciasProcesador(cuenta), extractos, cobros });
}));

// Descartar un extracto importado por error (un archivo equivocado, o el resumen de Mercado Pago sin las
// liquidaciones): se borran sus líneas, que son datos de recepción, no del libro mayor. Sólo si ninguna está
// conciliada ni compensada: si no, primero se deshace eso. La apertura que haya creado queda (es un movimiento).
r.post('/fin/extractos/:id/descartar', h(async (req, res) => {
  await enTransaccion(async c => {
    const { rows: [e] } = await c.query('SELECT id FROM fin.extracto WHERE id = $1::uuid FOR UPDATE', [req.params.id]);
    if (!e) throw new ErrorUsuario('No existe ese extracto.', 404);
    const { rows: [{ n }] } = await c.query(
      `SELECT COUNT(*)::int AS n FROM fin.extracto_linea l WHERE l.extracto_id = $1
          AND (l.compensa_a IS NOT NULL OR EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)
               OR EXISTS (SELECT 1 FROM pos.ticket_pago p WHERE p.acreditado_linea_id = l.id))`, [e.id]);
    if (n) throw new ErrorUsuario(`El extracto tiene ${n} línea(s) conciliadas: deshacelas primero (en "Lo conciliado").`);
    await c.query('DELETE FROM fin.extracto_linea WHERE extracto_id = $1', [e.id]);
    await c.query('DELETE FROM fin.extracto WHERE id = $1', [e.id]);
  });
  res.json({ ok: true });
}));

// Lo ya conciliado, para consultar: de a 100, lo último primero, con búsqueda por concepto o importe.
r.get('/fin/conciliacion/hechas', h(async (req, res) => {
  const cuenta = texto(req.query.cuenta, { campo: 'la cuenta', requerido: true });
  const q = texto(req.query.q), desde = Math.max(0, Number(req.query.desde) || 0);
  const { rows } = await pool.query(
    `SELECT l.id AS linea_id, l.fecha, l.concepto, l.referencia, l.importe::text, string_agg(m.concepto, ' + ' ORDER BY m.id) AS movimiento,
            max(k.conciliado_por) AS conciliado_por, max(k.conciliado_en) AS conciliado_en
       FROM fin.conciliacion k JOIN fin.extracto_linea l ON l.id = k.linea_id JOIN fin.movimiento_tes m ON m.id = k.movimiento_id
      WHERE l.cuenta_id = $1::uuid
      GROUP BY l.id
     HAVING $2::text IS NULL OR l.concepto ILIKE '%' || $2 || '%' OR string_agg(m.concepto, ' ') ILIKE '%' || $2 || '%' OR l.importe::text LIKE '%' || replace($2, '.', '') || '%'
      ORDER BY l.fecha DESC, l.id DESC LIMIT 101 OFFSET $3`, [cuenta, q, desde]);
  res.json({ ok: true, conciliadas: rows.slice(0, 100), hay_mas: rows.length > 100 });
}));

r.post('/fin/conciliacion', h(async (req, res) => {
  const b = req.body;
  const linea = numero(b.linea_id, { campo: 'la línea', requerido: true });
  const out = await enTransaccion(async c => {
    const { rows: [l] } = await c.query('SELECT * FROM fin.extracto_linea WHERE id = $1 FOR UPDATE', [linea]);
    if (!l) throw new ErrorUsuario('No existe esa línea del extracto.');
    let mov = texto(b.movimiento_id);
    if (b.cheque_id) {
      // El débito del cheque aparece en el extracto: recién ahí sale del banco.
      ({ rows: [{ id: mov }] } = await c.query('SELECT fin.debitar_cheque($1::uuid, $2::date) AS id', [b.cheque_id, l.fecha]));
    } else if (b.crear) {
      // Línea sin movimiento: comisión, impuesto, interés, acreditación. Se registra desde acá con su rubro (estado de
      // resultados) y, si se pide, una regla para que las próximas iguales se clasifiquen y concilien solas.
      const concepto = texto(b.crear.concepto, { campo: 'el concepto', requerido: true });
      const rubro = await rubroValido(c, b.crear.rubro_id);
      const sale = String(l.importe).startsWith('-');
      ({ rows: [{ id: mov }] } = await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [l.fecha, l.cuenta_id, sale ? 'egreso' : 'ingreso', sale ? 0 : l.importe, sale ? String(l.importe).slice(1) : 0, concepto]));
      await c.query('INSERT INTO fin.clasificacion (movimiento_id, rubro_id, sede_id) VALUES ($1,$2,$3)', [mov, rubro, texto(b.crear.sede_id)]);
    }
    if (!mov) throw new ErrorUsuario('Falta el movimiento a conciliar.');
    await c.query('INSERT INTO fin.conciliacion (linea_id, movimiento_id) VALUES ($1,$2)', [linea, mov]);
    if (b.crear && b.crear.regla)
      return crearRegla(c, { cuenta_id: l.cuenta_id, sentido: String(l.importe).startsWith('-') ? 'egreso' : 'ingreso', patron: b.crear.regla,
                             rubro_id: b.crear.rubro_id, sede_id: b.crear.sede_id });
  });
  res.status(201).json({ ok: true, regla: out || null });
}));

// Deshacer un pareo. Si el movimiento lo creó la conciliación de un procesador (una acreditación o un cargo), no
// alcanza con separarlo de la línea: se anula (las dos patas de la acreditación, con su misma fecha) y el pago de la
// venta vuelve a quedar sin acreditar, para que la línea se pueda volver a conciliar.
r.delete('/fin/conciliacion/:linea', h(async (req, res) => {
  await deshacerConciliacion(numero(req.params.linea, { campo: 'la línea', requerido: true }));
  res.json({ ok: true });
}));
async function deshacerConciliacion(linea) {
  await enTransaccion(async c => {
    const { rows: movs } = await c.query(
      `SELECT m.* FROM fin.conciliacion k JOIN fin.movimiento_tes m ON m.id = k.movimiento_id WHERE k.linea_id = $1 FOR UPDATE OF k`, [linea]);
    // Una acreditación en partes concilia varias líneas con patas de la misma transferencia: se deshace entera.
    const trs = [...new Set(movs.filter(m => m.transferencia_id && m.ticket_pago_id).map(m => m.transferencia_id))];
    const { rows: grupo } = trs.length ? await c.query(
      `SELECT DISTINCT k.linea_id FROM fin.conciliacion k JOIN fin.movimiento_tes x ON x.id = k.movimiento_id WHERE x.transferencia_id = ANY($1::uuid[])`, [trs]) : { rows: [] };
    const lineas = [...new Set([linea, ...grupo.map(g => Number(g.linea_id))])];
    await c.query('DELETE FROM fin.conciliacion WHERE linea_id = ANY($1::bigint[])', [lineas]);
    const anular = async m => {
      const { rows: patas } = await c.query(
        m.transferencia_id ? `SELECT * FROM fin.movimiento_tes x WHERE transferencia_id = $1 AND anula_a IS NULL AND tipo <> 'anulacion'
                                AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = x.id)`
          : `SELECT * FROM fin.movimiento_tes x WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = x.id)`,
        [m.transferencia_id || m.id]);
      for (const p of patas)
        await c.query(
          `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, transferencia_id, anula_a)
           VALUES ($1, $2, 'anulacion', $3, $4, $5, $6, $7)`,
          [p.fecha, p.cuenta_id, p.salida, p.entrada, 'Anula (se deshizo la conciliación): ' + (p.concepto || p.tipo), p.transferencia_id, p.id]);
    };
    // Lo que creó la conciliación se anula: acreditaciones y cargos (y la diferencia confirmada de un lote). Un lote
    // confirmado con el depósito vuelve a esperado: se anulan su acreditación y su costo. Un lote armado al confirmar
    // el depósito (un cobro sin neto informado) se deshace entero y el cobro vuelve a pendiente.
    // También lo que asentó una regla: si no, quedaría un movimiento suelto sin su línea.
    const { rows: deRegla } = await c.query('SELECT movimiento_id FROM fin.clasificacion WHERE movimiento_id = ANY($1::bigint[]) AND regla_id IS NOT NULL',
      [movs.map(m => m.id)]);
    const porRegla = new Set(deRegla.map(x => Number(x.movimiento_id)));
    for (const m of movs) if (m.ticket_pago_id || m.gasto || porRegla.has(Number(m.id))) await anular(m);
    const { rows: confirmados } = await c.query('SELECT * FROM fin.lote WHERE movimiento_id = ANY($1::bigint[]) AND desde_linea_id IS NULL',
      [movs.map(m => m.id)]);
    for (const l of confirmados) {
      await anular(movs.find(m => Number(m.id) === Number(l.movimiento_id)));
      if (l.costo_movimiento_id) await anular({ id: l.costo_movimiento_id });
      await c.query('UPDATE fin.lote SET movimiento_id = NULL, costo_movimiento_id = NULL WHERE id = $1', [l.id]);
    }
    const { rows: armados } = await c.query('SELECT * FROM fin.lote WHERE desde_linea_id = $1', [linea]);
    for (const l of armados) {
      await anular({ id: l.movimiento_id, transferencia_id: (movs.find(m => Number(m.id) === Number(l.movimiento_id)) || {}).transferencia_id });
      if (l.costo_movimiento_id) await anular({ id: l.costo_movimiento_id });
      await c.query('UPDATE pos.ticket_pago SET lote_id = NULL, neto = NULL, liquida_el = NULL WHERE lote_id = $1', [l.id]);
      await c.query('DELETE FROM fin.lote WHERE id = $1', [l.id]);
    }
    await c.query('UPDATE pos.ticket_pago SET acreditado_linea_id = NULL WHERE acreditado_linea_id = ANY($1::bigint[])', [lineas]);
  });
}

// ── Conciliación de la cuenta de un procesador ──────────────────────────────────────────────
// El extracto de la cuenta donde deposita un procesador (Pago24, Mercado Pago…) se concilia solo contra los pagos de
// las ventas (decisiones de Fer, 25/10/2026):
//   1. un movimiento y su reverso (mismo concepto, importe opuesto, uno dice "reverso") se compensan;
//   2. cada ingreso se parea con un pago de la venta cobrado con ese procesador: mismo importe, del día de la venta
//      hasta 4 días después (la tarjeta de crédito liquida a los 2 días), el más cercano primero. Pasa de la cuenta
//      "a acreditar" a la cuenta real con una transferencia, y el pago queda acreditado con esa línea;
//   3. cargos, IVA de los cargos, impuesto a los débitos y créditos y retenciones se asientan como egresos
//      clasificados de la cuenta real, atados al pago por el número de operación del procesador;
//   4. lo demás queda sin conciliar (los pagos que salen de esa cuenta, por ejemplo), para hacerlo a mano.
const GASTOS = [
  ['iva_credito', /AR_IVA|cobro\s+iva|iva\s+\d+%?\s*(por|s\/)/i],
  ['imp_debitos_creditos', /AR_DCB|deb\/cred|d[eé]b(itos)?\s*y\s*cr[eé]d|ley\s*25\.?413/i],
  ['retencion', /SIRCREB|AR_IIBB|AR_GAN|retenci[oó]n\s+(de\s+)?(iibb|ingresos\s+brutos|ganancias|iva)|retenci[oó]n\s+de\s+impuestos|percepci[oó]n/i],
  ['comision', /cargo\s+de|gasto\s+transacci|comisi[oó]n|arancel/i],
];
// Lotes abiertos que explican un depósito: uno, o 2 o 3 que suman exacto su importe, todos del día del depósito a 5
// días antes (o el día siguiente); entre los que cumplen, el más cercano en fecha.
function grupoDeLotes(lotes, l) {
  const dias = x => (Date.parse(l.fecha) - Date.parse(x.fecha)) / 864e5, L = centavos(l.importe);
  const cand = lotes.filter(x => dias(x) >= -1 && dias(x) <= 5 && centavos(x.neto) <= L);
  let mejor = null;
  const probar = g => {
    if (g.reduce((s, x) => s + centavos(x.neto), 0n) !== L) return;
    const lejos = Math.max(...g.map(x => Math.abs(dias(x))));
    if (!mejor || lejos < mejor.lejos || (lejos === mejor.lejos && g.length < mejor.g.length)) mejor = { lejos, g };
  };
  for (let i = 0; i < cand.length; i++) {
    probar([cand[i]]);
    for (let j = i + 1; j < cand.length; j++) {
      probar([cand[i], cand[j]]);
      if (cand.length <= 30) for (let k = j + 1; k < cand.length; k++) probar([cand[i], cand[j], cand[k]]);
    }
  }
  return mejor && mejor.g;
}
const clasificar = l => (GASTOS.find(([, re]) => re.test(`${l.concepto} ${l.referencia}`)) || [])[0] || null;
// De qué proceso es una línea pendiente (decisión de Fer, 03/11/2026): los cobros, lo que entra y los costos de la venta
// (cargos, IVA, impuestos y retenciones) son del proceso de ingresos; lo demás que sale (transferencias, pagos, débitos),
// del proceso de egresos.
const ladoDe = l => !String(l.importe).startsWith('-') || clasificar(l) ? 'ingresos' : 'egresos';
const esReverso = l => /reverso/i.test(`${l.concepto} ${l.referencia}`);
const normImp = v => { let [e, d = ''] = String(v).split('.'); return e + '.' + (d + '00').slice(0, 2); };
const opuesto = v => String(v).startsWith('-') ? String(v).slice(1) : '-' + v;

// La conciliación automática de una cuenta (botón de la pantalla, y después de importar el extracto del portal de Pago24).
async function conciliarAutomatica(req, cuenta) {
  // Si el procesador liquida por lotes, primero se liquidan los que ya llegaron a su fecha. Una cuenta que no es de un
  // procesador sólo pasa por las reglas de clasificación.
  const { rows: [prl] } = await pool.query('SELECT id FROM fin.procesador WHERE cuenta_acredita_id = $1::uuid', [cuenta]);
  const liquidados = prl ? await acreditarLotes(req, prl.id) : null;
  const out = await enTransaccion(async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['conciliar:' + cuenta]);
    const { rows: [pr] } = await c.query(
      `SELECT p.id, p.nombre, cu.nombre AS cuenta FROM fin.procesador p JOIN fin.cuenta cu ON cu.id = p.cuenta_acredita_id WHERE p.cuenta_acredita_id = $1::uuid`, [cuenta]);
    // Una cuenta que no es de un procesador (un banco): sólo las reglas de clasificación.
    if (!pr) return { procesador: null, compensadas: 0, acreditadas: 0, acreditado: '0.00', lotes_confirmados: 0, gastos: {}, reglas: await aplicarReglas(c, cuenta),
      quedan: Number((await c.query(`SELECT COUNT(*) AS n FROM fin.extracto_linea l WHERE l.cuenta_id = $1 AND l.compensa_a IS NULL
                                       AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)`, [cuenta])).rows[0].n) };
    const { rows: todas } = await c.query(
      `SELECT l.id, to_char(l.fecha, 'YYYY-MM-DD') AS fecha, l.concepto, l.referencia, l.importe::text, l.operacion, l.compensa_a,
              EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id) AS conciliada
         FROM fin.extracto_linea l WHERE l.cuenta_id = $1 ORDER BY l.fecha, l.id`, [cuenta]);
    const pend = todas.filter(l => !l.conciliada && !l.compensa_a), usadas = new Set();
    const conciliar = (linea, mov) => c.query('INSERT INTO fin.conciliacion (linea_id, movimiento_id) VALUES ($1,$2)', [linea, mov]);

    // 1. Reversos.
    let compensadas = 0;
    for (const rv of pend.filter(esReverso)) {
      if (usadas.has(rv.id)) continue;
      const o = pend.find(l => !usadas.has(l.id) && l.id !== rv.id && !esReverso(l) && l.concepto === rv.concepto && normImp(l.importe) === normImp(opuesto(rv.importe)));
      if (!o) continue;
      await c.query('UPDATE fin.extracto_linea SET compensa_a = CASE id WHEN $1::bigint THEN $2::bigint ELSE $1::bigint END WHERE id IN ($1, $2)', [rv.id, o.id]);
      usadas.add(rv.id); usadas.add(o.id); compensadas += 2;
    }

    // 2. Ingresos contra los pagos de las ventas (sólo los ya procesados: su bruto está en "a acreditar").
    const { rows: pagos } = await c.query(
      `SELECT p.id, p.importe::text, to_char(t.dia, 'YYYY-MM-DD') AS dia, t.id_externo, m.cuenta_id
         FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
         JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
        WHERE mp.procesador_id = $1 AND NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL
          AND p.liquida_el IS NULL AND p.lote_id IS NULL
        ORDER BY t.dia, t.cerrado_en FOR UPDATE OF p`, [pr.id]);
    const libres = new Set(pagos.map(p => p.id));
    // Operación del procesador -> pago de la venta, con lo acreditado antes (para atar costos que llegan después).
    const { rows: previos } = await c.query(
      `SELECT l.operacion, p.id FROM pos.ticket_pago p JOIN fin.extracto_linea l ON l.id = p.acreditado_linea_id
        WHERE l.cuenta_id = $1 AND l.operacion IS NOT NULL`, [cuenta]);
    const pagoDe = new Map(previos.map(x => [x.operacion, x.id]));
    let acreditadas = 0, acreditado = 0n;
    for (const l of pend.filter(l => !usadas.has(l.id) && !l.importe.startsWith('-'))) {
      // Si el extracto dice el día de la venta ("venta del AAAA-MM-DD": Mercado Pago libera el crédito del Point a los
      // ~10 días), se parea contra ese día (o el anterior, una mesa abierta antes de medianoche); si no, hasta 4 días antes.
      const diaVenta = (String(l.concepto).match(/venta del (\d{4}-\d{2}-\d{2})/) || [])[1];
      const dias = p => (Date.parse(diaVenta || l.fecha) - Date.parse(p.dia)) / 864e5;
      const p = pagos.filter(p => libres.has(p.id) && normImp(p.importe) === normImp(l.importe) && dias(p) >= 0 && dias(p) <= (diaVenta ? 1 : 4))
        .sort((a, b) => dias(a) - dias(b))[0];
      if (!p) continue;
      libres.delete(p.id);
      const concepto = `Acreditación ${pr.nombre} · venta ${p.id_externo} del ${p.dia}`;
      const { rows: [{ id: tr }] } = await c.query('SELECT gen_random_uuid() AS id');
      await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, transferencia_id, ticket_pago_id) VALUES ($1,$2,'transferencia',$3,$4,$5,$6)`,
        [l.fecha, p.cuenta_id, l.importe, concepto, tr, p.id]);
      const { rows: [ent] } = await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, concepto, transferencia_id, ticket_pago_id) VALUES ($1,$2,'transferencia',$3,$4,$5,$6) RETURNING id`,
        [l.fecha, cuenta, l.importe, concepto, tr, p.id]);
      await conciliar(l.id, ent.id);
      await c.query('UPDATE pos.ticket_pago SET acreditado_linea_id = $1 WHERE id = $2', [l.id, p.id]);
      if (l.operacion) pagoDe.set(l.operacion, p.id);
      usadas.add(l.id); acreditadas++; acreditado += centavos(l.importe);
    }

    // 2b. Depósitos de lotes esperados (procesadores que liquidan por lotes): mismo neto, del día del lote a 5 días
    // después. Al parearlo, el lote se asienta con la fecha del depósito.
    const { rows: lotesAbiertos } = await c.query(
      `SELECT l.id, to_char(l.fecha, 'YYYY-MM-DD') AS fecha, l.neto::text FROM fin.lote l
        WHERE l.procesador_id = $1 AND l.movimiento_id IS NULL ORDER BY l.fecha`, [pr.id]);
    // Un depósito puede juntar varios lotes del mismo día (un crédito de una venta anterior con los débitos del día):
    // un lote, o la suma exacta de 2 o 3, el grupo más cercano en fecha.
    let lotesConfirmados = 0;
    for (const l of pend.filter(l => !usadas.has(l.id) && !l.importe.startsWith('-'))) {
      const grupo = grupoDeLotes(lotesAbiertos.filter(x => !x.usado), l);
      if (!grupo) continue;
      usadas.add(l.id); lotesConfirmados += grupo.length;
      for (const x of grupo) { x.usado = true; await conciliar(l.id, await asentarLote(c, x.id, l.fecha)); }
    }

    // 3. Cargos, IVA, impuestos y retenciones. El IVA de un cargo viene en su propia línea (que nombra al cargo) o
    // incluido en el cargo (Pago24 en las transferencias: "Cargo de Pago24" es 3% + IVA).
    const opDeNumero = new Map(todas.map(l => [numeroEnConcepto(l), l.operacion]).filter(([k]) => k));
    const conIvaAparte = new Set(todas.filter(l => clasificar(l) === 'iva_credito').map(l => l.operacion));
    const gastos = {};
    for (const l of pend.filter(l => !usadas.has(l.id) && l.importe.startsWith('-'))) {
      const g = clasificar(l); if (!g) continue;
      const op = g === 'iva_credito' && opDeNumero.has(l.operacion) ? opDeNumero.get(l.operacion) : l.operacion;
      const ivaIncluido = g === 'comision' && !conIvaAparte.has(numeroEnConcepto(l));
      const { rows: [mov] } = await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, gasto, iva, ticket_pago_id)
         VALUES ($1, $2, 'egreso', $3::numeric, $4, $5, CASE WHEN $6 THEN round($3::numeric * 21 / 121, 2) END, $7) RETURNING id`,
        // Con el nombre de la cuenta: en un banco donde deposita el procesador (Brubank) el cargo puede ser del banco.
        [l.fecha, cuenta, l.importe.slice(1), `${pr.cuenta} · ${l.concepto}`.slice(0, 300), g, ivaIncluido, pagoDe.get(op) || null]);
      await conciliar(l.id, mov.id);
      usadas.add(l.id); gastos[g] = (gastos[g] || 0n) + centavos(l.importe.slice(1));
    }
    // 4. Lo que quedó y reconoce una regla (VEP, mantenimiento de cuenta, transferencias propias…): se clasifica y concilia.
    const reglas = await aplicarReglas(c, cuenta);
    const quedan = pend.filter(l => !usadas.has(l.id)).length - reglas;
    return { procesador: pr.nombre, compensadas, acreditadas, acreditado: deCentavos(acreditado), quedan, lotes_confirmados: lotesConfirmados, reglas,
             gastos: Object.fromEntries(Object.entries(gastos).map(([k, v]) => [k, deCentavos(v)])) };
  });
  return { ...out, lotes_liquidados: liquidados ? liquidados.lotes.length : 0 };
}
r.post('/fin/conciliacion/automatica', h(async (req, res) => {
  res.status(201).json({ ok: true, ...await conciliarAutomatica(req, texto(req.body.cuenta_id, { campo: 'la cuenta', requerido: true })) });
}));

// Pareos sugeridos (decisión de Fer, 25/10/2026): lo que la conciliación automática no parea porque no coincide
// exacto, se propone para confirmar con un toque. Nunca se aplica solo.
//   · división: una venta pagada en partes (2 o 3 ingresos que suman exacto un cobro sin acreditar);
//   · diferencia: un ingreso que difiere del cobro hasta el 10% o $5.000 (lo que sea mayor); al confirmar se dice
//     el motivo. Ventana de fechas, la de la automática: del día de la venta hasta 4 días después.
const TOLERANCIA = P => { const d = P / 10n; return d > 500000n ? d : 500000n; };   // centavos
// Un cobro cargado en el sistema de venta con otro procesador: en la venta quedó anulado un pago de este procesador
// por el mismo importe y el válido es de otro (pasó en CORTAFUEGO: la venta #1276 entró por Mercado Pago y en Fudo quedó
// como Pago24). La plata llegó acá, así que se acredita acá, saliendo del "a acreditar" del otro procesador.
const OTRO_PROCESADOR_SQL = `
  SELECT p.id, p.importe::text, to_char(t.dia, 'YYYY-MM-DD') AS dia, t.id_externo, mp.tipo_operacion, m.cuenta_id, opr.nombre AS procesador_cargado
    FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
    JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id JOIN fin.procesador opr ON opr.id = mp.procesador_id
   WHERE mp.procesador_id <> $1 AND NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL
     AND p.liquida_el IS NULL AND p.lote_id IS NULL
     AND EXISTS (SELECT 1 FROM pos.ticket_pago a JOIN pos.medio am ON am.id = a.medio_id JOIN fin.medio_pago amp ON amp.id = am.medio_pago_id
                  WHERE a.ticket_id = p.ticket_id AND a.anulado AND amp.procesador_id = $1 AND a.importe = p.importe)`;

// Un cobro del procesador que en el sistema de venta quedó como efectivo (decisión de Fer, 02/11/2026: el efectivo de octubre
// no se controló al detalle; si importe y día coinciden, estaba mal cargado). Pagos en efectivo ya procesados de los puntos de
// venta que cobran con el procesador de la cuenta (SORELLE BODEGON Y SUSHI y SORELLE CAFETERIA comparten la cuenta de Mercado
// Pago); se acredita saliendo de la cuenta de efectivo del punto de venta.
const EN_EFECTIVO_SQL = `
  SELECT p.id, p.importe::text, to_char(t.dia, 'YYYY-MM-DD') AS dia, t.id_externo, mp.tipo_operacion, m.cuenta_id, i.nombre AS punto_venta
    FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
    JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id JOIN pos.integracion i ON i.id = t.integracion_id
   WHERE mp.tipo_operacion = 'efectivo' AND NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL
     AND i.id IN (SELECT pm.integracion_id FROM pos.medio pm JOIN fin.medio_pago pmp ON pmp.id = pm.medio_pago_id JOIN fin.procesador pr ON pr.id = pmp.procesador_id
                   WHERE pr.cuenta_acredita_id = $1::uuid)`;
// El día de la venta de una línea: el que dice el concepto ("venta del AAAA-MM-DD", Mercado Pago) o el de la línea.
const diaVentaDe = l => (String(l.concepto).match(/venta del (\d{4}-\d{2}-\d{2})/) || [])[1] || l.fecha;

async function sugerenciasProcesador(cuenta) {
  const { rows: [pr] } = await pool.query('SELECT id FROM fin.procesador WHERE cuenta_acredita_id = $1::uuid', [cuenta]);
  if (!pr) return [];
  const [{ rows: lineas }, { rows: pagos }] = await Promise.all([
    pool.query(`SELECT l.id, to_char(l.fecha, 'YYYY-MM-DD') AS fecha, l.importe::text, l.concepto FROM fin.extracto_linea l
                 WHERE l.cuenta_id = $1::uuid AND l.importe > 0 AND l.compensa_a IS NULL
                   AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id) ORDER BY l.fecha, l.id`, [cuenta]),
    pool.query(`SELECT p.id, p.importe::text, to_char(t.dia, 'YYYY-MM-DD') AS dia, t.id_externo, mp.tipo_operacion
                  FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
                  JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
                 WHERE mp.procesador_id = $1 AND NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL
                   AND p.liquida_el IS NULL AND p.lote_id IS NULL
                 ORDER BY t.dia`, [pr.id]),
  ]);
  const dias = (l, p) => (Date.parse(l.fecha) - Date.parse(p.dia)) / 864e5, enVentana = (l, p) => dias(l, p) >= 0 && dias(l, p) <= 4;
  const abs = v => v < 0n ? -v : v, sug = [];
  // Un procesador que liquida por lotes no se parea cobro por cobro: sus sugerencias son las de lote (más abajo).
  const { rows: [{ por_lotes: porLotes }] } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM fin.lote WHERE procesador_id = $1) OR EXISTS (
              SELECT 1 FROM pos.ticket_pago p JOIN pos.medio m ON m.id = p.medio_id JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
               WHERE mp.procesador_id = $1 AND p.liquida_el IS NOT NULL) AS por_lotes`, [pr.id]);
  if (porLotes) pagos.length = 0;
  for (const p of pagos) {
    const P = centavos(p.importe), ls = lineas.filter(l => enVentana(l, p) && centavos(l.importe) < P);
    let mejor = null;
    const probar = grupo => {
      if (grupo.reduce((s, l) => s + centavos(l.importe), 0n) !== P) return;
      const lejos = Math.max(...grupo.map(l => dias(l, p)));
      if (!mejor || lejos < mejor.lejos || (lejos === mejor.lejos && grupo.length < mejor.lineas.length)) mejor = { lejos, lineas: grupo };
    };
    for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
      probar([ls[i], ls[j]]);
      if (ls.length <= 40) for (let k = j + 1; k < ls.length; k++) probar([ls[i], ls[j], ls[k]]);
    }
    if (mejor) sug.push({ tipo: 'division', pago: p, lineas: mejor.lineas.map(l => l.id) });
  }
  // Depósitos de procesadores que liquidan por lotes y que no coinciden exacto con sus lotes (lo exacto lo hace la
  // automática): el lote del día más un cobro pendiente sin neto informado (Fudo no informa el neto de algunos) que
  // explica la diferencia con un costo de hasta el 15%; si no, el lote con la diferencia, a confirmar con su motivo.
  const { rows: lotesAb } = await pool.query(
    `SELECT l.id, to_char(l.fecha, 'YYYY-MM-DD') AS fecha, l.neto::text, l.pagos FROM fin.lote l
      WHERE l.procesador_id = $1 AND l.movimiento_id IS NULL ORDER BY l.fecha`, [pr.id]);
  if (lotesAb.length) {
    const { rows: sinNeto } = await pool.query(
      `SELECT p.id, p.importe::text, to_char(t.dia, 'YYYY-MM-DD') AS dia, t.id_externo, m.nombre AS medio
         FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
         JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
        WHERE mp.procesador_id = $1 AND NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL
          AND p.lote_id IS NULL AND p.neto IS NULL ORDER BY t.dia`, [pr.id]);
    // Cada depósito con cada lote de su ventana: lo que explica un cobro sin neto, o una diferencia razonable (hasta el
    // 15% del lote o $5.000). Después, cada lote y cada cobro se proponen una sola vez, primero los pares que mejor
    // se explican (un cobro antes que una diferencia; la diferencia más chica).
    const cand = [];
    for (const l of lineas) {
      const dias = x => (Date.parse(l.fecha) - Date.parse(x.fecha)) / 864e5, L = centavos(l.importe);
      for (const lote of lotesAb.filter(x => dias(x) >= -1 && dias(x) <= 5)) {
        const N = centavos(lote.neto), D = L - N, absD = D < 0n ? -D : D;
        if (D === 0n) continue;
        const cobros = D > 0n ? sinNeto.filter(p => (Date.parse(l.fecha) - Date.parse(p.dia)) / 864e5 >= 0 && centavos(p.importe) >= D && D * 100n >= centavos(p.importe) * 85n) : [];
        for (const p of cobros) cand.push({ orden: 0, peso: Number(centavos(p.importe) - D), dias: Math.abs(dias(lote)), l, lote, p, D });
        if (absD * 100n <= N * 15n || absD <= 500000n) cand.push({ orden: 1, peso: Number(absD), dias: Math.abs(dias(lote)), l, lote, D });
      }
    }
    cand.sort((a, b) => a.orden - b.orden || a.peso - b.peso || a.dias - b.dias);
    const usL = new Set(), usLote = new Set(), usP = new Set();
    for (const x of cand) {
      if (usL.has(x.l.id) || usLote.has(x.lote.id) || (x.p && usP.has(x.p.id))) continue;
      usL.add(x.l.id); usLote.add(x.lote.id); if (x.p) usP.add(x.p.id);
      sug.push(x.p ? { tipo: 'lote_cobro', lineas: [x.l.id], lotes: [x.lote], pago: x.p, neto_pago: deCentavos(x.D) }
                   : { tipo: 'lote_diferencia', lineas: [x.l.id], lotes: [x.lote], diferencia: deCentavos(x.D) });
    }
  }
  const enDivision = new Set(sug.flatMap(x => x.lineas));
  for (const l of lineas) {
    if (enDivision.has(l.id)) continue;
    const L = centavos(l.importe);
    const p = pagos.filter(p => enVentana(l, p) && L !== centavos(p.importe) && abs(L - centavos(p.importe)) <= TOLERANCIA(centavos(p.importe)))
      .sort((a, b) => Number(abs(L - centavos(a.importe)) - abs(L - centavos(b.importe))) || dias(l, a) - dias(l, b))[0];
    if (p) sug.push({ tipo: 'diferencia', pago: p, lineas: [l.id], diferencia: deCentavos(L - centavos(p.importe)) });
  }
  // Lo que sigue sin sugerencia: un cobro de la venta cargado con otro procesador, por el mismo importe.
  const conSug = new Set(sug.flatMap(x => x.lineas));
  const { rows: otros } = await pool.query(OTRO_PROCESADOR_SQL, [pr.id]);
  const usados = new Set();
  for (const l of lineas.filter(l => !conSug.has(l.id))) {
    const p = otros.filter(p => !usados.has(p.id) && centavos(p.importe) === centavos(l.importe) && enVentana(l, p)).sort((a, b) => dias(l, a) - dias(l, b))[0];
    if (p) { usados.add(p.id); sug.push({ tipo: 'otro_procesador', pago: p, lineas: [l.id] }); }
  }
  // Y lo que todavía queda: un pago de la misma filial cargado como efectivo, mismo importe, del día de la venta o el anterior.
  const conSug2 = new Set(sug.flatMap(x => x.lineas));
  const { rows: efectivo } = await pool.query(EN_EFECTIVO_SQL, [cuenta]);
  const diasV = (l, p) => (Date.parse(diaVentaDe(l)) - Date.parse(p.dia)) / 864e5;
  for (const l of lineas.filter(l => !conSug2.has(l.id))) {
    const p = efectivo.filter(p => !usados.has(p.id) && centavos(p.importe) === centavos(l.importe) && diasV(l, p) >= 0 && diasV(l, p) <= 1)
      .sort((a, b) => diasV(l, a) - diasV(l, b))[0];
    if (p) { usados.add(p.id); sug.push({ tipo: 'en_efectivo', pago: p, lineas: [l.id] }); }
  }
  return sug;
}

// Confirmar un pareo sugerido (o armado a mano): el cobro sale entero de "a acreditar" y entra a la cuenta real lo
// que llegó, una pata por línea, cada una conciliada con la suya. Con diferencia, las patas no son iguales: la
// diferencia (con su motivo) queda en el concepto.
r.post('/fin/conciliacion/acreditar', h(async (req, res) => {
  const b = req.body, pagoId = texto(b.ticket_pago_id, { campo: 'el cobro', requerido: true });
  const ids = (Array.isArray(b.linea_ids) ? b.linea_ids : []).map(x => numero(x, { campo: 'la línea', requerido: true }));
  if (!ids.length || ids.length > 5) throw new ErrorUsuario('Elegí entre una y cinco líneas del extracto.');
  const motivo = texto(b.motivo);
  await enTransaccion(async c => {
    const { rows: ls } = await c.query(
      `SELECT l.id, l.cuenta_id, to_char(l.fecha, 'YYYY-MM-DD') AS fecha, l.importe::text, l.compensa_a,
              EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id) AS conciliada
         FROM fin.extracto_linea l WHERE l.id = ANY($1::bigint[]) ORDER BY l.fecha, l.id FOR UPDATE`, [ids]);
    if (ls.length !== new Set(ids).size) throw new ErrorUsuario('Alguna de las líneas no existe.');
    const cuenta = ls[0].cuenta_id;
    if (ls.some(l => l.cuenta_id !== cuenta)) throw new ErrorUsuario('Las líneas son de cuentas distintas.');
    if (ls.some(l => l.conciliada || l.compensa_a)) throw new ErrorUsuario('Alguna de las líneas ya está conciliada.');
    if (ls.some(l => l.importe.startsWith('-'))) throw new ErrorUsuario('Sólo se acreditan ingresos.');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['conciliar:' + cuenta]);
    const { rows: [pr] } = await c.query('SELECT id, nombre FROM fin.procesador WHERE cuenta_acredita_id = $1', [cuenta]);
    if (!pr) throw new ErrorUsuario('La cuenta no es la de un procesador.');
    // Un cobro cargado con otro procesador sólo si la venta tiene anulado un pago de éste por el mismo importe.
    const otro = b.otro_procesador === true, efectivo = b.en_efectivo === true;
    const { rows: [p] } = otro
      ? await c.query(`SELECT * FROM (${OTRO_PROCESADOR_SQL}) x WHERE x.id = $2::uuid`, [pr.id, pagoId])
      : efectivo ? await c.query(`SELECT * FROM (${EN_EFECTIVO_SQL}) x WHERE x.id = $2::uuid`, [cuenta, pagoId])
      : await c.query(
        `SELECT p.id, p.importe::text, t.id_externo, to_char(t.dia, 'YYYY-MM-DD') AS dia, m.cuenta_id
           FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
           JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
          WHERE p.id = $1::uuid AND mp.procesador_id = $2 AND NOT p.anulado AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL
          FOR UPDATE OF p`, [pagoId, pr.id]);
    if (!p) throw new ErrorUsuario('Ese cobro no está pendiente de acreditar con este procesador (o sus cobros no se procesaron).');
    if (otro || efectivo) await c.query('SELECT 1 FROM pos.ticket_pago WHERE id = $1 FOR UPDATE', [p.id]);
    if ((otro || efectivo) && (ls.length > 1 || centavos(ls[0].importe) !== centavos(p.importe)))
      throw new ErrorUsuario(`Un cobro cargado ${otro ? 'con otro procesador' : 'como efectivo'} se acredita sólo por el mismo importe.`);
    const P = centavos(p.importe), L = ls.reduce((s, l) => s + centavos(l.importe), 0n), D = L - P;
    // Pareo manual (pedido de Fer, 08/11/2026): quien concilia elige el cobro; cualquier diferencia, con su motivo.
    const manual = b.manual === true && !otro && !efectivo;
    if (ls.length > 1 && D !== 0n) throw new ErrorUsuario(`Las líneas suman ${deCentavos(L)} y el cobro es de ${p.importe}: en partes, tienen que sumar exacto.`);
    if (D !== 0n) {
      if (!manual && (D < 0n ? -D : D) > TOLERANCIA(P)) throw new ErrorUsuario('La diferencia es demasiado grande para parearlos: registrá la línea como movimiento.');
      if (!motivo) throw new ErrorUsuario('Indicá el motivo de la diferencia.');
    }
    const concepto = `Acreditación ${pr.nombre} · venta ${p.id_externo} del ${p.dia}` + (otro ? ` · cargada en el sistema de venta con ${p.procesador_cargado}` : '')
      + (efectivo ? ' · cargada en el sistema de venta como efectivo' : '')
      + (ls.length > 1 ? ` · en ${ls.length} partes` : '')
      + (D !== 0n ? ` · diferencia ${deCentavos(D)}: ${motivo}` : '');
    const { rows: [{ id: tr }] } = await c.query('SELECT gen_random_uuid() AS id');
    await c.query(
      `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, transferencia_id, ticket_pago_id) VALUES ($1,$2,'transferencia',$3,$4,$5,$6)`,
      [ls[0].fecha, p.cuenta_id, p.importe, concepto, tr, p.id]);
    for (const l of ls) {
      const { rows: [ent] } = await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, concepto, transferencia_id, ticket_pago_id) VALUES ($1,$2,'transferencia',$3,$4,$5,$6) RETURNING id`,
        [l.fecha, cuenta, l.importe, concepto, tr, p.id]);
      await c.query('INSERT INTO fin.conciliacion (linea_id, movimiento_id) VALUES ($1,$2)', [l.id, ent.id]);
    }
    await c.query('UPDATE pos.ticket_pago SET acreditado_linea_id = $1 WHERE id = $2', [ls[0].id, p.id]);
  });
  res.status(201).json({ ok: true });
}));

// Un cobro que no va a llegar por su procesador (pedido de Fer, 08/11/2026): se cobró en efectivo y quedó mal cargado en el
// sistema de venta (pasa de "a acreditar" al efectivo a rendir del punto de venta), o no llega (egreso de "a acreditar", con su
// motivo, a Diferencias). Se deshace anulando el movimiento.
r.post('/fin/conciliacion/cobro-resuelto', h(async (req, res) => {
  const b = req.body, pagoId = texto(b.ticket_pago_id, { campo: 'el cobro', requerido: true });
  const como = b.como === 'efectivo' ? 'efectivo' : b.como === 'no_llega' ? 'no_llega' : null;
  if (!como) throw new ErrorUsuario('Elegí si se cobró en efectivo o no va a llegar.');
  const motivo = texto(b.motivo);
  if (!motivo) throw new ErrorUsuario('Indicá el motivo.');
  await enTransaccion(async c => {
    const { rows: [p] } = await c.query(
      `SELECT p.id, p.importe::text, t.id_externo, to_char(t.dia, 'YYYY-MM-DD') AS dia, m.cuenta_id, pr.nombre AS procesador,
              i.cuenta_efectivo_id, i.nombre AS punto_venta
         FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.integracion i ON i.id = t.integracion_id
         JOIN pos.medio m ON m.id = p.medio_id JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id JOIN fin.procesador pr ON pr.id = mp.procesador_id
        WHERE p.id = $1::uuid AND NOT p.anulado AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL
          AND p.lote_id IS NULL
        FOR UPDATE OF p`, [pagoId]);
    if (!p) throw new ErrorUsuario('Ese cobro no está pendiente de acreditar (o sus cobros no se procesaron).');
    let mov;
    if (como === 'efectivo') {
      if (!p.cuenta_efectivo_id) throw new ErrorUsuario(`${p.punto_venta} no tiene cuenta de efectivo.`);
      const concepto = `Cobro de la venta ${p.id_externo} del ${p.dia}: cargado con ${p.procesador}, se cobró en efectivo · ${motivo}`;
      const { rows: [{ id: tr }] } = await c.query('SELECT gen_random_uuid() AS id');
      ({ rows: [{ id: mov }] } = await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, transferencia_id, ticket_pago_id) VALUES ($1,$2,'transferencia',$3,$4,$5,$6) RETURNING id`,
        [p.dia, p.cuenta_id, p.importe, concepto, tr, p.id]));
      await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, concepto, transferencia_id, ticket_pago_id) VALUES ($1,$2,'transferencia',$3,$4,$5,$6)`,
        [p.dia, p.cuenta_efectivo_id, p.importe, concepto, tr, p.id]);
    } else {
      ({ rows: [{ id: mov }] } = await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, gasto, ticket_pago_id) VALUES ($1,$2,'egreso',$3,$4,'otro',$5) RETURNING id`,
        [p.dia, p.cuenta_id, p.importe, `Cobro que no llega · ${p.procesador} · venta ${p.id_externo} del ${p.dia}: ${motivo}`, p.id]));
      // En el estado de resultados, a Diferencias (como una acreditación con diferencia), en el día de la venta.
      await c.query(`INSERT INTO fin.clasificacion (movimiento_id, rubro_id) SELECT $1, id FROM fin.rubro WHERE clave = 'dif_acreditacion'`, [mov]);
    }
    await c.query('UPDATE pos.ticket_pago SET resuelto_movimiento_id = $1, resuelto_como = $2 WHERE id = $3', [mov, como, p.id]);
  });
  res.status(201).json({ ok: true });
}));
r.delete('/fin/conciliacion/cobro-resuelto/:pago', h(async (req, res) => {
  await enTransaccion(async c => {
    const { rows: [p] } = await c.query(
      `SELECT p.resuelto_movimiento_id AS mov, m.transferencia_id FROM pos.ticket_pago p JOIN fin.movimiento_tes m ON m.id = p.resuelto_movimiento_id
        WHERE p.id = $1::uuid FOR UPDATE OF p`, [req.params.pago]);
    if (!p) throw new ErrorUsuario('Ese cobro no está resuelto.');
    const { rows: patas } = await c.query(
      `SELECT * FROM fin.movimiento_tes x WHERE (x.id = $1 OR ($2::uuid IS NOT NULL AND x.transferencia_id = $2::uuid)) AND x.tipo <> 'anulacion'
          AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = x.id)`, [p.mov, p.transferencia_id]);
    for (const x of patas)
      await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, transferencia_id, anula_a) VALUES ($1,$2,'anulacion',$3,$4,$5,$6,$7)`,
        [x.fecha, x.cuenta_id, x.salida, x.entrada, 'Anula (se deshizo): ' + x.concepto, x.transferencia_id, x.id]);
    await c.query('UPDATE pos.ticket_pago SET resuelto_movimiento_id = NULL, resuelto_como = NULL WHERE id = $1', [req.params.pago]);
  });
  res.json({ ok: true });
}));

// Confirmar un depósito contra sus lotes: la suma de los lotes, más un cobro sin neto informado (se arma su lote con
// el neto que explica el depósito) o más la diferencia con su motivo (queda como ingreso o egreso de la cuenta).
r.post('/fin/conciliacion/lote', h(async (req, res) => {
  const b = req.body, linea = numero(b.linea_id, { campo: 'la línea', requerido: true });
  const loteIds = (Array.isArray(b.lote_ids) ? b.lote_ids : []).map(String);
  if (!loteIds.length) throw new ErrorUsuario('Elegí el lote.');
  const pagoId = texto(b.ticket_pago_id), motivo = texto(b.motivo);
  await enTransaccion(async c => {
    const { rows: [l] } = await c.query(
      `SELECT l.id, l.cuenta_id, to_char(l.fecha, 'YYYY-MM-DD') AS fecha, l.importe::text, l.compensa_a,
              EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id) AS conciliada FROM fin.extracto_linea l WHERE l.id = $1 FOR UPDATE`, [linea]);
    if (!l) throw new ErrorUsuario('No existe esa línea del extracto.');
    if (l.conciliada || l.compensa_a) throw new ErrorUsuario('La línea ya está conciliada.');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['conciliar:' + l.cuenta_id]);
    const { rows: [pr] } = await c.query('SELECT id, nombre FROM fin.procesador WHERE cuenta_acredita_id = $1', [l.cuenta_id]);
    if (!pr) throw new ErrorUsuario('La cuenta no es la de un procesador.');
    const { rows: lotes } = await c.query(
      `SELECT l.id, l.neto::text FROM fin.lote l WHERE l.id = ANY($1::uuid[]) AND l.procesador_id = $2 AND l.movimiento_id IS NULL FOR UPDATE`, [loteIds, pr.id]);
    if (lotes.length !== loteIds.length) throw new ErrorUsuario('Algún lote ya está confirmado o no es de este procesador.');
    const movs = [];
    for (const x of lotes) movs.push(await asentarLote(c, x.id, l.fecha));
    const D = centavos(l.importe) - lotes.reduce((s, x) => s + centavos(x.neto), 0n);
    if (pagoId) {
      const { rows: [p] } = await c.query(
        `SELECT p.id, p.importe::text, t.id_externo, m.cuenta_id FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id
           JOIN pos.medio m ON m.id = p.medio_id JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
          WHERE p.id = $1::uuid AND mp.procesador_id = $2 AND NOT p.anulado AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL AND p.lote_id IS NULL
          FOR UPDATE OF p`, [pagoId, pr.id]);
      if (!p) throw new ErrorUsuario('Ese cobro no está pendiente de acreditar con este procesador.');
      if (D <= 0n || D > centavos(p.importe)) throw new ErrorUsuario('El cobro no explica la diferencia del depósito.');
      const concepto = `Lote ${pr.nombre} del ${l.fecha} · cobro de la venta ${p.id_externo} (neto según el depósito)`;
      const { rows: [{ id: tr }] } = await c.query('SELECT gen_random_uuid() AS id');
      await c.query(`INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, transferencia_id) VALUES ($1,$2,'transferencia',$3,$4,$5)`,
        [l.fecha, p.cuenta_id, deCentavos(D), concepto, tr]);
      const { rows: [ent] } = await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, concepto, transferencia_id) VALUES ($1,$2,'transferencia',$3,$4,$5) RETURNING id`,
        [l.fecha, l.cuenta_id, deCentavos(D), concepto, tr]);
      const costo = centavos(p.importe) - D;
      const { rows: [cm] } = costo > 0n ? await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, gasto) VALUES ($1,$2,'egreso',$3,$4,'comision') RETURNING id`,
        [l.fecha, p.cuenta_id, deCentavos(costo), `Cargos ${pr.nombre} · cobro de la venta ${p.id_externo}`]) : { rows: [{}] };
      const { rows: [nl] } = await c.query(
        `INSERT INTO fin.lote (procesador_id, fecha, pagos, bruto, neto, movimiento_id, costo_movimiento_id, desde_linea_id) VALUES ($1,$2,1,$3,$4,$5,$6,$7) RETURNING id`,
        [pr.id, l.fecha, p.importe, deCentavos(D), ent.id, cm.id || null, l.id]);
      await c.query('UPDATE pos.ticket_pago SET lote_id = $1, neto = $2, liquida_el = $3 WHERE id = $4', [nl.id, deCentavos(D), l.fecha, p.id]);
      movs.push(ent.id);
    } else if (D !== 0n) {
      if (!motivo) throw new ErrorUsuario('Indicá el motivo de la diferencia.');
      const neg = D < 0n, abs = neg ? -D : D;
      const { rows: [dm] } = await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, gasto) VALUES ($1,$2,$3,$4,$5,$6,'otro') RETURNING id`,
        [l.fecha, l.cuenta_id, neg ? 'egreso' : 'ingreso', neg ? 0 : deCentavos(abs), neg ? deCentavos(abs) : 0, `Diferencia con el lote de ${pr.nombre}: ${motivo}`]);
      movs.push(dm.id);
    }
    for (const m of movs) await c.query('INSERT INTO fin.conciliacion (linea_id, movimiento_id) VALUES ($1,$2)', [l.id, m]);
  });
  res.status(201).json({ ok: true });
}));

// Resumen de la cuenta de un procesador: saldo contra el extracto, lo vendido que falta acreditar (por día) y el
// costo real de cada tipo de operación (lo acreditado contra sus cargos e impuestos).
async function resumenProcesador(cuenta) {
  const { rows: [pr] } = await pool.query(
    `SELECT p.id, p.nombre, p.cuenta_id AS cuenta_pendiente, cp.nombre AS cuenta_pendiente_nombre, sp.saldo::text AS saldo_pendiente,
            sc.saldo::text AS saldo_sistema
       FROM fin.procesador p JOIN fin.cuenta cp ON cp.id = p.cuenta_id JOIN fin.saldo_cuenta sp ON sp.cuenta_id = cp.id
       JOIN fin.saldo_cuenta sc ON sc.cuenta_id = p.cuenta_acredita_id
      WHERE p.cuenta_acredita_id = $1::uuid`, [cuenta]);
  if (!pr) return null;
  const { rows: pendLineas } = await pool.query(
    `SELECT l.concepto, l.referencia, l.importe::text FROM fin.extracto_linea l WHERE l.cuenta_id = $1 AND l.compensa_a IS NULL
        AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)`, [cuenta]);
  const porLado = { ingresos: 0, egresos: 0 };
  for (const l of pendLineas) porLado[ladoDe(l)]++;
  const [{ rows: [ext] }, { rows: pendientes }, { rows: costos }, { rows: [sinLinea] }] = await Promise.all([
    pool.query(`SELECT to_char(MAX(hasta), 'YYYY-MM-DD') AS hasta,
                       (SELECT saldo_final::text FROM fin.extracto WHERE cuenta_id = $1 AND saldo_final IS NOT NULL ORDER BY hasta DESC, importado_en DESC LIMIT 1) AS saldo_final,
                       (SELECT COUNT(*)::int FROM fin.extracto_linea l WHERE l.cuenta_id = $1 AND l.compensa_a IS NULL
                           AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)) AS lineas_pendientes,
                       (SELECT COALESCE(SUM(l.importe), 0)::text FROM fin.extracto_linea l WHERE l.cuenta_id = $1 AND l.compensa_a IS NULL
                           AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)) AS importe_pendiente
                  FROM fin.extracto WHERE cuenta_id = $1`, [cuenta]),
    pool.query(`SELECT to_char(t.dia, 'YYYY-MM-DD') AS dia, mp.tipo_operacion, COUNT(*)::int AS pagos, SUM(p.importe)::text AS importe,
                       (current_date - t.dia)::int AS dias
                  FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
                  JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
                 WHERE mp.procesador_id = $1 AND NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL
                   AND p.liquida_el IS NULL AND p.lote_id IS NULL
                 GROUP BY t.dia, mp.tipo_operacion ORDER BY t.dia, mp.tipo_operacion`, [pr.id]),
    // Costo de cada cobro acreditado: los gastos conciliados de la misma operación del procesador (la de sus líneas
    // de acreditación), por el número de operación del extracto y no por el movimiento: así cuentan también los
    // cargos asentados antes de confirmar un pareo sugerido. El IVA de un cargo nombra al cargo, no a la operación.
    pool.query(`WITH acl AS (
                  SELECT DISTINCT e.ticket_pago_id AS pago, l.operacion FROM fin.movimiento_tes e
                    JOIN fin.conciliacion k ON k.movimiento_id = e.id JOIN fin.extracto_linea l ON l.id = k.linea_id
                   WHERE e.cuenta_id = $1 AND e.gasto IS NULL AND e.ticket_pago_id IS NOT NULL),
                ap AS (
                  SELECT p.id, p.importe, mp.tipo_operacion FROM pos.ticket_pago p JOIN pos.medio m ON m.id = p.medio_id
                    JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id WHERE p.id IN (SELECT pago FROM acl)),
                gl AS (
                  SELECT l.id, l.operacion, substring(l.concepto from '([0-9]{6,})') AS numero, m.gasto, m.salida, COALESCE(m.iva, 0) AS iva
                    FROM fin.conciliacion k JOIN fin.extracto_linea l ON l.id = k.linea_id JOIN fin.movimiento_tes m ON m.id = k.movimiento_id
                   WHERE l.cuenta_id = $1 AND m.gasto IS NOT NULL),
                gop AS (
                  SELECT gl.*, COALESCE((SELECT c.operacion FROM gl c WHERE gl.gasto = 'iva_credito' AND c.numero = gl.operacion AND c.gasto <> 'iva_credito' LIMIT 1), gl.operacion) AS op
                    FROM gl),
                g AS (
                  SELECT DISTINCT ON (gop.id) gop.id, ap.tipo_operacion, gop.gasto, gop.salida, gop.iva
                    FROM gop JOIN acl ON acl.operacion = gop.op JOIN ap ON ap.id = acl.pago)
                SELECT t.tipo_operacion, t.pagos, t.bruto::text,
                       COALESCE(SUM(g.salida) FILTER (WHERE g.gasto = 'comision'), 0)::text AS comision,
                       (COALESCE(SUM(g.iva) FILTER (WHERE g.gasto = 'comision'), 0) + COALESCE(SUM(g.salida) FILTER (WHERE g.gasto = 'iva_credito'), 0))::text AS iva,
                       COALESCE(SUM(g.salida) FILTER (WHERE g.gasto = 'imp_debitos_creditos'), 0)::text AS imp_debitos_creditos,
                       COALESCE(SUM(g.salida) FILTER (WHERE g.gasto = 'retencion'), 0)::text AS retencion,
                       COALESCE(SUM(g.salida), 0)::text AS costo,
                       round(COALESCE(SUM(g.salida), 0) / NULLIF(t.bruto, 0) * 100, 2)::text AS costo_pct
                  FROM (SELECT tipo_operacion, COUNT(*)::int AS pagos, SUM(importe) AS bruto FROM ap GROUP BY tipo_operacion) t
                  LEFT JOIN g ON g.tipo_operacion = t.tipo_operacion
                 GROUP BY t.tipo_operacion, t.pagos, t.bruto ORDER BY t.bruto DESC`, [cuenta]),
    pool.query(`SELECT COUNT(*)::int AS movimientos, COALESCE(SUM(salida), 0)::text AS importe FROM fin.movimiento_tes
                 WHERE cuenta_id = $1 AND gasto IS NOT NULL AND ticket_pago_id IS NULL`, [cuenta]),
  ]);
  // Lotes: los liquidados (confirmados o esperando el banco) y los que todavía no llegaron a su fecha; el costo de los
  // cobros liquidados por lote es exacto por cobro (bruto menos el neto que informó el procesador).
  const [{ rows: lotes }, { rows: porLiquidar }, { rows: costosLote }] = await Promise.all([
    pool.query(`SELECT l.id, to_char(l.fecha, 'YYYY-MM-DD') AS fecha, l.pagos, l.bruto::text, l.neto::text, (current_date - l.fecha)::int AS dias,
                       l.movimiento_id IS NOT NULL AS confirmado
                  FROM fin.lote l WHERE l.procesador_id = $1 ORDER BY l.fecha DESC LIMIT 60`, [pr.id]),
    pool.query(`SELECT to_char(p.liquida_el, 'YYYY-MM-DD') AS fecha, COUNT(*)::int AS pagos, SUM(p.importe)::text AS bruto, SUM(p.neto)::text AS neto,
                       bool_and(p.cobro_id IS NOT NULL) AS procesados
                  FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
                  JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
                 WHERE mp.procesador_id = $1 AND NOT p.anulado AND t.estado = 'cerrado' AND p.lote_id IS NULL AND p.liquida_el IS NOT NULL
                 GROUP BY p.liquida_el ORDER BY p.liquida_el`, [pr.id]),
    pool.query(`SELECT mp.tipo_operacion, COUNT(*)::int AS pagos, SUM(p.importe)::text AS bruto, SUM(p.importe - p.neto)::text AS costo,
                       round(SUM(p.importe - p.neto) / NULLIF(SUM(p.importe), 0) * 100, 2)::text AS costo_pct
                  FROM pos.ticket_pago p JOIN pos.medio m ON m.id = p.medio_id JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
                 WHERE mp.procesador_id = $1 AND p.lote_id IS NOT NULL GROUP BY mp.tipo_operacion ORDER BY SUM(p.importe) DESC`, [pr.id]),
  ]);
  const todosCostos = [...costos, ...costosLote.map(x => ({ ...x, comision: x.costo, iva: '0', imp_debitos_creditos: '0', retencion: '0' }))];
  return { ...pr, extracto: { ...ext, lineas_ingresos: porLado.ingresos, lineas_egresos: porLado.egresos }, pendientes, costos: todosCostos, gastos_sin_venta: sinLinea, lotes, por_liquidar: porLiquidar };
}

// Las cuentas de los procesadores, para el proceso de ingresos: dónde deposita cada uno, hasta cuándo llega su último
// extracto, qué falta resolver y qué falta acreditar. Un procesador sin "Deposita en" viene igual, para avisarlo.
r.get('/fin/procesadores/resumen', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, p.marca, p.cuenta_acredita_id, c.nombre AS cuenta, p.portal_credenciales IS NOT NULL AS portal, p.portal_auto,
            (SELECT json_build_object('automatica', k.automatica, 'desde', k.desde, 'hasta', k.hasta, 'iniciada_en', k.iniciada_en, 'ok', k.ok,
                                      'resultado', k.resultado, 'error', k.error)
               FROM fin.portal_corrida k WHERE k.procesador_id = p.id ORDER BY k.iniciada_en DESC LIMIT 1) AS ultima_corrida
       FROM fin.procesador p LEFT JOIN fin.cuenta c ON c.id = p.cuenta_acredita_id
      WHERE p.activo ORDER BY p.nombre`);
  const out = [];
  for (const p of rows) out.push({ id: p.id, nombre: p.nombre, marca: p.marca, cuenta_id: p.cuenta_acredita_id, cuenta: p.cuenta,
    portal: p.portal, portal_auto: p.portal_auto, ultima_corrida: p.ultima_corrida,
    resumen: p.cuenta_acredita_id ? await resumenProcesador(p.cuenta_acredita_id) : null, ventas: await ventasDelProcesador(p.id) });
  res.json({ ok: true, procesadores: out });
}));

// ── Medios de pago globales ──────────────────────────────────────────────────────────────────
// Procesador (Mercado Pago, Getnet, Fudo Pagos…) + tipo de operación, más el efectivo. Cada procesador
// acredita en UNA cuenta (de cobranza): si no se elige, se crea "<procesador> a acreditar". El tipo de
// operación queda en cada cobro para calcular después el costo de operar con cada uno.
const TIPOS_OP = ['transferencia', 'qr', 'debito', 'credito', 'online', 'otro'];
// La marca del procesador (lista fija, migración 20261116): lo que se llama "procesador" es la cuenta de cobro de una empresa en
// esa marca. Los reportes agrupan por marca; la conciliación, por cuenta de cobro.
const MARCAS = ['mercadopago', 'pago24', 'fudo', 'getnet', 'pedidosya', 'otro'];
const marcaDe = nombre => /mercado\s*pago/i.test(nombre || '') ? 'mercadopago' : /pago\s*24/i.test(nombre || '') ? 'pago24' : /fudo/i.test(nombre || '') ? 'fudo'
  : /getnet/i.test(nombre || '') ? 'getnet' : /pedidos\s*ya/i.test(nombre || '') ? 'pedidosya' : 'otro';
const MEDIOS_SQL = `SELECT mp.id, mp.procesador_id, pr.nombre AS procesador, pr.marca, mp.tipo_operacion, mp.activo,
                           pr.cuenta_id, cu.nombre AS cuenta, pr.sociedad_id
                      FROM fin.medio_pago mp LEFT JOIN fin.procesador pr ON pr.id = mp.procesador_id
                      LEFT JOIN fin.cuenta cu ON cu.id = pr.cuenta_id`;
r.get('/fin/procesadores', h(async (req, res) => {
  const { rows: procesadores } = await pool.query(
    `SELECT pr.id, pr.nombre, pr.marca, pr.sociedad_id, so.nombre AS sociedad, pr.cuenta_id, cu.nombre AS cuenta, pr.activo, sc.saldo::text AS saldo,
            pr.cuenta_acredita_id, ca.nombre AS cuenta_acredita, pr.portal_url, pr.portal_credenciales IS NOT NULL AS tiene_portal, pr.portal_auto,
            (SELECT json_build_object('automatica', c.automatica, 'desde', c.desde, 'hasta', c.hasta, 'iniciada_en', c.iniciada_en, 'ok', c.ok,
                                      'resultado', c.resultado, 'error', c.error)
               FROM fin.portal_corrida c WHERE c.procesador_id = pr.id ORDER BY c.iniciada_en DESC LIMIT 1) AS ultima_corrida,
            COALESCE((SELECT json_agg(mp.tipo_operacion ORDER BY mp.tipo_operacion) FROM fin.medio_pago mp
                       WHERE mp.procesador_id = pr.id AND mp.activo), '[]') AS tipos
       FROM fin.procesador pr JOIN fin.cuenta cu ON cu.id = pr.cuenta_id JOIN fin.saldo_cuenta sc ON sc.cuenta_id = cu.id
       LEFT JOIN fin.cuenta ca ON ca.id = pr.cuenta_acredita_id LEFT JOIN org.sociedad so ON so.id = pr.sociedad_id
      ORDER BY pr.activo DESC, pr.nombre`);
  res.json({ ok: true, procesadores });
}));
function leerProcesador(b) {
  const p = { nombre: texto(b.nombre, { campo: 'el nombre del procesador', requerido: true }), cuenta_id: texto(b.cuenta_id),
              marca: texto(b.marca) || marcaDe(b.nombre),
              // Sin el campo (una pantalla que no lo manda) se conserva la sociedad que tenía.
              cuenta_acredita_id: texto(b.cuenta_acredita_id), sociedad_id: b.sociedad_id === undefined ? undefined : texto(b.sociedad_id),
              activo: b.activo === undefined ? true : !!b.activo,
              tipos: (Array.isArray(b.tipos) ? b.tipos : []).map(String),
              portal_url: texto(b.portal_url), portal_usuario: texto(b.portal_usuario), portal_clave: texto(b.portal_clave),
              portal_auto: !!b.portal_auto };
  if (!MARCAS.includes(p.marca)) throw new ErrorUsuario('Elegí el procesador: Mercado Pago, Pago24, Fudo Pagos, Getnet, PedidosYa u otro.');
  if (p.tipos.some(t => !TIPOS_OP.includes(t))) throw new ErrorUsuario('Tipo de operación inválido.');
  if (!p.tipos.length) throw new ErrorUsuario('Elegí al menos un tipo de operación (QR, transferencia, débito, crédito).');
  if (p.marca !== 'pago24') Object.assign(p, { portal_url: null, portal_usuario: null, portal_clave: null });
  if (p.portal_url && !/^https:\/\/[^\s/]+/.test(p.portal_url)) throw new ErrorUsuario('La dirección del portal empieza con https://');
  if (!!p.portal_usuario !== !!p.portal_clave) throw new ErrorUsuario('Cargá juntos el usuario y la clave del portal.');
  return p;
}
// Deja activos exactamente los tipos elegidos (los que se sacan se desactivan: puede haber cobros con ellos).
async function guardarTipos(c, procesadorId, tipos) {
  await c.query('UPDATE fin.medio_pago SET activo = false WHERE procesador_id = $1', [procesadorId]);
  for (const t of tipos) {
    const { rowCount } = await c.query('UPDATE fin.medio_pago SET activo = true WHERE procesador_id = $1 AND tipo_operacion = $2', [procesadorId, t]);
    if (!rowCount) await c.query('INSERT INTO fin.medio_pago (procesador_id, tipo_operacion) VALUES ($1, $2)', [procesadorId, t]);
  }
}
async function cuentaProcesador(c, p) {
  if (p.cuenta_id) {
    const { rows: [cu] } = await c.query('SELECT tipo FROM fin.cuenta WHERE id = $1::uuid AND activa', [p.cuenta_id]);
    if (!cu || !['cobranza', 'banco'].includes(cu.tipo)) throw new ErrorUsuario('La cuenta de un procesador es una cuenta de cobranza (o un banco).');
    return p.cuenta_id;
  }
  // La "a acreditar" es de la sociedad del procesador.
  const { rows: [n] } = await c.query(`INSERT INTO fin.cuenta (nombre, tipo, sociedad_id) VALUES ($1, 'cobranza', $2) RETURNING id`, [`${p.nombre} a acreditar`, p.sociedad_id]);
  return n.id;
}
// La cuenta donde el procesador deposita de verdad (su extracto se concilia contra los cobros): un banco, o una
// billetera cargada como banco. No puede ser la misma "a acreditar".
async function cuentaAcredita(c, p, cuentaPendiente) {
  if (!p.cuenta_acredita_id) return null;
  const { rows: [cu] } = await c.query('SELECT tipo FROM fin.cuenta WHERE id = $1::uuid AND activa', [p.cuenta_acredita_id]);
  if (!cu || cu.tipo !== 'banco') throw new ErrorUsuario('La cuenta donde deposita el procesador es una cuenta de tipo banco (una billetera se carga como banco).');
  if (p.cuenta_acredita_id === cuentaPendiente) throw new ErrorUsuario('La cuenta donde deposita no puede ser la misma "a acreditar".');
  return p.cuenta_acredita_id;
}
// Usuario y clave del portal (Pago24), cifrados con la clave propia de ClauLogic; nunca se devuelven. Sin datos nuevos, null.
const cifrarPortal = p => p.portal_usuario ? crypto.encrypt(JSON.stringify({ usuario: p.portal_usuario, clave: p.portal_clave })) : null;
// Probar la conexión con el portal (botón de la ficha del procesador), con lo que está en la ficha: lo que no se volvió a tipear
// se toma de lo guardado. No guarda nada.
r.post('/fin/procesadores/probar-portal', h(async (req, res) => {
  const b = req.body;
  let guardadas = {}, urlGuardada = null;
  if (b.procesador_id) {
    const { rows: [p] } = await pool.query('SELECT portal_url, portal_credenciales FROM fin.procesador WHERE id = $1::uuid', [texto(b.procesador_id)]);
    if (p) { urlGuardada = p.portal_url; if (p.portal_credenciales) guardadas = JSON.parse(crypto.decrypt(p.portal_credenciales)); }
  }
  const cred = { url: texto(b.portal_url) || urlGuardada, usuario: texto(b.portal_usuario) || guardadas.usuario, clave: texto(b.portal_clave) || guardadas.clave };
  if (!cred.url || !/^https:\/\//.test(cred.url)) throw new ErrorUsuario('Cargá la dirección del portal (https://…).');
  if (!cred.usuario || !cred.clave) throw new ErrorUsuario('Cargá el usuario y la clave del portal de Pago24.');
  try { res.json({ ok: true, ...await pago24.probar(cred) }); }
  catch (e) {
    // 424 y no 502: el proxy de EasyPanel reemplaza toda respuesta 502 por su propia página.
    if (!(e instanceof pago24.ErrorPago24)) throw e;
    console.error('pago24:', e.message);
    throw new ErrorUsuario(e.message, 424);
  }
}));
// Traer el extracto de Pago24 desde su portal (etapa 2): baja el CSV del rango, lo importa en la cuenta donde deposita, como
// si se hubiera subido el archivo, y concilia. Sin rango pedido: desde el día siguiente al último extracto (al menos los 3
// últimos días, que reimportar no duplica; sin extractos, desde el 1 del mes) hasta ayer, para traer días completos.
// Hasta dónde están traídas las ventas de los puntos de venta que cobran con el procesador (pedido de Fer, 03/11/2026: el extracto
// se trae hasta ahí, no hasta ayer, así se puede ir mes por mes). Por punto de venta, el primer y el último día traído (el último
// sincronizado por API o, por archivo, el de la última venta); en total, desde el primero de todos y hasta el último que tienen
// TODOS (el menor): más allá, algún punto de venta no tiene contra qué conciliar.
async function ventasDelProcesador(procesadorId) {
  const { rows } = await pool.query(
    `SELECT s.nombre AS sede,
            to_char(LEAST((SELECT MIN(dia) FROM pos.sincronizacion_dia sd WHERE sd.integracion_id = i.id),
                          (SELECT MIN(dia) FROM pos.ticket t WHERE t.integracion_id = i.id)), 'YYYY-MM-DD') AS primero,
            to_char(GREATEST((SELECT MAX(dia) FROM pos.sincronizacion_dia sd WHERE sd.integracion_id = i.id),
                             (SELECT MAX(dia) FROM pos.ticket t WHERE t.integracion_id = i.id)), 'YYYY-MM-DD') AS ultimo
       FROM pos.integracion i JOIN org.sede s ON s.id = i.sede_id
      WHERE i.activa AND s.activa
        AND EXISTS (SELECT 1 FROM pos.medio m JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id WHERE m.integracion_id = i.id AND mp.procesador_id = $1)
      ORDER BY s.nombre`, [procesadorId]);
  const conVentas = rows.filter(r => r.ultimo);
  return { puntos: rows, desde: conVentas.length ? conVentas.map(r => r.primero).sort()[0] : null,
    hasta: rows.length && conVentas.length === rows.length ? conVentas.map(r => r.ultimo).sort()[0] : null };
}
const dmy = iso => iso.split('-').reverse().join('/');
async function traerPortal(req, pr, automatica, desdePedido = null, hastaPedido = null) {
  if (!pr.portal_url || !pr.portal_credenciales) throw new ErrorUsuario('Falta la conexión con el portal en la ficha del procesador.');
  if (!pr.cuenta_acredita_id) throw new ErrorUsuario(`Primero indicá en qué cuenta deposita ${pr.nombre}.`);
  // Sin rango: desde el día siguiente al último extracto (sin extractos, el primer día de ventas traídas) hasta el último día de
  // ventas traídas de todos sus puntos de venta (nunca hoy). Con rango, el que se pidió, que igual no puede pasar de las ventas.
  const ventas = await ventasDelProcesador(pr.id);
  if (!ventas.puntos.length) throw new ErrorUsuario(`Ningún punto de venta cobra con ${pr.nombre}: asigná sus medios en la ficha de la sede.`);
  const sinNada = ventas.puntos.filter(v => !v.ultimo);
  if (sinNada.length && !automatica) throw new ErrorUsuario(`Todavía no hay ventas traídas de ${sinNada.map(v => v.sede).join(', ')}: traelas primero (paso 1).`);
  if (sinNada.length) return null;
  const { rows: [x] } = await pool.query(
    `SELECT to_char(x.desde, 'YYYY-MM-DD') AS desde, to_char(x.hasta, 'YYYY-MM-DD') AS hasta,
            x.desde < current_date - 62 AS muy_atras, x.hasta > current_date - 1 AS adelante, x.desde > x.hasta AS al_reves
       FROM (SELECT COALESCE($2::date, (SELECT MAX(hasta) + 1 FROM fin.extracto WHERE cuenta_id = $1), $4::date) AS desde,
                    COALESCE($3::date, LEAST($5::date, current_date - 1)) AS hasta) x`,
    [pr.cuenta_acredita_id, desdePedido, hastaPedido, ventas.desde, ventas.hasta]);
  if (!desdePedido && !hastaPedido && x.al_reves) {
    if (automatica) return null;
    throw new ErrorUsuario(`El extracto ya llega hasta el ${dmy(ventas.hasta)}, como las ventas traídas. Traé más ventas en el paso 1, o elegí el rango para volver a traer días.`);
  }
  if (x.muy_atras) throw new ErrorUsuario('Se puede traer hasta 62 días atrás.');
  if (x.adelante) throw new ErrorUsuario('El día en curso no se trae: elegí una fecha hasta ayer.');
  if (x.al_reves) throw new ErrorUsuario('"Desde" es posterior a "hasta".');
  // Sin las ventas del rango, los cobros no tienen contra qué parearse y la conciliación queda a medias o parea mal (pasó el
  // 03/11/2026: se trajo noviembre con las ventas sólo hasta octubre). Se exige que cada punto de venta que cobra con este
  // procesador tenga traído hasta el último día del rango; la automática, sin eso, no corre (y vuelve a probar más tarde).
  const faltan = ventas.puntos.filter(v => v.ultimo < x.hasta);
  if (faltan.length) {
    if (automatica) return null;
    throw new ErrorUsuario(`Las ventas de ${faltan.map(f => `${f.sede} llegan hasta el ${dmy(f.ultimo)}`).join(', ')}: el extracto se puede traer hasta ese día, `
      + `no hasta el ${dmy(x.hasta)}. Traé las ventas que faltan en el paso 1 o elegí otro rango.`);
  }
  const { rows: [co] } = await pool.query(
    'INSERT INTO fin.portal_corrida (procesador_id, automatica, desde, hasta) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
    [pr.id, automatica, x.desde, x.hasta]);
  if (!co) return null;   // la automática de hoy ya corrió (u otro proceso la está corriendo)
  try {
    const cred = JSON.parse(crypto.decrypt(pr.portal_credenciales));
    // Con más de 31 días el portal devuelve el CSV vacío, sin error (03/11/2026: del 01/10 al 02/11 vino una fila en blanco):
    // se trae en tramos de hasta 31 días, cada uno su extracto, y se concilia una vez al final.
    let cuentaPortal = null, filas = 0, nuevas = 0, repetidas = 0, saldoFinal = null;
    for (let d = x.desde; d <= x.hasta; d = sumarDiasTes(d, 31)) {
      const h = sumarDiasTes(d, 30) < x.hasta ? sumarDiasTes(d, 30) : x.hasta;
      const ex = await pago24.extracto({ url: pr.portal_url, ...cred }, d, h);
      if (!ex.filas.some(f => f.fecha)) throw new ErrorUsuario(`El portal no devolvió datos del ${d.split('-').reverse().join('/')} al ${h.split('-').reverse().join('/')}.`, 424);
      const imp = await importarExtracto({ cuenta_id: pr.cuenta_acredita_id, filas: ex.filas, decimal: ',', archivo: `Portal Pago24 ${d} a ${h}` });
      cuentaPortal = ex.cuenta; filas += ex.filas.length; nuevas += imp.nuevas; repetidas += imp.repetidas; saldoFinal = imp.saldo_final;
    }
    const conc = await conciliarAutomatica(req, pr.cuenta_acredita_id);
    const resumen = { cuenta: cuentaPortal, filas, nuevas, repetidas, saldo_final: saldoFinal,
      acreditadas: conc.acreditadas, gastos: Object.keys(conc.gastos || {}).length, reglas: conc.reglas, quedan: conc.quedan };
    await pool.query('UPDATE fin.portal_corrida SET terminada_en = now(), ok = true, resultado = $2 WHERE id = $1', [co.id, JSON.stringify(resumen)]);
    return { ...resumen, desde: x.desde, hasta: x.hasta };
  } catch (e) {
    await pool.query('UPDATE fin.portal_corrida SET terminada_en = now(), ok = false, error = $2 WHERE id = $1', [co.id, String(e.message || e).slice(0, 500)]);
    console.error(`Portal ${pr.nombre}${automatica ? ' (automática)' : ''}:`, e.message);
    if (automatica) return null;
    // 424 y no 502: el proxy de EasyPanel reemplaza toda respuesta 502 por su propia página.
    if (e instanceof pago24.ErrorPago24) throw new ErrorUsuario(e.message, 424);
    throw e;
  }
}
// "Traer ahora" (a mano, en el rango que se elija; no consume la automática del día).
r.post('/fin/procesadores/:id/traer', h(async (req, res) => {
  const { rows: [pr] } = await pool.query('SELECT * FROM fin.procesador WHERE id = $1::uuid', [req.params.id]);
  if (!pr) throw new ErrorUsuario('No existe ese procesador.', 404);
  res.status(201).json({ ok: true, ...await traerPortal(req, pr, false, fecha(req.body.desde, { campo: 'Desde' }), fecha(req.body.hasta, { campo: 'Hasta' })) });
}));
// Las automáticas pendientes de hoy (las llama el programador después de las ventas, firmadas por el usuario de sistema).
async function traerPortalesAutomaticos(req) {
  const { rows } = await pool.query(
    `SELECT p.* FROM fin.procesador p WHERE p.activo AND p.portal_auto AND p.portal_credenciales IS NOT NULL AND p.cuenta_acredita_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fin.portal_corrida c WHERE c.procesador_id = p.id AND c.automatica AND c.fecha = current_date)`);
  for (const pr of rows) await traerPortal(req, pr, true);
  return rows.length;
}
r.post('/fin/procesadores', h(async (req, res) => {
  const p = leerProcesador(req.body);
  const id = await enTransaccion(async c => {
    const cuenta = await cuentaProcesador(c, p);
    const { rows: [n] } = await c.query(
      'INSERT INTO fin.procesador (nombre, cuenta_id, activo, cuenta_acredita_id, marca, portal_url, portal_credenciales, sociedad_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [p.nombre, cuenta, p.activo, await cuentaAcredita(c, p, cuenta), p.marca, p.portal_url, cifrarPortal(p), p.sociedad_id]);
    await guardarTipos(c, n.id, p.tipos);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));
r.put('/fin/procesadores/:id', h(async (req, res) => {
  const p = leerProcesador(req.body);
  await enTransaccion(async c => {
    const { rows: [ant] } = await c.query('SELECT cuenta_id, sociedad_id FROM fin.procesador WHERE id = $1::uuid FOR UPDATE', [req.params.id]);
    if (!ant) throw new ErrorUsuario('No existe ese procesador.', 404);
    if (p.sociedad_id === undefined) p.sociedad_id = ant.sociedad_id;
    const cuenta = await cuentaProcesador(c, { ...p, cuenta_id: p.cuenta_id || ant.cuenta_id });
    // Sin usuario y clave nuevos se conservan los guardados (no se muestran, así que no se reenvían); otra marca los borra.
    await c.query(`UPDATE fin.procesador SET nombre = $1, cuenta_id = $2, activo = $3, cuenta_acredita_id = $4, marca = $6, portal_url = $7,
                          portal_credenciales = CASE WHEN $6 <> 'pago24' THEN NULL ELSE COALESCE($8, portal_credenciales) END, portal_auto = $9,
                          sociedad_id = $10 WHERE id = $5`,
      [p.nombre, cuenta, p.activo, await cuentaAcredita(c, p, cuenta), req.params.id, p.marca, p.portal_url, cifrarPortal(p), p.portal_auto, p.sociedad_id]);
    // Su cuenta "a acreditar" es de la misma sociedad.
    await c.query(`UPDATE fin.cuenta SET sociedad_id = $1 WHERE id = $2 AND tipo = 'cobranza'`, [p.sociedad_id, cuenta]);
    await guardarTipos(c, req.params.id, p.tipos);
  });
  res.json({ ok: true });
}));

// ── Lotes de los procesadores que liquidan por lotes (Fudo Pagos) ─────────────────────────────
// Los cobros ya procesados cuya fecha de liquidación llegó forman su lote, uno por procesador, cuenta y fecha. El lote
// nace ESPERADO, sin mover plata (decisión de Fer, 26/10/2026): lo cobrado sigue en "a acreditar" hasta que el depósito
// aparece en el extracto del banco; ahí `asentarLote` pasa el neto a la cuenta donde deposita y asienta el costo. Cada
// lote en su transacción. Sólo con permiso de finanzas.
async function acreditarLotes(req, procesadorId = null) {
  if (!req.usuario || !(req.usuario.es_admin || req.usuario.finanzas)) return null;
  const { rows: grupos } = await pool.query(
    `SELECT mp.procesador_id, pr.nombre, pr.cuenta_acredita_id, m.cuenta_id, to_char(p.liquida_el, 'YYYY-MM-DD') AS fecha,
            array_agg(p.id) AS ids, COUNT(*)::int AS pagos, SUM(p.importe)::text AS bruto, SUM(p.neto)::text AS neto
       FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
       JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id JOIN fin.procesador pr ON pr.id = mp.procesador_id
      WHERE p.lote_id IS NULL AND p.acreditado_linea_id IS NULL AND p.resuelto_movimiento_id IS NULL AND p.liquida_el IS NOT NULL AND p.liquida_el <= current_date
        AND p.neto IS NOT NULL AND NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL
        AND ($1::uuid IS NULL OR mp.procesador_id = $1::uuid)
      GROUP BY mp.procesador_id, pr.nombre, pr.cuenta_acredita_id, m.cuenta_id, p.liquida_el ORDER BY p.liquida_el`, [procesadorId]);
  const lotes = [], sinCuenta = new Set();
  for (const g of grupos) {
    if (!g.cuenta_acredita_id) { sinCuenta.add(g.nombre); continue; }
    if (centavos(g.neto) <= 0n) continue;
    const hecho = await enTransaccion(async c => {
      const { rows: libres } = await c.query('SELECT id FROM pos.ticket_pago WHERE id = ANY($1::uuid[]) AND lote_id IS NULL FOR UPDATE', [g.ids]);
      if (libres.length !== g.ids.length) return null;   // otro proceso lo liquidó mientras tanto
      const { rows: [l] } = await c.query(
        'INSERT INTO fin.lote (procesador_id, fecha, pagos, bruto, neto) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [g.procesador_id, g.fecha, g.pagos, g.bruto, g.neto]);
      await c.query('UPDATE pos.ticket_pago SET lote_id = $1 WHERE id = ANY($2::uuid[])', [l.id, g.ids]);
      return { procesador: g.nombre, fecha: g.fecha, pagos: g.pagos, neto: g.neto };
    });
    if (hecho) lotes.push(hecho);
  }
  return { lotes, sin_cuenta: [...sinCuenta] };
}

// Confirmar un lote esperado con el depósito del extracto (fecha de la línea): el neto pasa de "a acreditar" a la
// cuenta donde deposita (transferencia) y la diferencia con el bruto queda como cargo del procesador (egreso de "a
// acreditar"). Devuelve la entrada, que es la que se concilia con la línea.
async function asentarLote(c, loteId, fecha) {
  const { rows: [l] } = await c.query(
    `SELECT l.*, to_char(l.fecha, 'YYYY-MM-DD') AS dia, pr.nombre, pr.cuenta_id AS pendiente, pr.cuenta_acredita_id
       FROM fin.lote l JOIN fin.procesador pr ON pr.id = l.procesador_id WHERE l.id = $1 FOR UPDATE OF l`, [loteId]);
  if (l.movimiento_id) throw new ErrorUsuario(`El lote ${l.nombre} del ${l.dia} ya está confirmado.`);
  const concepto = `Lote ${l.nombre} del ${l.dia} · ${l.pagos} cobro(s)`;
  const { rows: [{ id: tr }] } = await c.query('SELECT gen_random_uuid() AS id');
  await c.query(`INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, transferencia_id) VALUES ($1,$2,'transferencia',$3,$4,$5)`,
    [fecha, l.pendiente, l.neto, concepto, tr]);
  const { rows: [ent] } = await c.query(
    `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, concepto, transferencia_id) VALUES ($1,$2,'transferencia',$3,$4,$5) RETURNING id`,
    [fecha, l.cuenta_acredita_id, l.neto, concepto, tr]);
  const costo = centavos(l.bruto) - centavos(l.neto);
  const { rows: [cm] } = costo > 0n ? await c.query(
    `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, gasto) VALUES ($1,$2,'egreso',$3,$4,'comision') RETURNING id`,
    [fecha, l.pendiente, deCentavos(costo), `Cargos ${l.nombre} · lote del ${l.dia}`]) : { rows: [{}] };
  await c.query('UPDATE fin.lote SET movimiento_id = $2, costo_movimiento_id = $3 WHERE id = $1', [loteId, ent.id, cm.id || null]);
  return ent.id;
}

Object.assign(r, { MEDIOS_SQL, acreditarLotes, porCobrar, traerPortalesAutomaticos, traerPortal, deshacerConciliacion });
module.exports = r;
