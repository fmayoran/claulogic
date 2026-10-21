// API de finanzas: comprobantes de proveedor, cuenta corriente y libro IVA compras.
//
// Todo /fin exige permiso de finanzas (auth.js), también para leer. Registrar y anular, además, lo
// verifica la base (fin.registrar_comprobante y fin.anular_comprobante), que es donde se asienta la
// cuenta corriente: la app no escribe en el libro mayor.
//
// Los importes se calculan en la base, en NUMERIC: el navegador muestra lo que la base devuelve.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, texto, fecha, h, enTransaccion } = require('./util');

const r = express.Router();

const TIPOS = ['factura', 'nota_debito', 'nota_credito'];
const LETRAS = ['A', 'B', 'C', 'M'];
const ALICUOTAS = ['0', '2.5', '5', '10.5', '21', '27'];
const TRIBUTOS = ['percepcion_iva', 'percepcion_iibb', 'percepcion_ganancias', 'impuesto_interno', 'otro'];
const CORTO = { factura: 'FC', nota_debito: 'ND', nota_credito: 'NC' };

const nro = c => `${CORTO[c.tipo]} ${c.letra} ${String(c.punto_venta).padStart(5, '0')}-${String(c.numero).padStart(8, '0')}`;

// ── Listado y detalle ────────────────────────────────────────────────────────────────────────
r.get('/fin/comprobantes', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha, c.vencimiento, c.estado,
            c.proveedor_id, pv.nombre AS proveedor,
            COALESCE(c.total, t.neto_gravado + t.iva + t.no_gravado + t.tributos)::text AS total
       FROM fin.comprobante c
       JOIN logic.proveedor pv ON pv.id = c.proveedor_id
       JOIN fin.comprobante_totales t ON t.comprobante_id = c.id
      WHERE ($1::uuid IS NULL OR c.proveedor_id = $1)
        AND ($2::text IS NULL OR c.estado = $2)
        AND ($3::date IS NULL OR c.fecha >= $3)
        AND ($4::date IS NULL OR c.fecha <= $4)
        AND ($5::text IS NULL OR pv.nombre ILIKE '%' || $5 || '%' OR c.numero::text LIKE '%' || $5 || '%')
      ORDER BY c.fecha DESC, c.creado_en DESC LIMIT 500`,
    [texto(req.query.proveedor), texto(req.query.estado), fecha(req.query.desde, { campo: 'Desde' }),
     fecha(req.query.hasta, { campo: 'Hasta' }), texto(req.query.q)]);
  res.json({ ok: true, comprobantes: rows.map(c => ({ ...c, nro: nro(c) })) });
}));

r.get('/fin/comprobantes/:id', h(async (req, res) => {
  const { rows: [c] } = await pool.query(
    `SELECT c.*, c.total::text AS total, c.ajuste_redondeo::text AS ajuste_redondeo,
            pv.nombre AS proveedor, pv.cuit, pv.condicion_iva, pv.plazo_pago_dias,
            a.tipo AS asociado_tipo, a.letra AS asociado_letra, a.punto_venta AS asociado_pv, a.numero AS asociado_numero,
            t.neto_gravado::text, t.iva::text, t.no_gravado::text, t.tributos::text,
            (t.neto_gravado + t.iva + t.no_gravado + t.tributos)::text AS calculado
       FROM fin.comprobante c
       JOIN logic.proveedor pv ON pv.id = c.proveedor_id
       JOIN fin.comprobante_totales t ON t.comprobante_id = c.id
       LEFT JOIN fin.comprobante a ON a.id = c.asociado_id
      WHERE c.id = $1::uuid`, [req.params.id]);
  if (!c) throw new ErrorUsuario('No existe ese comprobante.', 404);
  const [items, tributos, compras, iva, movs] = await Promise.all([
    pool.query(
      `SELECT i.id, i.producto_id, i.compra_item_id, i.descripcion, i.unidad, trim_scale(i.cantidad)::text AS cantidad,
              trim_scale(i.precio_unitario)::text AS precio, trim_scale(i.descuento_pct)::text AS descuento,
              trim_scale(i.alicuota)::text AS alicuota, i.importe::text AS importe
         FROM fin.comprobante_item i WHERE i.comprobante_id = $1 ORDER BY i.orden`, [c.id]),
    pool.query(`SELECT id, tipo, jurisdiccion, descripcion, importe::text FROM fin.comprobante_tributo WHERE comprobante_id = $1`, [c.id]),
    pool.query(
      `SELECT co.id, co.numero, co.fecha FROM fin.comprobante_compra x JOIN logic.compra co ON co.id = x.compra_id
        WHERE x.comprobante_id = $1 ORDER BY co.fecha`, [c.id]),
    pool.query(`SELECT trim_scale(alicuota)::text AS alicuota, neto::text, iva::text FROM fin.comprobante_iva
                 WHERE comprobante_id = $1 ORDER BY alicuota DESC`, [c.id]),
    pool.query(`SELECT id, ocurrido_en, tipo, debe::text, haber::text, detalle, registrado_por
                  FROM fin.movimiento_cc WHERE comprobante_id = $1 ORDER BY id`, [c.id]),
  ]);
  const asociado = c.asociado_id ? nro({ tipo: c.asociado_tipo, letra: c.asociado_letra, punto_venta: c.asociado_pv, numero: c.asociado_numero }) : null;
  res.json({ ok: true, comprobante: { ...c, nro: nro(c), asociado, items: items.rows, tributos: tributos.rows,
    compras: compras.rows, alicuotas: iva.rows, movimientos: movs.rows } });
}));

// ── Carga ────────────────────────────────────────────────────────────────────────────────────
function leerItems(b, letra) {
  const items = Array.isArray(b.items) ? b.items : [];
  return items.map((x, i) => {
    const it = {
      producto_id: texto(x.producto_id), compra_item_id: texto(x.compra_item_id),
      descripcion: texto(x.descripcion, { campo: `la descripción del renglón ${i + 1}`, requerido: true }),
      unidad: texto(x.unidad),
      cantidad: numero(x.cantidad, { campo: `Cantidad del renglón ${i + 1}`, requerido: true, positivo: true }),
      precio: numero(x.precio, { campo: `Precio del renglón ${i + 1}`, requerido: true }),
      descuento: numero(x.descuento, { campo: `Descuento del renglón ${i + 1}` }) || '0',
      alicuota: texto(x.alicuota),
    };
    if (it.alicuota) it.alicuota = it.alicuota.replace(',', '.');
    if (it.alicuota && !ALICUOTAS.includes(it.alicuota)) throw new ErrorUsuario(`Alícuota inválida en el renglón ${i + 1}.`);
    if (Number(it.descuento) >= 100) throw new ErrorUsuario(`El descuento del renglón ${i + 1} tiene que ser menor a 100%.`);
    // En B y C el IVA viene incluido en el precio y no se discrimina.
    if (letra === 'B' || letra === 'C') it.alicuota = null;
    return it;
  });
}

function leerTributos(b) {
  return (Array.isArray(b.tributos) ? b.tributos : []).map((x, i) => {
    const t = {
      tipo: texto(x.tipo, { campo: `el tipo del impuesto ${i + 1}`, requerido: true }),
      jurisdiccion: texto(x.jurisdiccion), descripcion: texto(x.descripcion),
      importe: numero(x.importe, { campo: `Importe del impuesto ${i + 1}`, requerido: true, positivo: true }),
    };
    if (!TRIBUTOS.includes(t.tipo)) throw new ErrorUsuario(`Tipo de impuesto inválido (${i + 1}).`);
    return t;
  });
}

function leerComprobante(b) {
  const c = {
    proveedor_id: texto(b.proveedor_id, { campo: 'el proveedor', requerido: true }),
    tipo: texto(b.tipo, { campo: 'el tipo', requerido: true }),
    letra: (texto(b.letra, { campo: 'la letra', requerido: true }) || '').toUpperCase(),
    punto_venta: numero(b.punto_venta, { campo: 'El punto de venta', requerido: true, positivo: true }),
    numero: numero(b.numero, { campo: 'El número', requerido: true, positivo: true }),
    fecha: fecha(b.fecha, { campo: 'Fecha', requerido: true }),
    vencimiento: fecha(b.vencimiento, { campo: 'Vencimiento' }),
    cae: texto(b.cae), asociado_id: texto(b.asociado_id), notas: texto(b.notas),
  };
  if (!TIPOS.includes(c.tipo)) throw new ErrorUsuario('Tipo de comprobante inválido.');
  if (!LETRAS.includes(c.letra)) throw new ErrorUsuario('La letra es A, B, C o M.');
  if (!/^\d+$/.test(c.punto_venta) || !/^\d+$/.test(c.numero)) throw new ErrorUsuario('Punto de venta y número van en enteros.');
  if (c.cae && !/^\d{14}$/.test(c.cae)) throw new ErrorUsuario('El CAE tiene 14 dígitos.');
  if (c.tipo === 'factura') c.asociado_id = null;
  c.items = leerItems(b, c.letra);
  c.tributos = leerTributos(b);
  c.compras = (Array.isArray(b.compras) ? b.compras : []).map(String);
  return c;
}

async function guardarDetalle(cn, id, c) {
  await cn.query('DELETE FROM fin.comprobante_item WHERE comprobante_id = $1', [id]);
  await cn.query('DELETE FROM fin.comprobante_tributo WHERE comprobante_id = $1', [id]);
  await cn.query('DELETE FROM fin.comprobante_compra WHERE comprobante_id = $1', [id]);
  for (const [i, x] of c.items.entries())
    await cn.query(
      `INSERT INTO fin.comprobante_item (comprobante_id, orden, producto_id, compra_item_id, descripcion, unidad,
                                         cantidad, precio_unitario, descuento_pct, alicuota)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, i, x.producto_id, x.compra_item_id, x.descripcion, x.unidad, x.cantidad, x.precio, x.descuento, x.alicuota]);
  for (const t of c.tributos)
    await cn.query('INSERT INTO fin.comprobante_tributo (comprobante_id, tipo, jurisdiccion, descripcion, importe) VALUES ($1,$2,$3,$4,$5)',
      [id, t.tipo, t.jurisdiccion, t.descripcion, t.importe]);
  for (const compra of new Set(c.compras)) {
    const { rows: [co] } = await cn.query('SELECT proveedor_id, estado FROM logic.compra WHERE id = $1::uuid', [compra]);
    if (!co || co.proveedor_id !== c.proveedor_id) throw new ErrorUsuario('Una compra vinculada no es de este proveedor.');
    await cn.query('INSERT INTO fin.comprobante_compra (comprobante_id, compra_id) VALUES ($1,$2)', [id, compra]);
  }
}

// Sin vencimiento, el plazo de pago del proveedor; sin plazo, la fecha del comprobante.
const VENCIMIENTO = `COALESCE($7::date, $6::date + (SELECT plazo_pago_dias FROM logic.proveedor WHERE id = $1::uuid), $6::date)`;

r.post('/fin/comprobantes', h(async (req, res) => {
  const c = leerComprobante(req.body);
  const id = await enTransaccion(async cn => {
    const { rows: [n] } = await cn.query(
      `INSERT INTO fin.comprobante (proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, cae, asociado_id, notas)
       VALUES ($1,$2,$3,$4,$5,$6,${VENCIMIENTO},$8,$9,$10) RETURNING id`,
      [c.proveedor_id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha, c.vencimiento, c.cae, c.asociado_id, c.notas]);
    await guardarDetalle(cn, n.id, c);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

r.put('/fin/comprobantes/:id', h(async (req, res) => {
  const c = leerComprobante(req.body);
  await enTransaccion(async cn => {
    const { rows: [ant] } = await cn.query('SELECT estado FROM fin.comprobante WHERE id = $1::uuid FOR UPDATE', [req.params.id]);
    if (!ant) throw new ErrorUsuario('No existe ese comprobante.', 404);
    if (ant.estado !== 'borrador') throw new ErrorUsuario(`El comprobante está ${ant.estado}: no se edita.`);
    // Primero el detalle (con la letra nueva ya aplicada a las alícuotas) y después la cabecera:
    // al revés, pasar de A a B con alícuotas cargadas lo frenaría la base.
    await cn.query('DELETE FROM fin.comprobante_item WHERE comprobante_id = $1', [req.params.id]);
    await cn.query(
      `UPDATE fin.comprobante SET proveedor_id=$1, tipo=$2, letra=$3, punto_venta=$4, numero=$5, fecha=$6,
              vencimiento=${VENCIMIENTO}, cae=$8, asociado_id=$9, notas=$10 WHERE id=$11`,
      [c.proveedor_id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha, c.vencimiento, c.cae, c.asociado_id, c.notas, req.params.id]);
    await guardarDetalle(cn, req.params.id, c);
  });
  res.json({ ok: true, id: req.params.id });
}));

r.delete('/fin/comprobantes/:id', h(async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM fin.comprobante WHERE id = $1::uuid AND estado = 'borrador'`, [req.params.id]);
  if (!rowCount) throw new ErrorUsuario('Sólo se borra un comprobante en borrador.');
  res.json({ ok: true });
}));

// Totales de lo que hay en pantalla, sin guardar: la misma cuenta que hace la base al registrar.
r.post('/fin/comprobantes/calcular', h(async (req, res) => {
  const letra = (texto(req.body.letra) || 'A').toUpperCase();
  const items = leerItems({ items: (req.body.items || []).filter(x => x.cantidad && x.precio)
    .map(x => ({ ...x, descripcion: x.descripcion || '-' })) }, letra);
  const tributos = (req.body.tributos || []).filter(t => t.importe).map((t, i) =>
    numero(t.importe, { campo: `Importe del impuesto ${i + 1}`, requerido: true }));
  const { rows: lineas } = await pool.query(
    `SELECT round(cant * precio * (1 - descu / 100), 2)::text AS importe
       FROM unnest($1::numeric[], $2::numeric[], $3::numeric[]) WITH ORDINALITY AS t(cant, precio, descu, n) ORDER BY n`,
    [items.map(x => x.cantidad), items.map(x => x.precio), items.map(x => x.descuento)]);
  const { rows: iva } = await pool.query(
    `WITH l AS (SELECT round(cant * precio * (1 - descu / 100), 2) AS imp, alic
                  FROM unnest($1::numeric[], $2::numeric[], $3::numeric[], $4::numeric[]) AS t(cant, precio, descu, alic))
     SELECT trim_scale(alic)::text AS alicuota, SUM(imp)::text AS neto, round(SUM(imp) * alic / 100, 2)::text AS iva
       FROM l WHERE alic IS NOT NULL GROUP BY alic ORDER BY alic DESC`,
    [items.map(x => x.cantidad), items.map(x => x.precio), items.map(x => x.descuento), items.map(x => x.alicuota)]);
  const { rows: [t] } = await pool.query(
    `SELECT COALESCE((SELECT SUM(x) FROM unnest($1::numeric[]) x), 0)::text AS neto_gravado,
            COALESCE((SELECT SUM(x) FROM unnest($2::numeric[]) x), 0)::text AS iva,
            COALESCE((SELECT SUM(x) FROM unnest($3::numeric[]) x), 0)::text AS no_gravado,
            COALESCE((SELECT SUM(x) FROM unnest($4::numeric[]) x), 0)::text AS tributos,
            (COALESCE((SELECT SUM(x) FROM unnest($1::numeric[]) x), 0) + COALESCE((SELECT SUM(x) FROM unnest($2::numeric[]) x), 0)
             + COALESCE((SELECT SUM(x) FROM unnest($3::numeric[]) x), 0) + COALESCE((SELECT SUM(x) FROM unnest($4::numeric[]) x), 0))::text AS total`,
    [iva.map(x => x.neto), iva.map(x => x.iva),
     lineas.filter((_, i) => items[i].alicuota === null).map(x => x.importe), tributos]);
  res.json({ ok: true, renglones: lineas.map(x => x.importe), alicuotas: iva, ...t });
}));

r.post('/fin/comprobantes/:id/registrar', h(async (req, res) => {
  const total = numero(req.body.total, { campo: 'El total impreso', requerido: true });
  await pool.query('SELECT fin.registrar_comprobante($1::uuid, $2::numeric)', [req.params.id, total]);
  res.json({ ok: true });
}));

r.post('/fin/comprobantes/:id/anular', h(async (req, res) => {
  const motivo = texto(req.body.motivo, { campo: 'el motivo de la anulación', requerido: true });
  await pool.query('SELECT fin.anular_comprobante($1::uuid, $2)', [req.params.id, motivo]);
  res.json({ ok: true });
}));

// Facturas registradas del proveedor, para asociarles una nota de crédito o de débito.
r.get('/fin/facturas', h(async (req, res) => {
  const proveedor = texto(req.query.proveedor, { campo: 'el proveedor', requerido: true });
  const { rows } = await pool.query(
    `SELECT id, tipo, letra, punto_venta, numero, fecha, total::text FROM fin.comprobante
      WHERE proveedor_id = $1::uuid AND tipo = 'factura' AND estado = 'registrado' ORDER BY fecha DESC LIMIT 200`, [proveedor]);
  res.json({ ok: true, facturas: rows.map(c => ({ ...c, nro: nro(c) })) });
}));

// Compras recibidas del proveedor, con sus renglones listos para copiar a la factura. El precio
// unitario sale del total del renglón de la compra: quien carga verifica que sea neto de IVA.
r.get('/fin/compras', h(async (req, res) => {
  const proveedor = texto(req.query.proveedor, { campo: 'el proveedor', requerido: true });
  const { rows } = await pool.query(
    `SELECT co.id, co.numero, co.fecha, co.recibida_en,
            (SELECT string_agg(DISTINCT CASE c.tipo WHEN 'factura' THEN 'FC' WHEN 'nota_debito' THEN 'ND' ELSE 'NC' END || ' ' ||
                               c.letra || ' ' || lpad(c.punto_venta::text, 5, '0') || '-' || lpad(c.numero::text, 8, '0'), ', ')
               FROM fin.comprobante_compra x JOIN fin.comprobante c ON c.id = x.comprobante_id
              WHERE x.compra_id = co.id AND c.estado <> 'anulado') AS facturada_en,
            COALESCE(json_agg(json_build_object(
              'compra_item_id', ci.id, 'producto_id', ci.producto_id,
              'descripcion', p.nombre || COALESCE(' (' || pr.nombre || ')', ''),
              'unidad', COALESCE(pr.nombre, un.codigo, p.unidad_base),
              'cantidad', trim_scale(CASE WHEN pr.id IS NULL AND un.codigo IS NULL THEN ci.cantidad_base ELSE ci.cantidad END)::text,
              'precio', CASE WHEN ci.precio_total IS NULL THEN NULL ELSE
                          trim_scale(round(ci.precio_total / CASE WHEN pr.id IS NULL AND un.codigo IS NULL THEN ci.cantidad_base ELSE ci.cantidad END, 4))::text END,
              'alicuota', trim_scale(p.alicuota_iva)::text) ORDER BY p.nombre) FILTER (WHERE ci.id IS NOT NULL), '[]') AS items
       FROM logic.compra co
       LEFT JOIN logic.compra_item ci ON ci.compra_id = co.id
       LEFT JOIN logic.producto p ON p.id = ci.producto_id
       LEFT JOIN logic.presentacion pr ON pr.id = ci.presentacion_id
       -- Comprado por unidad suelta: la compra guarda la cantidad tipeada y la de base, no la unidad.
       -- Se la deduce de la relación entre las dos ("20" y "20000 ml" -> litros).
       LEFT JOIN LATERAL (SELECT u.codigo FROM logic.unidad u JOIN logic.unidad b ON b.codigo = p.unidad_base
                           WHERE pr.id IS NULL AND u.magnitud = b.magnitud AND u.factor_si / b.factor_si = ci.cantidad_base / ci.cantidad
                           ORDER BY u.es_referencia DESC LIMIT 1) un ON true
      WHERE co.proveedor_id = $1::uuid AND co.estado = 'recibida'
      GROUP BY co.id ORDER BY co.fecha DESC LIMIT 100`, [proveedor]);
  res.json({ ok: true, compras: rows });
}));

// ── Cuenta corriente ─────────────────────────────────────────────────────────────────────────
r.get('/fin/cuenta-corriente', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pv.id, pv.nombre, pv.cuit, s.saldo::text, s.ultimo_movimiento,
            COALESCE(SUM(cp.pendiente) FILTER (WHERE cp.vencimiento < current_date), 0)::text AS vencido,
            COALESCE(SUM(cp.pendiente) FILTER (WHERE cp.vencimiento BETWEEN current_date AND current_date + 7), 0)::text AS vence_7,
            MIN(cp.vencimiento) FILTER (WHERE cp.vencimiento >= current_date AND cp.pendiente > 0) AS proximo_vencimiento
       FROM fin.saldo_proveedor s
       JOIN logic.proveedor pv ON pv.id = s.proveedor_id
       LEFT JOIN fin.comprobante_pendiente cp ON cp.proveedor_id = s.proveedor_id AND cp.pendiente > 0
      GROUP BY pv.id, s.saldo, s.ultimo_movimiento
      ORDER BY s.saldo DESC, pv.nombre`);
  const { rows: [tot] } = await pool.query(
    `SELECT COALESCE(SUM(saldo), 0)::text AS saldo FROM fin.saldo_proveedor`);
  res.json({ ok: true, proveedores: rows, total: tot.saldo });
}));

r.get('/fin/cuenta-corriente/:proveedor', h(async (req, res) => {
  const { rows: [pv] } = await pool.query('SELECT id, nombre, cuit, condicion_iva, plazo_pago_dias FROM logic.proveedor WHERE id = $1::uuid', [req.params.proveedor]);
  if (!pv) throw new ErrorUsuario('No existe ese proveedor.', 404);
  const [movs, pend] = await Promise.all([
    pool.query(
      `SELECT m.id, m.fecha, m.ocurrido_en, m.tipo, m.comprobante_id, m.debe::text, m.haber::text, m.detalle, m.registrado_por,
              m.anula_a, SUM(m.haber - m.debe) OVER (ORDER BY m.fecha, m.id)::text AS saldo
         FROM fin.movimiento_cc m WHERE m.proveedor_id = $1 ORDER BY m.fecha, m.id`, [pv.id]),
    pool.query(
      `SELECT comprobante_id, tipo, letra, punto_venta, numero, fecha, vencimiento, pendiente::text,
              (vencimiento - current_date) AS dias
         FROM fin.comprobante_pendiente WHERE proveedor_id = $1 AND pendiente > 0 ORDER BY vencimiento`, [pv.id]),
  ]);
  res.json({ ok: true, proveedor: pv, movimientos: movs.rows, pendientes: pend.rows.map(c => ({ ...c, nro: nro(c) })) });
}));

// ── Libro IVA compras ────────────────────────────────────────────────────────────────────────
// CSV del mes para el contador. Separador ';' y coma decimal, que es lo que abre bien Excel en
// español; con BOM para que respete los acentos. Las notas de crédito van en negativo.
r.get('/fin/libro-iva', h(async (req, res) => {
  const mes = texto(req.query.mes, { campo: 'el mes', requerido: true });
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new ErrorUsuario('El mes va como AAAA-MM.');
  const { rows } = await pool.query(
    `WITH c AS (
       SELECT c.*, pv.nombre AS proveedor, pv.cuit, CASE WHEN c.tipo = 'nota_credito' THEN -1 ELSE 1 END AS signo
         FROM fin.comprobante c JOIN logic.proveedor pv ON pv.id = c.proveedor_id
        WHERE c.estado = 'registrado' AND to_char(c.fecha, 'YYYY-MM') = $1)
     SELECT to_char(c.fecha, 'DD/MM/YYYY') AS fecha, c.tipo, c.letra, c.punto_venta, c.numero, c.cuit, c.proveedor, c.signo,
            ${['21', '10.5', '27', '5', '2.5', '0'].map(a =>
              `COALESCE((SELECT neto FROM fin.comprobante_iva v WHERE v.comprobante_id = c.id AND v.alicuota = ${a}), 0) * c.signo AS "neto_${a}",
               COALESCE((SELECT iva FROM fin.comprobante_iva v WHERE v.comprobante_id = c.id AND v.alicuota = ${a}), 0) * c.signo AS "iva_${a}"`).join(',\n')},
            t.no_gravado * c.signo AS no_gravado,
            ${['percepcion_iva', 'percepcion_iibb', 'percepcion_ganancias', 'impuesto_interno', 'otro'].map(x =>
              `COALESCE((SELECT SUM(importe) FROM fin.comprobante_tributo tr WHERE tr.comprobante_id = c.id AND tr.tipo = '${x}'), 0) * c.signo AS "${x}"`).join(',\n')},
            c.ajuste_redondeo * c.signo AS redondeo, c.total * c.signo AS total
       FROM c JOIN fin.comprobante_totales t ON t.comprobante_id = c.id
      ORDER BY c.fecha, c.proveedor, c.numero`, [mes]);
  const columnas = [['fecha', 'Fecha'], ['tipo', 'Tipo'], ['letra', 'Letra'], ['punto_venta', 'Punto de venta'], ['numero', 'Número'],
    ['cuit', 'CUIT'], ['proveedor', 'Proveedor'],
    ...['21', '10.5', '27', '5', '2.5', '0'].flatMap(a => [[`neto_${a}`, `Neto ${a.replace('.', ',')}%`], [`iva_${a}`, `IVA ${a.replace('.', ',')}%`]]),
    ['no_gravado', 'No gravado y exento'], ['percepcion_iva', 'Percepción IVA'], ['percepcion_iibb', 'Percepción IIBB'],
    ['percepcion_ganancias', 'Percepción Ganancias'], ['impuesto_interno', 'Impuestos internos'], ['otro', 'Otros tributos'],
    ['redondeo', 'Redondeo'], ['total', 'Total']];
  const TIPO = { factura: 'Factura', nota_debito: 'Nota de débito', nota_credito: 'Nota de crédito' };
  const celda = (k, v) => {
    if (v === null || v === undefined) return '';
    if (k === 'tipo') return TIPO[v];
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !['cuit', 'numero', 'punto_venta'].includes(k)) return v.replace('.', ',');
    const s = String(v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = '﻿' + [columnas.map(c => c[1]).join(';'),
    ...rows.map(f => columnas.map(([k]) => celda(k, f[k])).join(';'))].join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="libro-iva-compras-${mes}.csv"`);
  res.send(csv);
}));

module.exports = r;
