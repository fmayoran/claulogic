// API de tesorería: cuentas (bancos, cajas, cartera), movimientos, arqueos, cheques, órdenes de pago
// y conciliación bancaria. Todo /fin exige permiso de finanzas (auth.js); lo que mueve plata lo
// vuelve a verificar la base, que es donde se asientan los movimientos.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, texto, fecha, h, enTransaccion } = require('./util');

const r = express.Router();

const nroOP = n => 'OP-' + String(n).padStart(6, '0');
const nroComp = c => `${{ factura: 'FC', nota_debito: 'ND', nota_credito: 'NC' }[c.tipo]} ${c.letra} ${String(c.punto_venta).padStart(5, '0')}-${String(c.numero).padStart(8, '0')}`;
const importe = (v, campo) => numero(v, { campo, requerido: true, positivo: true });

// ── Cuentas ──────────────────────────────────────────────────────────────────────────────────
r.get('/fin/cuentas', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.tipo, c.sede_id, s.nombre AS sede, c.banco, c.numero, c.cbu, c.alias, c.activa,
            sc.saldo::text, sc.ultimo_movimiento,
            COALESCE((SELECT SUM(importe) FROM fin.cheque ch WHERE ch.cuenta_id = c.id AND ch.tipo = 'propio' AND ch.estado = 'emitido'), 0)::text AS cheques_pendientes,
            (sc.saldo - COALESCE((SELECT SUM(importe) FROM fin.cheque ch WHERE ch.cuenta_id = c.id AND ch.tipo = 'propio' AND ch.estado = 'emitido'), 0))::text AS proyectado,
            (SELECT COUNT(*)::int FROM fin.extracto_linea l WHERE l.cuenta_id = c.id
                AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)) AS lineas_sin_conciliar
       FROM fin.cuenta c
       JOIN fin.saldo_cuenta sc ON sc.cuenta_id = c.id
       LEFT JOIN org.sede s ON s.id = c.sede_id
      ORDER BY c.activa DESC, CASE c.tipo WHEN 'banco' THEN 1 WHEN 'caja' THEN 2 ELSE 3 END, s.nombre NULLS FIRST, c.nombre`);
  res.json({ ok: true, cuentas: rows });
}));

function leerCuenta(b) {
  const c = {
    nombre: texto(b.nombre, { campo: 'el nombre', requerido: true }),
    tipo: texto(b.tipo, { campo: 'el tipo', requerido: true }),
    sede_id: texto(b.sede_id), banco: texto(b.banco), numero: texto(b.numero),
    cbu: texto(b.cbu) && texto(b.cbu).replace(/\D/g, ''), alias: texto(b.alias),
    activa: b.activa === undefined ? true : !!b.activa,
  };
  // Cobranza: tarjetas, QR y billeteras a acreditar. Lo cobrado por el POS entra ahí y pasa al banco
  // con una transferencia cuando se acredita.
  if (!['banco', 'caja', 'cobranza'].includes(c.tipo)) throw new ErrorUsuario('El tipo es banco, caja o cobranza (la cartera de cheques ya existe).');
  if (c.tipo === 'caja' && !c.sede_id) throw new ErrorUsuario('Una caja es de una sede: elegila.');
  if (c.tipo !== 'caja') c.sede_id = null;
  if (c.cbu && c.cbu.length !== 22) throw new ErrorUsuario('El CBU tiene 22 dígitos.');
  return c;
}

r.post('/fin/cuentas', h(async (req, res) => {
  const c = leerCuenta(req.body);
  const { rows: [n] } = await pool.query(
    `INSERT INTO fin.cuenta (nombre, tipo, sede_id, banco, numero, cbu, alias, activa) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [c.nombre, c.tipo, c.sede_id, c.banco, c.numero, c.cbu, c.alias, c.activa]);
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
    await cn.query('UPDATE fin.cuenta SET nombre=$1, tipo=$2, sede_id=$3, banco=$4, numero=$5, cbu=$6, alias=$7, activa=$8 WHERE id=$9',
      [c.nombre, c.tipo, c.sede_id, c.banco, c.numero, c.cbu, c.alias, c.activa, req.params.id]);
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
     numero(b.contado, { campo: 'Lo contado', requerido: true }), texto(b.motivo, { campo: 'el motivo', requerido: true })]);
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
    `SELECT o.id, o.numero, o.fecha, o.estado, o.proveedor_id, pv.nombre AS proveedor,
            COALESCE(o.total_valores + o.total_retenciones,
                     (SELECT SUM(importe) FROM fin.orden_pago_valor v WHERE v.orden_pago_id = o.id), 0)::text AS total
       FROM fin.orden_pago o JOIN logic.proveedor pv ON pv.id = o.proveedor_id
      WHERE ($1::uuid IS NULL OR o.proveedor_id = $1) AND ($2::text IS NULL OR o.estado = $2)
      ORDER BY o.fecha DESC, o.numero DESC LIMIT 300`, [texto(req.query.proveedor), texto(req.query.estado)]);
  res.json({ ok: true, ordenes: rows.map(o => ({ ...o, nro: nroOP(o.numero) })) });
}));

// Lo que se le puede pagar a un proveedor: facturas y notas de débito con pendiente, y notas de
// crédito sin factura con crédito disponible.
r.get('/fin/pendientes', h(async (req, res) => {
  const proveedor = texto(req.query.proveedor, { campo: 'el proveedor', requerido: true });
  const [deudas, creditos, saldo] = await Promise.all([
    pool.query(`SELECT comprobante_id, tipo, letra, punto_venta, numero, fecha, vencimiento, pendiente::text,
                       (vencimiento - current_date) AS dias
                  FROM fin.comprobante_pendiente WHERE proveedor_id = $1::uuid AND pendiente > 0 ORDER BY vencimiento, fecha`, [proveedor]),
    pool.query(`SELECT comprobante_id, 'nota_credito' AS tipo, letra, punto_venta, numero, fecha, disponible::text
                  FROM fin.credito_pendiente WHERE proveedor_id = $1::uuid AND disponible > 0 ORDER BY fecha`, [proveedor]),
    pool.query(`SELECT COALESCE(saldo, 0)::text AS saldo FROM fin.saldo_proveedor WHERE proveedor_id = $1::uuid`, [proveedor]),
  ]);
  res.json({ ok: true, deudas: deudas.rows.map(c => ({ ...c, nro: nroComp(c) })), creditos: creditos.rows.map(c => ({ ...c, nro: nroComp(c) })),
             saldo: saldo.rows[0] ? saldo.rows[0].saldo : '0' });
}));

r.get('/fin/ordenes-pago/:id', h(async (req, res) => {
  const { rows: [o] } = await pool.query(
    `SELECT o.*, o.total_valores::text, o.total_retenciones::text, o.total_aplicado::text, o.a_cuenta::text,
            pv.nombre AS proveedor, pv.cuit
       FROM fin.orden_pago o JOIN logic.proveedor pv ON pv.id = o.proveedor_id WHERE o.id = $1::uuid`, [req.params.id]);
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
    const { rows: [n] } = await c.query('INSERT INTO fin.orden_pago (proveedor_id, fecha, notas) VALUES ($1,COALESCE($2::date, current_date),$3) RETURNING id',
      [o.proveedor_id, o.fecha, o.notas]);
    await guardarDetalleOrden(c, n.id, o);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));

r.put('/fin/ordenes-pago/:id', h(async (req, res) => {
  const o = leerOrden(req.body);
  await enTransaccion(async c => {
    const { rowCount } = await c.query(
      `UPDATE fin.orden_pago SET proveedor_id=$1, fecha=COALESCE($2::date, fecha), notas=$3 WHERE id=$4::uuid AND estado = 'borrador'`,
      [o.proveedor_id, o.fecha, o.notas, req.params.id]);
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
  const { rows } = await pool.query(
    `SELECT to_char(o.fecha, 'DD/MM/YYYY') AS fecha, o.numero, pv.nombre AS proveedor, pv.cuit, r.impuesto, r.jurisdiccion,
            r.regimen, r.certificado, r.importe::text,
            (SELECT SUM(a.importe) FILTER (WHERE c.tipo <> 'nota_credito') - COALESCE(SUM(a.importe) FILTER (WHERE c.tipo = 'nota_credito'), 0)
               FROM fin.orden_pago_aplicacion a JOIN fin.comprobante c ON c.id = a.comprobante_id WHERE a.orden_pago_id = o.id)::text AS base
       FROM fin.orden_pago_retencion r JOIN fin.orden_pago o ON o.id = r.orden_pago_id JOIN logic.proveedor pv ON pv.id = o.proveedor_id
      WHERE o.estado = 'registrada' AND to_char(o.fecha, 'YYYY-MM') = $1 ORDER BY o.fecha, o.numero`, [mes]);
  const IMP = { ganancias: 'Ganancias', iva: 'IVA', iibb: 'Ingresos Brutos', suss: 'SUSS', otra: 'Otra' };
  const esc = s => s == null ? '' : /[;"\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s);
  const csv = '﻿' + ['Fecha;Orden de pago;Proveedor;CUIT;Impuesto;Jurisdicción;Régimen;Certificado;Base (aplicado);Importe retenido',
    ...rows.map(x => [x.fecha, nroOP(x.numero), esc(x.proveedor), x.cuit || '', IMP[x.impuesto], esc(x.jurisdiccion), esc(x.regimen),
      esc(x.certificado), (x.base || '').replace('.', ','), x.importe.replace('.', ',')].join(';'))].join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="retenciones-${mes}.csv"`);
  res.send(csv);
}));

// ── Conciliación bancaria ────────────────────────────────────────────────────────────────────
// Importe del extracto -> texto NUMERIC. El usuario dice cuál es el separador decimal: "1.234" no
// se puede adivinar (¿mil doscientos treinta y cuatro, o uno con 234?). Paréntesis = negativo.
function importeExtracto(v, decimal, n) {
  let s = String(v ?? '').trim().replace(/[$\s]/g, '');
  if (!s) return null;
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

r.post('/fin/extractos', h(async (req, res) => {
  const b = req.body;
  const cuenta = texto(b.cuenta_id, { campo: 'la cuenta', requerido: true });
  const decimal = b.decimal === '.' ? '.' : ',';
  const filas = Array.isArray(b.filas) ? b.filas : [];
  if (!filas.length) throw new ErrorUsuario('El extracto no tiene filas.');
  if (filas.length > 5000) throw new ErrorUsuario('Demasiadas filas: importá el extracto por mes.');
  const lineas = [], vistas = new Map();
  filas.forEach((f, i) => {
    // Débito y crédito en columnas separadas o un solo importe con signo: las dos formas existen.
    let imp = f.importe !== undefined && f.importe !== '' ? importeExtracto(f.importe, decimal, i + 1) : null;
    if (imp === null) {
      const deb = importeExtracto(f.debito, decimal, i + 1), cred = importeExtracto(f.credito, decimal, i + 1);
      if (deb && !/^-?0+(\.0+)?$/.test(deb)) imp = '-' + deb.replace('-', '');
      else if (cred && !/^-?0+(\.0+)?$/.test(cred)) imp = cred.replace('-', '');
    }
    if (imp === null || /^-?0+(\.0+)?$/.test(imp)) return;   // saldos iniciales, filas vacías
    const l = { fecha: fechaExtracto(f.fecha, i + 1), concepto: String(f.concepto || '').trim().slice(0, 300),
                referencia: String(f.referencia || '').trim().slice(0, 100), importe: imp };
    const clave = [l.fecha, l.importe, l.concepto, l.referencia].join('|');
    l.ocurrencia = (vistas.get(clave) || 0) + 1; vistas.set(clave, l.ocurrencia);
    lineas.push(l);
  });
  const out = await enTransaccion(async c => {
    const { rows: [cu] } = await c.query('SELECT tipo FROM fin.cuenta WHERE id = $1::uuid', [cuenta]);
    if (!cu || cu.tipo !== 'banco') throw new ErrorUsuario('El extracto es de una cuenta bancaria.');
    const { rows: [e] } = await c.query('INSERT INTO fin.extracto (cuenta_id, archivo) VALUES ($1,$2) RETURNING id', [cuenta, texto(b.archivo)]);
    let nuevas = 0;
    for (const l of lineas) {
      const { rowCount } = await c.query(
        `INSERT INTO fin.extracto_linea (extracto_id, cuenta_id, fecha, concepto, referencia, importe, ocurrencia)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [e.id, cuenta, l.fecha, l.concepto, l.referencia, l.importe, l.ocurrencia]);
      nuevas += rowCount;
    }
    await c.query('UPDATE fin.extracto SET lineas_nuevas = $1, lineas_repetidas = $2 WHERE id = $3', [nuevas, lineas.length - nuevas, e.id]);
    return { nuevas, repetidas: lineas.length - nuevas };
  });
  res.status(201).json({ ok: true, ...out });
}));

// Lo que falta conciliar de una cuenta, con candidatos para cada línea: movimientos sin conciliar
// del mismo importe y cheques propios emitidos por ese importe, con la fecha más cercana primero.
r.get('/fin/conciliacion', h(async (req, res) => {
  const cuenta = texto(req.query.cuenta, { campo: 'la cuenta', requerido: true });
  const [lineas, movs, cheques, hechas] = await Promise.all([
    pool.query(`SELECT l.id, l.fecha, l.concepto, l.referencia, l.importe::text FROM fin.extracto_linea l
                 WHERE l.cuenta_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)
                 ORDER BY l.fecha, l.id`, [cuenta]),
    pool.query(`SELECT m.id, m.fecha, m.tipo, m.concepto, (m.entrada - m.salida)::text AS importe FROM fin.movimiento_tes m
                 WHERE m.cuenta_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.movimiento_id = m.id)
                 ORDER BY m.fecha, m.id`, [cuenta]),
    pool.query(`SELECT id, numero, fecha_pago, (-importe)::text AS importe, proveedor_id FROM fin.cheque
                 WHERE cuenta_id = $1::uuid AND tipo = 'propio' AND estado = 'emitido'`, [cuenta]),
    pool.query(`SELECT l.id AS linea_id, l.fecha, l.concepto, l.importe::text, m.concepto AS movimiento, k.conciliado_por, k.conciliado_en
                  FROM fin.conciliacion k JOIN fin.extracto_linea l ON l.id = k.linea_id JOIN fin.movimiento_tes m ON m.id = k.movimiento_id
                 WHERE l.cuenta_id = $1::uuid ORDER BY k.conciliado_en DESC LIMIT 50`, [cuenta]),
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
    return { ...l, candidatos: cand };
  });
  res.json({ ok: true, lineas: out, movimientos: movs.rows, conciliadas: hechas.rows });
}));

r.post('/fin/conciliacion', h(async (req, res) => {
  const b = req.body;
  const linea = numero(b.linea_id, { campo: 'la línea', requerido: true });
  await enTransaccion(async c => {
    const { rows: [l] } = await c.query('SELECT * FROM fin.extracto_linea WHERE id = $1 FOR UPDATE', [linea]);
    if (!l) throw new ErrorUsuario('No existe esa línea del extracto.');
    let mov = texto(b.movimiento_id);
    if (b.cheque_id) {
      // El débito del cheque aparece en el extracto: recién ahí sale del banco.
      ({ rows: [{ id: mov }] } = await c.query('SELECT fin.debitar_cheque($1::uuid, $2::date) AS id', [b.cheque_id, l.fecha]));
    } else if (b.crear) {
      // Línea sin movimiento: comisión, impuesto, interés, acreditación. Se registra desde acá.
      const concepto = texto(b.crear.concepto, { campo: 'el concepto', requerido: true });
      const sale = String(l.importe).startsWith('-');
      ({ rows: [{ id: mov }] } = await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [l.fecha, l.cuenta_id, sale ? 'egreso' : 'ingreso', sale ? 0 : l.importe, sale ? String(l.importe).slice(1) : 0, concepto]));
    }
    if (!mov) throw new ErrorUsuario('Falta el movimiento a conciliar.');
    await c.query('INSERT INTO fin.conciliacion (linea_id, movimiento_id) VALUES ($1,$2)', [linea, mov]);
  });
  res.status(201).json({ ok: true });
}));

r.delete('/fin/conciliacion/:linea', h(async (req, res) => {
  await pool.query('DELETE FROM fin.conciliacion WHERE linea_id = $1', [numero(req.params.linea, { campo: 'la línea', requerido: true })]);
  res.json({ ok: true });
}));

module.exports = r;
