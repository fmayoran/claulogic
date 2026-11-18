// API de finanzas: comprobantes de proveedor, cuenta corriente y libro IVA compras.
//
// Todo /fin exige permiso de finanzas (auth.js), también para leer. Registrar y anular, además, lo
// verifica la base (fin.registrar_comprobante y fin.anular_comprobante), que es donde se asienta la
// cuenta corriente: la app no escribe en el libro mayor.
//
// Los importes se calculan en la base, en NUMERIC: el navegador muestra lo que la base devuelve.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, monto, texto, fecha, h, enTransaccion } = require('./util');

const r = express.Router();

const TIPOS = ['factura', 'nota_debito', 'nota_credito'];
// X = no fiscal: sin IVA discriminado, número opcional, fuera del libro IVA.
const LETRAS = ['A', 'B', 'C', 'M', 'X'];
const ALICUOTAS = ['0', '2.5', '5', '10.5', '21', '27'];
const TRIBUTOS = ['percepcion_iva', 'percepcion_iibb', 'percepcion_ganancias', 'impuesto_interno', 'otro'];
const CORTO = { factura: 'FC', nota_debito: 'ND', nota_credito: 'NC' };

const nro = c => `${CORTO[c.tipo]} ${c.letra} ${String(c.punto_venta).padStart(5, '0')}-${String(c.numero).padStart(8, '0')}`;

// ── Listado y detalle ────────────────────────────────────────────────────────────────────────
r.get('/fin/comprobantes', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha, c.vencimiento, c.estado,
            c.proveedor_id, pv.nombre AS proveedor, c.sociedad_id, so.nombre AS sociedad,
            COALESCE(c.total, t.neto_gravado + t.iva + t.no_gravado + t.tributos)::text AS total
       FROM fin.comprobante c
       JOIN logic.proveedor pv ON pv.id = c.proveedor_id
       JOIN fin.comprobante_totales t ON t.comprobante_id = c.id
       JOIN org.sociedad so ON so.id = c.sociedad_id
      WHERE ($1::uuid IS NULL OR c.proveedor_id = $1)
        AND ($6::uuid IS NULL OR c.sociedad_id = $6)
        AND ($2::text IS NULL OR c.estado = $2)
        AND ($3::date IS NULL OR c.fecha >= $3)
        AND ($4::date IS NULL OR c.fecha <= $4)
        AND ($5::text IS NULL OR pv.nombre ILIKE '%' || $5 || '%' OR c.numero::text LIKE '%' || $5 || '%')
      ORDER BY c.fecha DESC, c.creado_en DESC LIMIT 500`,
    [texto(req.query.proveedor), texto(req.query.estado), fecha(req.query.desde, { campo: 'Desde' }),
     fecha(req.query.hasta, { campo: 'Hasta' }), texto(req.query.q), texto(req.query.sociedad)]);
  res.json({ ok: true, comprobantes: rows.map(c => ({ ...c, nro: nro(c) })) });
}));

r.get('/fin/comprobantes/:id', h(async (req, res) => {
  const { rows: [c] } = await pool.query(
    `SELECT c.*, c.total::text AS total, c.ajuste_redondeo::text AS ajuste_redondeo,
            pv.nombre AS proveedor, pv.cuit, pv.condicion_iva, pv.plazo_pago_dias, so.nombre AS sociedad,
            a.tipo AS asociado_tipo, a.letra AS asociado_letra, a.punto_venta AS asociado_pv, a.numero AS asociado_numero,
            t.neto_gravado::text, t.iva::text, t.no_gravado::text, t.tributos::text,
            (t.neto_gravado + t.iva + t.no_gravado + t.tributos)::text AS calculado,
            (SELECT cp.pendiente::text FROM fin.comprobante_pendiente cp WHERE cp.comprobante_id = c.id) AS pendiente
       FROM fin.comprobante c
       JOIN logic.proveedor pv ON pv.id = c.proveedor_id
       JOIN fin.comprobante_totales t ON t.comprobante_id = c.id
       LEFT JOIN fin.comprobante a ON a.id = c.asociado_id
       JOIN org.sociedad so ON so.id = c.sociedad_id
      WHERE c.id = $1::uuid`, [req.params.id]);
  if (!c) throw new ErrorUsuario('No existe ese comprobante.', 404);
  const [items, tributos, compras, iva, movs, previos] = await Promise.all([
    pool.query(
      `SELECT i.id, i.producto_id, i.compra_item_id, i.descripcion, i.unidad, trim_scale(i.cantidad)::text AS cantidad,
              trim_scale(i.precio_unitario)::text AS precio, trim_scale(i.descuento_pct)::text AS descuento,
              trim_scale(i.alicuota)::text AS alicuota, i.importe::text AS importe, i.rubro_id,
              COALESCE(ri.nombre, rc.nombre) AS rubro
         FROM fin.comprobante_item i LEFT JOIN fin.rubro ri ON ri.id = i.rubro_id
         LEFT JOIN logic.producto p ON p.id = i.producto_id LEFT JOIN logic.categoria ca ON ca.id = p.categoria_id
         LEFT JOIN fin.rubro rc ON rc.id = ca.rubro_id
        WHERE i.comprobante_id = $1 ORDER BY i.orden`, [c.id]),
    pool.query(`SELECT id, tipo, jurisdiccion, descripcion, importe::text FROM fin.comprobante_tributo WHERE comprobante_id = $1`, [c.id]),
    pool.query(
      `SELECT co.id, co.numero, co.fecha FROM fin.comprobante_compra x JOIN logic.compra co ON co.id = x.compra_id
        WHERE x.comprobante_id = $1 ORDER BY co.fecha`, [c.id]),
    pool.query(`SELECT trim_scale(alicuota)::text AS alicuota, neto::text, iva::text FROM fin.comprobante_iva
                 WHERE comprobante_id = $1 ORDER BY alicuota DESC`, [c.id]),
    pool.query(`SELECT id, ocurrido_en, tipo, debe::text, haber::text, detalle, registrado_por
                  FROM fin.movimiento_cc WHERE comprobante_id = $1 ORDER BY id`, [c.id]),
    pool.query(`SELECT pp.movimiento_id, pp.importe::text, to_char(m.fecha, 'YYYY-MM-DD') AS fecha, m.concepto, cu.nombre AS cuenta
                  FROM fin.pago_previo pp JOIN fin.movimiento_tes m ON m.id = pp.movimiento_id JOIN fin.cuenta cu ON cu.id = m.cuenta_id
                 WHERE pp.comprobante_id = $1 ORDER BY m.fecha`, [c.id]),
  ]);
  const asociado = c.asociado_id ? nro({ tipo: c.asociado_tipo, letra: c.asociado_letra, punto_venta: c.asociado_pv, numero: c.asociado_numero }) : null;
  res.json({ ok: true, comprobante: { ...c, nro: nro(c), asociado, items: items.rows, tributos: tributos.rows,
    compras: compras.rows, alicuotas: iva.rows, movimientos: movs.rows, pagos_previos: previos.rows } });
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
      precio: monto(x.precio, { campo: `Precio del renglón ${i + 1}`, requerido: true }),
      descuento: numero(x.descuento, { campo: `Descuento del renglón ${i + 1}` }) || '0',
      alicuota: texto(x.alicuota),
      // Rubro del renglón: con producto, el de su categoría (no se guarda); sin producto, el elegido.
      rubro_id: texto(x.producto_id) ? null : texto(x.rubro_id),
    };
    if (it.alicuota) it.alicuota = it.alicuota.replace(',', '.');
    if (it.alicuota && !ALICUOTAS.includes(it.alicuota)) throw new ErrorUsuario(`Alícuota inválida en el renglón ${i + 1}.`);
    if (Number(it.descuento) >= 100) throw new ErrorUsuario(`El descuento del renglón ${i + 1} tiene que ser menor a 100%.`);
    // En B y C el IVA viene incluido en el precio y no se discrimina.
    if (letra === 'B' || letra === 'C' || letra === 'X') it.alicuota = null;
    return it;
  });
}

function leerTributos(b) {
  return (Array.isArray(b.tributos) ? b.tributos : []).map((x, i) => {
    const t = {
      tipo: texto(x.tipo, { campo: `el tipo del impuesto ${i + 1}`, requerido: true }),
      jurisdiccion: texto(x.jurisdiccion), descripcion: texto(x.descripcion),
      importe: monto(x.importe, { campo: `Importe del impuesto ${i + 1}`, requerido: true, positivo: true }),
    };
    if (!TRIBUTOS.includes(t.tipo)) throw new ErrorUsuario(`Tipo de impuesto inválido (${i + 1}).`);
    return t;
  });
}

function leerComprobante(b) {
  const noFiscal = String(b.letra || '').toUpperCase() === 'X';
  const c = {
    proveedor_id: texto(b.proveedor_id, { campo: 'el proveedor', requerido: true }),
    // La sociedad que recibe el comprobante (su libro IVA y su deuda).
    sociedad_id: texto(b.sociedad_id, { campo: 'la sociedad que recibe el comprobante', requerido: true }),
    tipo: texto(b.tipo, { campo: 'el tipo', requerido: true }),
    letra: (texto(b.letra, { campo: 'la letra', requerido: true }) || '').toUpperCase(),
    // En uno no fiscal son opcionales: sin número, la base le pone uno interno.
    punto_venta: numero(b.punto_venta, { campo: 'El punto de venta', requerido: !noFiscal, positivo: !noFiscal }),
    numero: numero(b.numero, { campo: 'El número', requerido: !noFiscal, positivo: true }),
    fecha: fecha(b.fecha, { campo: 'Fecha', requerido: true }),
    vencimiento: fecha(b.vencimiento, { campo: 'Vencimiento' }),
    cae: texto(b.cae), asociado_id: texto(b.asociado_id), notas: texto(b.notas),
  };
  if (!TIPOS.includes(c.tipo)) throw new ErrorUsuario('Tipo de comprobante inválido.');
  if (!LETRAS.includes(c.letra)) throw new ErrorUsuario('La letra es A, B, C o M (o X si no es fiscal).');
  if ((c.punto_venta !== null && !/^\d+$/.test(c.punto_venta)) || (c.numero !== null && !/^\d+$/.test(c.numero)))
    throw new ErrorUsuario('Punto de venta y número van en enteros.');
  if (noFiscal) { c.cae = null; if (c.numero === null) c.punto_venta = null; else if (c.punto_venta === null) c.punto_venta = '0'; }
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
  // Las compras todavía sin recibir no aparecen para tildar (las armadas con "Recibir mercadería"):
  // guardar el borrador no les quita el vínculo.
  await cn.query(`DELETE FROM fin.comprobante_compra x USING logic.compra co
                   WHERE x.comprobante_id = $1 AND co.id = x.compra_id AND co.estado = 'recibida'`, [id]);
  for (const [i, x] of c.items.entries())
    await cn.query(
      `INSERT INTO fin.comprobante_item (comprobante_id, orden, producto_id, compra_item_id, descripcion, unidad,
                                         cantidad, precio_unitario, descuento_pct, alicuota, rubro_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, i, x.producto_id, x.compra_item_id, x.descripcion, x.unidad, x.cantidad, x.precio, x.descuento, x.alicuota, x.rubro_id]);
  for (const t of c.tributos)
    await cn.query('INSERT INTO fin.comprobante_tributo (comprobante_id, tipo, jurisdiccion, descripcion, importe) VALUES ($1,$2,$3,$4,$5)',
      [id, t.tipo, t.jurisdiccion, t.descripcion, t.importe]);
  for (const compra of new Set(c.compras)) {
    const { rows: [co] } = await cn.query('SELECT proveedor_id, estado FROM logic.compra WHERE id = $1::uuid', [compra]);
    if (!co || co.proveedor_id !== c.proveedor_id) throw new ErrorUsuario('Una compra vinculada no es de este proveedor.');
    await cn.query('INSERT INTO fin.comprobante_compra (comprobante_id, compra_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, compra]);
  }
}

// Sin vencimiento, el plazo de pago del proveedor; sin plazo, la fecha del comprobante.
const VENCIMIENTO = `COALESCE($7::date, $6::date + (SELECT plazo_pago_dias FROM logic.proveedor WHERE id = $1::uuid), $6::date)`;

// Alta y edición de un comprobante ya validado (leerComprobante), dentro de una transacción. Las usan
// estas rutas y el proceso de abastecimiento.
async function insertarComprobante(cn, c) {
  const { rows: [n] } = await cn.query(
    `INSERT INTO fin.comprobante (proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, cae, asociado_id, notas, sociedad_id)
     VALUES ($1,$2,$3,$4,$5,$6,${VENCIMIENTO},$8,$9,$10,$11) RETURNING id`,
    [c.proveedor_id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha, c.vencimiento, c.cae, c.asociado_id, c.notas, c.sociedad_id]);
  await guardarDetalle(cn, n.id, c);
  return n.id;
}
async function actualizarComprobante(cn, id, c) {
  const { rows: [ant] } = await cn.query('SELECT estado FROM fin.comprobante WHERE id = $1::uuid FOR UPDATE', [id]);
  if (!ant) throw new ErrorUsuario('No existe ese comprobante.', 404);
  if (ant.estado !== 'borrador') throw new ErrorUsuario(`El comprobante está ${ant.estado}: no se edita.`);
  // Primero el detalle (con la letra nueva ya aplicada a las alícuotas) y después la cabecera:
  // al revés, pasar de A a B con alícuotas cargadas lo frenaría la base.
  await cn.query('DELETE FROM fin.comprobante_item WHERE comprobante_id = $1', [id]);
  await cn.query(
    `UPDATE fin.comprobante SET proveedor_id=$1, tipo=$2, letra=$3, punto_venta=$4, numero=$5, fecha=$6,
            vencimiento=${VENCIMIENTO}, cae=$8, asociado_id=$9, notas=$10, sociedad_id=$12 WHERE id=$11`,
    [c.proveedor_id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha, c.vencimiento, c.cae, c.asociado_id, c.notas, id, c.sociedad_id]);
  await guardarDetalle(cn, id, c);
}

r.post('/fin/comprobantes', h(async (req, res) => {
  const c = leerComprobante(req.body);
  const id = await enTransaccion(cn => insertarComprobante(cn, c));
  res.status(201).json({ ok: true, id });
}));

r.put('/fin/comprobantes/:id', h(async (req, res) => {
  const c = leerComprobante(req.body);
  await enTransaccion(cn => actualizarComprobante(cn, req.params.id, c));
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
    monto(t.importe, { campo: `Importe del impuesto ${i + 1}`, requerido: true }));
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
  const total = monto(req.body.total, { campo: 'El total impreso', requerido: true });
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
    `SELECT id, tipo, letra, punto_venta, numero, fecha, total::text, sociedad_id FROM fin.comprobante
      WHERE proveedor_id = $1::uuid AND tipo = 'factura' AND estado = 'registrado' AND ($2::uuid IS NULL OR sociedad_id = $2)
      ORDER BY fecha DESC LIMIT 200`, [proveedor, texto(req.query.sociedad)]);
  res.json({ ok: true, facturas: rows.map(c => ({ ...c, nro: nro(c) })) });
}));

// Compras con sus renglones listos para copiar a la factura. El precio unitario sale del total del
// renglón de la compra: quien carga verifica que sea neto de IVA. Por proveedor (las recibidas) o una
// sola compra por id (la usa el proceso de abastecimiento, esté o no recibida).
async function comprasConRenglones(cn, id, { porId = false } = {}) {
  const { rows } = await cn.query(
    `SELECT co.id, co.numero, co.fecha, co.recibida_en,
            (SELECT string_agg(DISTINCT CASE c.tipo WHEN 'factura' THEN 'FC' WHEN 'nota_debito' THEN 'ND' ELSE 'NC' END || ' ' ||
                               c.letra || ' ' || lpad(c.punto_venta::text, 5, '0') || '-' || lpad(c.numero::text, 8, '0'), ', ')
               FROM fin.comprobante_compra x JOIN fin.comprobante c ON c.id = x.comprobante_id
              WHERE x.compra_id = co.id AND c.estado <> 'anulado') AS facturada_en,
            COALESCE(json_agg(json_build_object(
              'compra_item_id', ci.id, 'producto_id', ci.producto_id,
              -- Los importes son enteros: si el precio unitario no da entero, va 1 por el total y la
              -- cantidad en la descripción, para que el renglón cierre exacto.
              'descripcion', p.nombre || COALESCE(' (' || pr.nombre || ')', '')
                             || CASE WHEN qq.exacto THEN '' ELSE ' x ' || trim_scale(qq.q) || ' ' || COALESCE(pr.nombre, un.codigo, p.unidad_base) END,
              'unidad', CASE WHEN qq.exacto THEN COALESCE(pr.nombre, un.codigo, p.unidad_base) END,
              'cantidad', CASE WHEN qq.exacto THEN trim_scale(qq.q)::text ELSE '1' END,
              'precio', CASE WHEN ci.precio_total IS NULL THEN NULL WHEN qq.exacto THEN trim_scale(ci.precio_total / qq.q)::text
                             ELSE trim_scale(ci.precio_total)::text END,
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
       LEFT JOIN LATERAL (SELECT x.q, ci.precio_total IS NULL OR ci.precio_total % x.q = 0 AS exacto
                            FROM (SELECT CASE WHEN pr.id IS NULL AND un.codigo IS NULL THEN ci.cantidad_base ELSE ci.cantidad END AS q) x) qq ON true
      WHERE (${porId ? 'co.id = $1::uuid' : "co.proveedor_id = $1::uuid AND co.estado = 'recibida'"})
      GROUP BY co.id ORDER BY co.fecha DESC LIMIT 100`, [id]);
  return rows;
}
r.get('/fin/compras', h(async (req, res) => {
  const proveedor = texto(req.query.proveedor, { campo: 'el proveedor', requerido: true });
  res.json({ ok: true, compras: await comprasConRenglones(pool, proveedor) });
}));

// Los comprobantes de una compra, con lo que falta pagar: la compra muestra en qué quedó y lleva al pago.
r.get('/fin/compras/:id/comprobantes', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha, c.estado, c.total::text, cp.pendiente::text
       FROM fin.comprobante_compra x
       JOIN fin.comprobante c ON c.id = x.comprobante_id
       LEFT JOIN fin.comprobante_pendiente cp ON cp.comprobante_id = c.id
      WHERE x.compra_id = $1::uuid ORDER BY c.fecha, c.numero`, [req.params.id]);
  res.json({ ok: true, comprobantes: rows.map(c => ({ ...c, nro: nro(c) })) });
}));

// ── Cuenta corriente ─────────────────────────────────────────────────────────────────────────
// Por proveedor, el saldo con todo el grupo o con una sociedad (?sociedad=), con lo que tiene con cada sociedad.
r.get('/fin/cuenta-corriente', h(async (req, res) => {
  const soc = texto(req.query.sociedad);
  const { rows } = await pool.query(
    `WITH s AS (SELECT proveedor_id, SUM(saldo) AS saldo, MAX(ultimo_movimiento) AS ultimo_movimiento,
                       json_agg(json_build_object('sociedad_id', x.sociedad_id, 'sociedad', so.nombre, 'saldo', x.saldo::text) ORDER BY so.nombre) AS sociedades
                  FROM fin.saldo_proveedor_sociedad x JOIN org.sociedad so ON so.id = x.sociedad_id
                 WHERE $1::uuid IS NULL OR x.sociedad_id = $1 GROUP BY proveedor_id)
     SELECT pv.id, pv.nombre, pv.cuit, s.saldo::text, s.ultimo_movimiento, s.sociedades, v.vencido, v.vence_7, v.proximo_vencimiento
       FROM s
       JOIN logic.proveedor pv ON pv.id = s.proveedor_id
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(cp.pendiente) FILTER (WHERE cp.vencimiento < current_date), 0)::text AS vencido,
                COALESCE(SUM(cp.pendiente) FILTER (WHERE cp.vencimiento BETWEEN current_date AND current_date + 7), 0)::text AS vence_7,
                MIN(cp.vencimiento) FILTER (WHERE cp.vencimiento >= current_date) AS proximo_vencimiento
           FROM fin.comprobante_pendiente cp
          WHERE cp.proveedor_id = s.proveedor_id AND cp.pendiente > 0 AND ($1::uuid IS NULL OR cp.sociedad_id = $1)) v
      ORDER BY s.saldo DESC, pv.nombre`, [soc]);
  const { rows: [tot] } = await pool.query(
    `SELECT COALESCE(SUM(saldo), 0)::text AS saldo FROM fin.saldo_proveedor_sociedad WHERE $1::uuid IS NULL OR sociedad_id = $1`, [soc]);
  res.json({ ok: true, proveedores: rows, total: tot.saldo });
}));

// Resumen por proveedor para la grilla de Proveedores (pedido de Fer, 15/11/2026): saldo, último comprobante, lo comprado en los
// últimos 30 días y cuántos comprobantes tiene. Lo comprado: facturas y notas de débito menos notas de crédito, registradas.
// ── Cuentas por pagar ────────────────────────────────────────────────────────────────────────
// Todo lo que el grupo debe o va a deber a sus proveedores, en un lugar (pedido de Fer, 18/11/2026): facturas pendientes (con lo
// vencido y lo que vence), notas de crédito sin usar, cheques propios sin debitar, mercadería pedida que no llegó y mercadería
// recibida sin factura. Nada se guarda: sale de fin.comprobante_pendiente, fin.credito_pendiente, fin.cheque y logic.compra.
// `?sociedad=` filtra lo financiero; las compras son del centro (no tienen sociedad) y van siempre.
r.get('/fin/cuentas-por-pagar', h(async (req, res) => {
  const soc = texto(req.query.sociedad);
  const [fac, cred, cheq, pedidas, sinFactura] = await Promise.all([
    pool.query(
      `SELECT cp.comprobante_id AS id, cp.proveedor_id, pv.nombre AS proveedor, cp.tipo, cp.letra, cp.punto_venta, cp.numero,
              to_char(cp.fecha, 'YYYY-MM-DD') AS fecha, to_char(cp.vencimiento, 'YYYY-MM-DD') AS vencimiento,
              (current_date - cp.vencimiento) AS dias, c.total::text AS total, cp.pendiente::text AS pendiente,
              cp.sociedad_id, so.nombre AS sociedad,
              (SELECT x.compra_id FROM fin.comprobante_compra x WHERE x.comprobante_id = cp.comprobante_id LIMIT 1) AS compra_id
         FROM fin.comprobante_pendiente cp
         JOIN fin.comprobante c ON c.id = cp.comprobante_id
         JOIN logic.proveedor pv ON pv.id = cp.proveedor_id
         LEFT JOIN org.sociedad so ON so.id = cp.sociedad_id
        WHERE cp.pendiente >= 1 AND ($1::uuid IS NULL OR cp.sociedad_id = $1::uuid)
        ORDER BY cp.vencimiento NULLS LAST, cp.fecha`, [soc]),
    pool.query(
      `SELECT cr.comprobante_id AS id, cr.proveedor_id, pv.nombre AS proveedor, cr.letra, cr.punto_venta, cr.numero,
              to_char(cr.fecha, 'YYYY-MM-DD') AS fecha, cr.disponible::text AS disponible, so.nombre AS sociedad
         FROM fin.credito_pendiente cr JOIN logic.proveedor pv ON pv.id = cr.proveedor_id LEFT JOIN org.sociedad so ON so.id = cr.sociedad_id
        WHERE cr.disponible >= 1 AND ($1::uuid IS NULL OR cr.sociedad_id = $1::uuid) ORDER BY cr.fecha`, [soc]),
    pool.query(
      `SELECT ch.id, ch.numero, ch.banco, ch.importe::text AS importe, to_char(ch.fecha_pago, 'YYYY-MM-DD') AS fecha_pago,
              (current_date - ch.fecha_pago) AS dias, pv.nombre AS proveedor, cu.nombre AS cuenta
         FROM fin.cheque ch JOIN fin.cuenta cu ON cu.id = ch.cuenta_id LEFT JOIN logic.proveedor pv ON pv.id = ch.proveedor_id
        WHERE ch.tipo = 'propio' AND ch.estado = 'emitido' AND ($1::uuid IS NULL OR cu.sociedad_id = $1::uuid OR cu.sociedad_id IS NULL)
        ORDER BY ch.fecha_pago`, [soc]),
    pool.query(
      `SELECT co.id, co.estado, to_char(co.fecha, 'YYYY-MM-DD') AS fecha, (current_date - co.fecha) AS dias, pv.nombre AS proveedor,
              count(ci.id)::int AS renglones, SUM(ci.precio_total)::text AS importe, bool_or(ci.precio_total IS NULL) AS sin_precio,
              string_agg(p.nombre, ', ' ORDER BY p.nombre) AS productos
         FROM logic.compra co JOIN logic.proveedor pv ON pv.id = co.proveedor_id
         LEFT JOIN logic.compra_item ci ON ci.compra_id = co.id LEFT JOIN logic.producto p ON p.id = ci.producto_id
        WHERE co.estado IN ('borrador', 'pedida')
        GROUP BY co.id, pv.nombre ORDER BY co.fecha`),
    pool.query(
      `SELECT co.id, to_char(co.fecha, 'YYYY-MM-DD') AS fecha, to_char(co.recibida_en, 'YYYY-MM-DD') AS recibida,
              (current_date - co.recibida_en::date) AS dias, pv.nombre AS proveedor,
              count(ci.id)::int AS renglones, SUM(ci.precio_total)::text AS importe,
              (SELECT c.id FROM fin.comprobante_compra x JOIN fin.comprobante c ON c.id = x.comprobante_id
                WHERE x.compra_id = co.id AND c.estado = 'borrador' LIMIT 1) AS borrador_id
         FROM logic.compra co JOIN logic.proveedor pv ON pv.id = co.proveedor_id LEFT JOIN logic.compra_item ci ON ci.compra_id = co.id
        WHERE co.estado = 'recibida'
          AND NOT EXISTS (SELECT 1 FROM fin.comprobante_compra x JOIN fin.comprobante c ON c.id = x.comprobante_id
                           WHERE x.compra_id = co.id AND c.estado = 'registrado')
        GROUP BY co.id, pv.nombre ORDER BY co.recibida_en`),
  ]);
  const corto = { factura: 'FC', nota_debito: 'ND', nota_credito: 'NC' };
  const facturas = fac.rows.map(f => ({ ...f, nro: `${corto[f.tipo] || 'FC'} ${f.letra} ${String(f.punto_venta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}` }));
  const creditos = cred.rows.map(f => ({ ...f, nro: `NC ${f.letra} ${String(f.punto_venta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}` }));
  res.json({ ok: true, hoy: new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' }),
    facturas, creditos, cheques: cheq.rows, por_recibir: pedidas.rows, sin_factura: sinFactura.rows });
}));

r.get('/fin/proveedores/resumen', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pv.id, COALESCE((SELECT SUM(saldo) FROM fin.saldo_proveedor_sociedad x WHERE x.proveedor_id = pv.id), 0)::text AS saldo,
            c.ultimo, c.comprobantes, c.comprado_30::text,
            COALESCE((SELECT SUM(cp.pendiente) FROM fin.comprobante_pendiente cp WHERE cp.proveedor_id = pv.id AND cp.pendiente > 0 AND cp.vencimiento < current_date), 0)::text AS vencido
       FROM logic.proveedor pv
       CROSS JOIN LATERAL (
         SELECT to_char(MAX(fecha), 'YYYY-MM-DD') AS ultimo, COUNT(*)::int AS comprobantes,
                COALESCE(SUM(CASE WHEN tipo = 'nota_credito' THEN -total ELSE total END) FILTER (WHERE fecha > current_date - 30), 0) AS comprado_30
           FROM fin.comprobante WHERE proveedor_id = pv.id AND estado = 'registrado') c`);
  res.json({ ok: true, proveedores: rows });
}));

r.get('/fin/cuenta-corriente/:proveedor', h(async (req, res) => {
  const { rows: [pv] } = await pool.query('SELECT id, nombre, cuit, condicion_iva, plazo_pago_dias FROM logic.proveedor WHERE id = $1::uuid', [req.params.proveedor]);
  if (!pv) throw new ErrorUsuario('No existe ese proveedor.', 404);
  const [movs, pend] = await Promise.all([
    pool.query(
      `SELECT m.id, m.fecha, m.ocurrido_en, m.tipo, m.comprobante_id, m.debe::text, m.haber::text, m.detalle, m.registrado_por,
              m.anula_a, so.nombre AS sociedad, SUM(m.haber - m.debe) OVER (ORDER BY m.fecha, m.id)::text AS saldo
         FROM fin.movimiento_cc m JOIN org.sociedad so ON so.id = m.sociedad_id
        WHERE m.proveedor_id = $1 AND ($2::uuid IS NULL OR m.sociedad_id = $2) ORDER BY m.fecha, m.id`, [pv.id, texto(req.query.sociedad)]),
    pool.query(
      `SELECT cp.comprobante_id, cp.tipo, cp.letra, cp.punto_venta, cp.numero, cp.fecha, cp.vencimiento, cp.pendiente::text,
              (cp.vencimiento - current_date) AS dias, cp.sociedad_id, so.nombre AS sociedad
         FROM fin.comprobante_pendiente cp JOIN org.sociedad so ON so.id = cp.sociedad_id
        WHERE cp.proveedor_id = $1 AND cp.pendiente > 0 AND ($2::uuid IS NULL OR cp.sociedad_id = $2) ORDER BY cp.vencimiento`, [pv.id, texto(req.query.sociedad)]),
  ]);
  res.json({ ok: true, proveedor: pv, movimientos: movs.rows, pendientes: pend.rows.map(c => ({ ...c, nro: nro(c) })) });
}));

// ── Libro IVA compras ────────────────────────────────────────────────────────────────────────
// CSV del mes para el contador. Separador ';' y coma decimal, que es lo que abre bien Excel en
// español; con BOM para que respete los acentos. Las notas de crédito van en negativo.
r.get('/fin/libro-iva', h(async (req, res) => {
  const mes = texto(req.query.mes, { campo: 'el mes', requerido: true });
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new ErrorUsuario('El mes va como AAAA-MM.');
  // Es de una sociedad (su CUIT): cada una tiene su libro.
  const { rows: [so] } = await pool.query('SELECT id, nombre FROM org.sociedad WHERE id = $1::uuid',
    [texto(req.query.sociedad, { campo: 'la sociedad del libro IVA', requerido: true })]);
  if (!so) throw new ErrorUsuario('No existe esa sociedad.');
  const { rows } = await pool.query(
    `WITH c AS (
       SELECT c.*, pv.nombre AS proveedor, pv.cuit, CASE WHEN c.tipo = 'nota_credito' THEN -1 ELSE 1 END AS signo
         FROM fin.comprobante c JOIN logic.proveedor pv ON pv.id = c.proveedor_id
        WHERE c.estado = 'registrado' AND c.letra <> 'X' AND to_char(c.fecha, 'YYYY-MM') = $1 AND c.sociedad_id = $2)
     SELECT to_char(c.fecha, 'DD/MM/YYYY') AS fecha, c.tipo, c.letra, c.punto_venta, c.numero, c.cuit, c.proveedor, c.signo,
            ${['21', '10.5', '27', '5', '2.5', '0'].map(a =>
              `COALESCE((SELECT neto FROM fin.comprobante_iva v WHERE v.comprobante_id = c.id AND v.alicuota = ${a}), 0) * c.signo AS "neto_${a}",
               COALESCE((SELECT iva FROM fin.comprobante_iva v WHERE v.comprobante_id = c.id AND v.alicuota = ${a}), 0) * c.signo AS "iva_${a}"`).join(',\n')},
            t.no_gravado * c.signo AS no_gravado,
            ${['percepcion_iva', 'percepcion_iibb', 'percepcion_ganancias', 'impuesto_interno', 'otro'].map(x =>
              `COALESCE((SELECT SUM(importe) FROM fin.comprobante_tributo tr WHERE tr.comprobante_id = c.id AND tr.tipo = '${x}'), 0) * c.signo AS "${x}"`).join(',\n')},
            c.ajuste_redondeo * c.signo AS redondeo, c.total * c.signo AS total
       FROM c JOIN fin.comprobante_totales t ON t.comprobante_id = c.id
      ORDER BY c.fecha, c.proveedor, c.numero`, [mes, so.id]);
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
  res.setHeader('Content-Disposition', `attachment; filename="libro-iva-compras-${so.nombre.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '')}-${mes}.csv"`);
  res.send(csv);
}));

// La sociedad que se propone para un comprobante nuevo del proveedor: la de su último comprobante; si no tiene y hay una sola
// sociedad activa, ésa. Si no, se elige.
async function sociedadSugerida(cn, proveedorId) {
  const { rows: [x] } = await cn.query(
    `SELECT COALESCE((SELECT sociedad_id FROM fin.comprobante WHERE proveedor_id = $1::uuid AND estado <> 'anulado' ORDER BY creado_en DESC LIMIT 1),
                     (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id::text)::uuid END FROM org.sociedad WHERE activa)) AS id`, [proveedorId]);
  return x.id;
}
r.get('/fin/sociedad-sugerida', h(async (req, res) => {
  res.json({ ok: true, sociedad_id: await sociedadSugerida(pool, texto(req.query.proveedor, { campo: 'el proveedor', requerido: true })) });
}));

// Para el proceso de abastecimiento (abastecimiento.js).
Object.assign(r, { leerComprobante, insertarComprobante, actualizarComprobante, comprasConRenglones, sociedadSugerida });
// ── Pagos sin factura (pedido de Fer, 15/11/2026; migración 20261147) ─────────────────────────────────────────────────────────
// Egresos que ya están en tesorería (muchos registrados desde el extracto con su rubro) y que todavía no tienen la factura del
// proveedor. Cargar la factura y vincularla con el pago la deja compensada en la cuenta corriente: no mueve plata ni cambia el
// estado de resultados (el costo sigue saliendo del egreso, en el mes del pago).
// Por defecto, las líneas del estado donde van las compras y los servicios; con `todo=1`, también sueldos, impuestos y bancarios.
const LINEAS_COMPRA = ['cmv', 'locacion', 'operativos', 'comercializacion', 'administracion', 'inversiones', 'otros', 'fuera'];
const PAGOS_SIN_FACTURA = `
  SELECT m.id, to_char(m.fecha, 'YYYY-MM-DD') AS fecha, m.salida AS salida, m.concepto, c.id AS cuenta_id, c.nombre AS cuenta, c.tipo AS cuenta_tipo,
         c.sociedad_id, so.nombre AS sociedad, r.nombre AS rubro, r.linea, r.id AS rubro_id,
         (SELECT string_agg(DISTINCT x.destinatario, ' · ') FROM fin.conciliacion k JOIN fin.extracto_linea x ON x.id = k.linea_id
           WHERE k.movimiento_id = m.id AND x.destinatario IS NOT NULL) AS destinatario,
         COALESCE((SELECT SUM(pp.importe) FROM fin.pago_previo pp WHERE pp.movimiento_id = m.id), 0) AS aplicado
    FROM fin.movimiento_tes m
    JOIN fin.cuenta c ON c.id = m.cuenta_id LEFT JOIN org.sociedad so ON so.id = c.sociedad_id
    LEFT JOIN fin.clasificacion k ON k.movimiento_id = m.id LEFT JOIN fin.rubro r ON r.id = k.rubro_id
   WHERE m.tipo = 'egreso' AND m.salida > 0 AND m.anula_a IS NULL AND m.orden_pago_id IS NULL AND m.gasto IS NULL
     AND m.pos_cobro_id IS NULL AND m.ticket_pago_id IS NULL AND m.cheque_id IS NULL
     AND c.tipo IN ('banco', 'caja', 'socios')
     AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes z WHERE z.anula_a = m.id)`;

r.get('/fin/pagos-sin-factura', h(async (req, res) => {
  const desde = fecha(req.query.desde, { campo: 'Desde' }), hasta = fecha(req.query.hasta, { campo: 'Hasta' });
  const todo = req.query.todo === '1', q = texto(req.query.q), sociedad = texto(req.query.sociedad), id = numero(req.query.id, { campo: 'el pago' });
  const { rows } = await pool.query(
    `SELECT x.*, (x.salida - x.aplicado)::text AS disponible, x.salida::text AS importe, x.aplicado::text AS aplicado FROM (${PAGOS_SIN_FACTURA}) x
      WHERE x.salida > x.aplicado
        AND ($1::date IS NULL OR x.fecha::date >= $1) AND ($2::date IS NULL OR x.fecha::date <= $2)
        AND ($3 OR x.linea IS NULL OR x.linea = ANY($4::text[]))
        AND ($5::text IS NULL OR translate(lower(COALESCE(x.concepto, '') || ' ' || COALESCE(x.destinatario, '') || ' ' || COALESCE(x.rubro, '')), 'áéíóúüñ', 'aeiouun') LIKE '%' || translate(lower($5), 'áéíóúüñ', 'aeiouun') || '%'
             OR to_char(x.salida, 'FM999999999990') LIKE $5 || '%')
        AND ($6::text IS NULL OR ($6 = 'grupo' AND x.sociedad_id IS NULL) OR x.sociedad_id::text = $6)
        AND ($7::bigint IS NULL OR x.id = $7)
      ORDER BY x.fecha DESC, x.id DESC LIMIT 501`,
    [desde, hasta, todo || !!id, LINEAS_COMPRA, q, sociedad, id]);
  res.json({ ok: true, recortado: rows.length > 500, pagos: rows.slice(0, 500) });
}));

// Vincular pagos con una factura registrada: cada uno por lo que se le aplica, sin pasar lo que salió ni lo pendiente. El pago
// tiene que ser de una cuenta de la sociedad de la factura o del grupo (como una orden de pago).
r.post('/fin/comprobantes/:id/pago-previo', h(async (req, res) => {
  const items = (Array.isArray(req.body.pagos) ? req.body.pagos : []).map(p => ({
    id: numero(p.id, { campo: 'el pago', requerido: true }), importe: numero(p.importe, { campo: 'el importe aplicado', requerido: true }) }));
  if (!items.length) throw new ErrorUsuario('Elegí el pago.');
  if (new Set(items.map(x => x.id)).size !== items.length) throw new ErrorUsuario('Un pago está repetido.');
  await enTransaccion(async c => {
    await c.query('SELECT org.exigir_finanzas()');
    const { rows: [cp] } = await c.query(
      `SELECT co.id, co.proveedor_id, co.sociedad_id, co.tipo, co.estado, p.pendiente FROM fin.comprobante co
         LEFT JOIN fin.comprobante_pendiente p ON p.comprobante_id = co.id WHERE co.id = $1::uuid FOR UPDATE OF co`, [req.params.id]);
    if (!cp) throw new ErrorUsuario('No existe ese comprobante.', 404);
    if (cp.estado !== 'registrado' || cp.tipo === 'nota_credito') throw new ErrorUsuario('Sólo se vincula un pago con una factura o nota de débito registrada.');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['proveedor:' + cp.proveedor_id]);
    let pendiente = Number(cp.pendiente);
    for (const it of items) {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['pago-previo:' + it.id]);
      const { rows: [m] } = await c.query(
        `SELECT x.*, (x.salida - x.aplicado) AS disponible FROM (${PAGOS_SIN_FACTURA}) x WHERE x.id = $1`, [it.id]);
      if (!m) throw new ErrorUsuario(`El movimiento ${it.id} no es un pago que se pueda vincular (o ya está anulado).`);
      const { rows: [dc] } = await c.query(`SELECT ${DEL_CENTRO.replace(/x\.id/g, '$1')} AS v`, [it.id]);
      if (!dc.v && m.sociedad_id && m.sociedad_id !== cp.sociedad_id) throw new ErrorUsuario(`El pago del ${m.fecha} es de ${m.sociedad}, no de la sociedad de la factura.`);
      if (Number(it.importe) <= 0) throw new ErrorUsuario('El importe aplicado tiene que ser mayor que cero.');
      if (Number(it.importe) > Number(m.disponible)) throw new ErrorUsuario(`Al pago del ${m.fecha} le quedan ${m.disponible} sin factura.`);
      if (Number(it.importe) > pendiente + 0.004) throw new ErrorUsuario(`La factura tiene ${pendiente.toFixed(2)} pendiente: se aplica de más.`);
      pendiente -= Number(it.importe);
      const detalle = `Pagado con ${m.concepto || 'un egreso'} (${m.cuenta}, ${m.fecha.split('-').reverse().join('/')})`;
      const { rows: [cc] } = await c.query(
        `INSERT INTO fin.movimiento_cc (fecha, proveedor_id, tipo, comprobante_id, debe, detalle) VALUES ($1,$2,'pago',$3,$4,$5) RETURNING id`,
        [m.fecha, cp.proveedor_id, cp.id, it.importe, detalle]);
      await c.query('INSERT INTO fin.pago_previo (comprobante_id, movimiento_id, importe, cc_movimiento_id) VALUES ($1,$2,$3,$4)',
        [cp.id, it.id, it.importe, cc.id]);
    }
  });
  res.status(201).json({ ok: true });
}));

// Desvincular un pago: la cuenta corriente lo revierte con una anulación y la factura vuelve a quedar pendiente por eso.
r.delete('/fin/comprobantes/:id/pago-previo/:mov', h(async (req, res) => {
  const mov = numero(req.params.mov, { campo: 'el pago', requerido: true });
  await enTransaccion(async c => {
    await c.query('SELECT org.exigir_finanzas()');
    const { rows: [pp] } = await c.query(
      `SELECT pp.*, m.proveedor_id, m.detalle, m.debe FROM fin.pago_previo pp JOIN fin.movimiento_cc m ON m.id = pp.cc_movimiento_id
        WHERE pp.comprobante_id = $1::uuid AND pp.movimiento_id = $2 FOR UPDATE OF pp`, [req.params.id, mov]);
    if (!pp) throw new ErrorUsuario('Ese pago no está vinculado con la factura.', 404);
    await c.query(`INSERT INTO fin.movimiento_cc (fecha, proveedor_id, tipo, comprobante_id, debe, haber, detalle, anula_a)
                   VALUES (current_date, $1, 'anulacion', $2, 0, $3, $4, $5)`,
      [pp.proveedor_id, pp.comprobante_id, pp.debe, 'Desvincula: ' + pp.detalle, pp.cc_movimiento_id]);
    await c.query('DELETE FROM fin.pago_previo WHERE comprobante_id = $1 AND movimiento_id = $2', [pp.comprobante_id, mov]);
  });
  res.json({ ok: true });
}));

// ── Proveedores y comprobantes desde los pagos (pedido de Fer, 15/11/2026) ─────────────────────────────────────────────────────
// Los pagos sin factura traen casi siempre el proveedor en el concepto: los gastos de Fudo ("Fudo pago #2120 · Almacén · PECSE
// PESCADERIA · …", la categoría y después el proveedor), el efectivo de SORELLE ("Efectivo SORELLE #3 · Pesce"), el destinatario
// del resumen de Mercado Pago o el concepto del banco ("PILOTTI SA EMPRESA FRIGORIFICA"). Se propone el proveedor de cada pago y
// se agrupan; Fer revisa los nombres, junta los que son el mismo, elige uno existente o descarta, y al confirmar se crean los
// proveedores que faltan y un comprobante no fiscal (X) por pago, registrado y pagado con él (como "Cargar factura", sin mover
// plata ni cambiar el resultado). La sociedad de cada comprobante: la del local clasificado, si no la de la cuenta.
const GENERICOS = new Set(['sa', 'srl', 'sas', 's', 'a', 'r', 'l', 'sociedad', 'anonima', 'empresa', 'frigorifica', 'frigorifico', 'gen', 'de', 'del',
  'la', 'el', 'los', 'las', 'y', 'e', 'cia', 'sh', 'saci', 'sacif', 'srl.', 'hnos']);
const palabrasProv = t => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !GENERICOS.has(w));
const SIN_NOMBRE = /^(transferencia a banco|transferencia enviada|pago desde mercado pago|pago con qr|debito|débito|pago de servicios|extraccion|extracción)/i;
function proveedorDelPago(p) {
  const c = (p.concepto || '').trim();
  let m = /^Fudo (?:pago|gasto) #\d+ · (?:saldo pagado por los socios · )?(.*)$/.exec(c);
  if (m) {
    const segs = m[1].split(' · ').map(x => x.replace(/\s*\(.*$/, '').trim()).filter(Boolean);
    return segs.length >= 2 ? segs[1] : segs[0] || null;
  }
  m = /^Efectivo [A-Z]+ #\d+ · (.*)$/.exec(c);
  if (m) return m[1].split(' · ')[0].trim() || null;
  // El destinatario del resumen de Mercado Pago viene con lo que se hizo adelante ("Transferencia enviada Disval S.a.").
  const limpiar = t => t.replace(/^(transferencia enviada|transferencia a|pago de servicios?|pago a|pago)\s+/i, '').trim();
  if (p.destinatario) return limpiar(p.destinatario.split(' · ')[0]) || null;
  if (!c || SIN_NOMBRE.test(c)) return null;
  return limpiar(c.replace(/\s*[-–]\s*\d{6,}$/, '')) || null;
}
const titulo = t => t.length > 3 && t === t.toUpperCase() ? t.toLowerCase().replace(/(^|\s|[.(])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : t;

// La sociedad de la factura de un pago: si el rubro es del centro (mercadería e insumos), la que recibe las compras del centro
// (CORTAFUEGO, decisión de Fer, 15/11/2026); si no, la del local clasificado o la de la cuenta.
const SOCIEDAD_DEL_PAGO = `CASE WHEN (SELECT r.del_centro FROM fin.clasificacion k JOIN fin.rubro r ON r.id = k.rubro_id WHERE k.movimiento_id = x.id)
         THEN (SELECT id FROM org.sociedad WHERE compras_del_centro)
         ELSE COALESCE((SELECT se.sociedad_id FROM fin.clasificacion k JOIN org.sede se ON se.id = k.sede_id WHERE k.movimiento_id = x.id), x.sociedad_id) END`;
const DEL_CENTRO = `COALESCE((SELECT r.del_centro FROM fin.clasificacion k JOIN fin.rubro r ON r.id = k.rubro_id WHERE k.movimiento_id = x.id), false)`;
async function proponerProveedores({ todo = false, soloDelCentro = false } = {}) {
  const [{ rows: pagos }, { rows: provs }, { rows: socs }] = await Promise.all([
    pool.query(
      `SELECT x.id, x.fecha, x.concepto, x.destinatario, x.rubro, x.cuenta, (x.salida - x.aplicado)::text AS disponible,
              ${SOCIEDAD_DEL_PAGO} AS sociedad_id
         FROM (${PAGOS_SIN_FACTURA}) x
        WHERE x.salida > x.aplicado AND ($1 OR x.linea IS NULL OR x.linea = ANY($2::text[])) AND (NOT $3 OR ${DEL_CENTRO})
        ORDER BY x.fecha`, [todo, LINEAS_COMPRA, soloDelCentro]),
    pool.query('SELECT id, nombre FROM logic.proveedor WHERE activo ORDER BY nombre'),
    pool.query('SELECT id, nombre FROM org.sociedad WHERE activa ORDER BY nombre'),
  ]);
  const grupos = new Map(), sinNombre = [];
  for (const p of pagos) {
    const nombre = proveedorDelPago(p), ws = palabrasProv(nombre);
    if (!nombre || !ws.length) { sinNombre.push(p); continue; }
    const k = [...new Set(ws)].sort().join(' ');
    const g = grupos.get(k) || { clave: k, palabras: new Set(ws), nombres: new Map(), pagos: [] };
    g.nombres.set(nombre, (g.nombres.get(nombre) || 0) + 1); g.pagos.push(p);
    grupos.set(k, g);
  }
  // Un grupo cuyas palabras están contenidas en las de otro es el mismo proveedor ("PILOTTI SA" y "PILOTTI SA EMPRESA FRIGORIFICA").
  const lista = [...grupos.values()].sort((a, b) => a.palabras.size - b.palabras.size);
  for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) {
    const a = lista[i], b = lista[j];
    if (!a.pagos.length || !b.pagos.length) continue;
    if ([...a.palabras].every(w => b.palabras.has(w))) {
      b.pagos.push(...a.pagos); for (const [n, c] of a.nombres) b.nombres.set(n, (b.nombres.get(n) || 0) + c); a.pagos = [];
    }
  }
  const existentes = provs.map(p => ({ ...p, ws: new Set(palabrasProv(p.nombre)) }));
  const salida = lista.filter(g => g.pagos.length).map(g => {
    const nombre = [...g.nombres.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    const ex = existentes.find(p => p.ws.size && ([...p.ws].every(w => g.palabras.has(w)) || [...g.palabras].every(w => p.ws.has(w))));
    const socsG = [...new Set(g.pagos.map(p => p.sociedad_id))];
    return { clave: g.clave, nombre: titulo(nombre), proveedor_id: ex ? ex.id : null, proveedor: ex ? ex.nombre : null,
      sociedad_id: socsG.length === 1 ? socsG[0] : null, sociedades_mezcladas: socsG.length > 1,
      total: g.pagos.reduce((s, p) => s + Number(p.disponible), 0).toFixed(2), pagos: g.pagos };
  }).sort((a, b) => Number(b.total) - Number(a.total));
  return { grupos: salida, sin_nombre: sinNombre, proveedores: provs, sociedades: socs };
}
r.get('/fin/pagos-sin-factura/proveedores', h(async (req, res) => {
  res.json({ ok: true, ...await proponerProveedores({ todo: req.query.todo === '1' }) });
}));

// Crear: por cada grupo confirmado, el proveedor (si no se eligió uno existente) y un comprobante X por pago, registrado y pagado
// con él. Cada grupo en su transacción: si uno falla, los demás quedan hechos y la respuesta dice cuál y por qué.
async function armarComprobantes(grupos) {
  const hechos = [], errores = [];
  for (const g of grupos) {
    const nombre = texto(g.nombre), provId = texto(g.proveedor_id), socG = texto(g.sociedad_id);
    const ids = (Array.isArray(g.pagos) ? g.pagos : []).map(x => numero(x, { campo: 'el pago', requerido: true }));
    try {
      if (!provId && !nombre) throw new ErrorUsuario('Falta el nombre del proveedor.');
      if (!ids.length) throw new ErrorUsuario('El grupo no tiene pagos.');
      const n = await enTransaccion(async c => {
        await c.query('SELECT org.exigir_finanzas()');
        let pid = provId;
        if (!pid) {
          const { rows: [ya] } = await c.query('SELECT id FROM logic.proveedor WHERE lower(nombre) = lower($1)', [nombre]);
          pid = ya ? ya.id : (await c.query('INSERT INTO logic.proveedor (nombre, notas) VALUES ($1, $2) RETURNING id',
            [nombre, 'Creado desde los pagos sin factura'])).rows[0].id;
        }
        let creados = 0;
        for (const id of ids) {
          await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['pago-previo:' + id]);
          const { rows: [p] } = await c.query(
            `SELECT x.*, (x.salida - x.aplicado) AS disponible, ${SOCIEDAD_DEL_PAGO} AS soc, ${DEL_CENTRO} AS del_centro
               FROM (${PAGOS_SIN_FACTURA}) x WHERE x.id = $1`, [id]);
          if (!p || Number(p.disponible) <= 0) continue;
          const soc = socG || p.soc;
          if (!soc) throw new ErrorUsuario(`El pago del ${p.fecha.split('-').reverse().join('/')} (${p.cuenta}) es del grupo: elegí la sociedad del proveedor.`);
          // Lo del centro se factura a una sola sociedad aunque lo pague otra (decisión de Fer).
          if (!p.del_centro && p.sociedad_id && p.sociedad_id !== soc) throw new ErrorUsuario(`El pago del ${p.fecha.split('-').reverse().join('/')} es de otra sociedad (${p.sociedad}).`);
          const desc = [p.rubro, (p.concepto || '').slice(0, 160)].filter(Boolean).join(' · ') || 'Pago';
          const { rows: [cp] } = await c.query(
            `INSERT INTO fin.comprobante (proveedor_id, tipo, letra, fecha, vencimiento, notas, sociedad_id)
             VALUES ($1, 'factura', 'X', $2, $2, $3, $4) RETURNING id`,
            [pid, p.fecha, `Armado desde el pago del ${p.fecha.split('-').reverse().join('/')} (${p.cuenta})`, soc]);
          await c.query(
            `INSERT INTO fin.comprobante_item (comprobante_id, orden, descripcion, cantidad, precio_unitario, descuento_pct, alicuota, rubro_id)
             VALUES ($1, 1, $2, 1, $3, 0, NULL, $4)`, [cp.id, desc, p.disponible, p.rubro_id || null]);
          await c.query('SELECT fin.registrar_comprobante($1::uuid, $2::numeric)', [cp.id, p.disponible]);
          const detalle = `Pagado con ${p.concepto || 'un egreso'} (${p.cuenta}, ${p.fecha.split('-').reverse().join('/')})`;
          const { rows: [cc] } = await c.query(
            `INSERT INTO fin.movimiento_cc (fecha, proveedor_id, tipo, comprobante_id, debe, detalle) VALUES ($1,$2,'pago',$3,$4,$5) RETURNING id`,
            [p.fecha, pid, cp.id, p.disponible, detalle]);
          await c.query('INSERT INTO fin.pago_previo (comprobante_id, movimiento_id, importe, cc_movimiento_id) VALUES ($1,$2,$3,$4)',
            [cp.id, id, p.disponible, cc.id]);
          creados++;
        }
        return { creados, pid };
      });
      hechos.push({ nombre: nombre || g.proveedor, proveedor_id: n.pid, comprobantes: n.creados });
    } catch (e) {
      errores.push({ nombre: nombre || g.proveedor || '?', error: e.message });
    }
  }
  return { hechos, errores };
}
r.post('/fin/pagos-sin-factura/armar', h(async (req, res) => {
  const grupos = Array.isArray(req.body.grupos) ? req.body.grupos : [];
  if (!grupos.length) throw new ErrorUsuario('No hay nada para crear.');
  res.status(201).json({ ok: true, ...await armarComprobantes(grupos) });
}));

module.exports = r;
module.exports.proponerProveedores = proponerProveedores;
module.exports.armarComprobantes = armarComprobantes;
