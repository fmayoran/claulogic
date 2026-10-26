// API de tesorería: cuentas (bancos, cajas, cartera), movimientos, arqueos, cheques, órdenes de pago
// y conciliación bancaria. Todo /fin exige permiso de finanzas (auth.js); lo que mueve plata lo
// vuelve a verificar la base, que es donde se asientan los movimientos.
const express = require('express');
const { pool } = require('./db');
const { ErrorUsuario, numero, monto, texto, fecha, h, enTransaccion } = require('./util');
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

// El número de operación del procesador al que se refiere una línea: un cargo o un impuesto lo nombran en la
// referencia ("Gasto por transferencia: 1580009466", "... Ingreso #1580009466", "Pago Cliente - 1580387104"); un
// ingreso es su propio número, el que va en el concepto ("Transferencia Bancaria Ingreso - 1580009466").
const numeroEnConcepto = l => (String(l.concepto).match(/\b(\d{6,})\b/) || [])[1] || null;
function operacionDe(l) {
  const m = String(l.referencia).match(/(?:#|Pago Cliente\s*-\s*|transferencia:\s*)(\d{6,})/i);
  return m ? m[1] : numeroEnConcepto(l);
}

r.post('/fin/extractos', h(async (req, res) => {
  const b = req.body;
  const cuenta = texto(b.cuenta_id, { campo: 'la cuenta', requerido: true });
  const decimal = b.decimal === '.' ? '.' : ',';
  const filas = Array.isArray(b.filas) ? b.filas : [];
  if (!filas.length) throw new ErrorUsuario('El extracto no tiene filas.');
  if (filas.length > 5000) throw new ErrorUsuario('Demasiadas filas: importá el extracto por mes.');
  const lineas = [], vistas = new Map();
  let saldoInicial = null, saldoFinal = null;
  filas.forEach((f, i) => {
    // Filas sin fecha: totales al pie y renglones en blanco.
    if (!String(f.fecha ?? '').trim()) return;
    // Los saldos que trae el extracto (si se indicó la columna): el inicial y el final, para controlar.
    if (f.saldo !== undefined && /saldo\s+inicial/i.test(f.concepto || '')) { saldoInicial = { fecha: fechaExtracto(f.fecha, i + 1), saldo: importeExtracto(f.saldo, decimal, i + 1) }; return; }
    if (f.saldo !== undefined && /saldo\s+final/i.test(f.concepto || '')) { saldoFinal = importeExtracto(f.saldo, decimal, i + 1); return; }
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
    l.operacion = operacionDe(l);
    const clave = [l.fecha, l.importe, l.concepto, l.referencia].join('|');
    l.ocurrencia = (vistas.get(clave) || 0) + 1; vistas.set(clave, l.ocurrencia);
    lineas.push(l);
  });
  const out = await enTransaccion(async c => {
    const { rows: [cu] } = await c.query('SELECT tipo FROM fin.cuenta WHERE id = $1::uuid', [cuenta]);
    if (!cu || cu.tipo !== 'banco') throw new ErrorUsuario('El extracto es de una cuenta bancaria.');
    const fechas = lineas.map(l => l.fecha).sort();
    const { rows: [e] } = await c.query(
      'INSERT INTO fin.extracto (cuenta_id, archivo, saldo_inicial, saldo_final, desde, hasta) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [cuenta, texto(b.archivo), saldoInicial && saldoInicial.saldo, saldoFinal, (saldoInicial && saldoInicial.fecha) || fechas[0] || null, fechas.at(-1) || null]);
    // Una cuenta que recién empieza (sin movimientos) toma como apertura el saldo inicial del extracto, el día
    // anterior: así su saldo puede coincidir con el del extracto desde el primer día (decisión de Fer).
    let apertura = null;
    if (saldoInicial && !/^-?0+(\.0+)?$/.test(saldoInicial.saldo)) {
      const { rows: [{ hay }] } = await c.query('SELECT EXISTS (SELECT 1 FROM fin.movimiento_tes WHERE cuenta_id = $1) AS hay', [cuenta]);
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
  res.status(201).json({ ok: true, ...out });
}));

// Lo que falta conciliar de una cuenta, con candidatos para cada línea: movimientos sin conciliar
// del mismo importe y cheques propios emitidos por ese importe, con la fecha más cercana primero.
r.get('/fin/conciliacion', h(async (req, res) => {
  const cuenta = texto(req.query.cuenta, { campo: 'la cuenta', requerido: true });
  const [lineas, movs, cheques, hechas] = await Promise.all([
    pool.query(`SELECT l.id, l.fecha, l.concepto, l.referencia, l.importe::text FROM fin.extracto_linea l
                 WHERE l.cuenta_id = $1::uuid AND l.compensa_a IS NULL AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id)
                 ORDER BY l.fecha, l.id`, [cuenta]),
    // Los movimientos que deberían aparecer en el extracto: desde que empiezan los extractos importados (la apertura
    // y lo anterior no van a aparecer nunca), y sin los anulados ni sus anulaciones (se cancelan entre sí).
    pool.query(`SELECT m.id, m.fecha, m.tipo, m.concepto, (m.entrada - m.salida)::text AS importe FROM fin.movimiento_tes m
                 WHERE m.cuenta_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.movimiento_id = m.id)
                   AND m.tipo <> 'anulacion' AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = m.id)
                   AND m.fecha >= COALESCE((SELECT MIN(desde) FROM fin.extracto e WHERE e.cuenta_id = m.cuenta_id), '-infinity'::date)
                 ORDER BY m.fecha, m.id`, [cuenta]),
    pool.query(`SELECT id, numero, fecha_pago, (-importe)::text AS importe, proveedor_id FROM fin.cheque
                 WHERE cuenta_id = $1::uuid AND tipo = 'propio' AND estado = 'emitido'`, [cuenta]),
    pool.query(`SELECT COUNT(*)::int AS lineas, COALESCE(SUM(l.importe) FILTER (WHERE l.importe > 0), 0)::text AS ingresos,
                       COALESCE(-SUM(l.importe) FILTER (WHERE l.importe < 0), 0)::text AS egresos,
                       (SELECT COUNT(*)::int FROM fin.extracto_linea c WHERE c.cuenta_id = $1::uuid AND c.compensa_a IS NOT NULL) AS compensadas
                  FROM fin.conciliacion k JOIN fin.extracto_linea l ON l.id = k.linea_id WHERE l.cuenta_id = $1::uuid`, [cuenta]),
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
  res.json({ ok: true, lineas: out, movimientos: movs.rows, conciliado: hechas.rows[0], procesador: await resumenProcesador(cuenta),
    sugerencias: await sugerenciasProcesador(cuenta) });
}));

// Lo ya conciliado, para consultar: de a 100, lo último primero, con búsqueda por concepto o importe.
r.get('/fin/conciliacion/hechas', h(async (req, res) => {
  const cuenta = texto(req.query.cuenta, { campo: 'la cuenta', requerido: true });
  const q = texto(req.query.q), desde = Math.max(0, Number(req.query.desde) || 0);
  const { rows } = await pool.query(
    `SELECT l.id AS linea_id, l.fecha, l.concepto, l.referencia, l.importe::text, m.concepto AS movimiento, m.gasto, k.conciliado_por, k.conciliado_en
       FROM fin.conciliacion k JOIN fin.extracto_linea l ON l.id = k.linea_id JOIN fin.movimiento_tes m ON m.id = k.movimiento_id
      WHERE l.cuenta_id = $1::uuid
        AND ($2::text IS NULL OR l.concepto ILIKE '%' || $2 || '%' OR m.concepto ILIKE '%' || $2 || '%' OR l.importe::text LIKE '%' || replace($2, '.', '') || '%')
      ORDER BY l.fecha DESC, l.id DESC LIMIT 101 OFFSET $3`, [cuenta, q, desde]);
  res.json({ ok: true, conciliadas: rows.slice(0, 100), hay_mas: rows.length > 100 });
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

// Deshacer un pareo. Si el movimiento lo creó la conciliación de un procesador (una acreditación o un cargo), no
// alcanza con separarlo de la línea: se anula (las dos patas de la acreditación, con su misma fecha) y el pago de la
// venta vuelve a quedar sin acreditar, para que la línea se pueda volver a conciliar.
r.delete('/fin/conciliacion/:linea', h(async (req, res) => {
  const linea = numero(req.params.linea, { campo: 'la línea', requerido: true });
  await enTransaccion(async c => {
    const { rows: [m] } = await c.query(
      `SELECT m.* FROM fin.conciliacion k JOIN fin.movimiento_tes m ON m.id = k.movimiento_id WHERE k.linea_id = $1 FOR UPDATE OF k`, [linea]);
    // Una acreditación en partes concilia varias líneas con patas de la misma transferencia: se deshace entera.
    const { rows: grupo } = m && m.transferencia_id && m.ticket_pago_id ? await c.query(
      `SELECT k.linea_id FROM fin.conciliacion k JOIN fin.movimiento_tes x ON x.id = k.movimiento_id WHERE x.transferencia_id = $1`, [m.transferencia_id]) : { rows: [] };
    const lineas = [...new Set([linea, ...grupo.map(g => Number(g.linea_id))])];
    await c.query('DELETE FROM fin.conciliacion WHERE linea_id = ANY($1::bigint[])', [lineas]);
    if (!m || !(m.ticket_pago_id || m.gasto)) return;
    const { rows: patas } = await c.query(
      m.transferencia_id ? `SELECT * FROM fin.movimiento_tes WHERE transferencia_id = $1 AND anula_a IS NULL AND tipo <> 'anulacion'` : 'SELECT * FROM fin.movimiento_tes WHERE id = $1',
      [m.transferencia_id || m.id]);
    for (const p of patas)
      await c.query(
        `INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, transferencia_id, anula_a)
         VALUES ($1, $2, 'anulacion', $3, $4, $5, $6, $7)`,
        [p.fecha, p.cuenta_id, p.salida, p.entrada, 'Anula (se deshizo la conciliación): ' + (p.concepto || p.tipo), p.transferencia_id, p.id]);
    await c.query('UPDATE pos.ticket_pago SET acreditado_linea_id = NULL WHERE acreditado_linea_id = ANY($1::bigint[])', [lineas]);
  });
  res.json({ ok: true });
}));

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
  ['retencion', /AR_IIBB|AR_GAN|retenci[oó]n\s+(de\s+)?(iibb|ingresos\s+brutos|ganancias|iva)|retenci[oó]n\s+de\s+impuestos|percepci[oó]n/i],
  ['comision', /cargo\s+de|gasto\s+transacci|comisi[oó]n|arancel/i],
];
const clasificar = l => (GASTOS.find(([, re]) => re.test(`${l.concepto} ${l.referencia}`)) || [])[0] || null;
const esReverso = l => /reverso/i.test(`${l.concepto} ${l.referencia}`);
const normImp = v => { let [e, d = ''] = String(v).split('.'); return e + '.' + (d + '00').slice(0, 2); };
const opuesto = v => String(v).startsWith('-') ? String(v).slice(1) : '-' + v;

r.post('/fin/conciliacion/automatica', h(async (req, res) => {
  const cuenta = texto(req.body.cuenta_id, { campo: 'la cuenta', requerido: true });
  const out = await enTransaccion(async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['conciliar:' + cuenta]);
    const { rows: [pr] } = await c.query('SELECT id, nombre FROM fin.procesador WHERE cuenta_acredita_id = $1::uuid', [cuenta]);
    if (!pr) throw new ErrorUsuario('Esta cuenta no es la de un procesador: en Medios de pago, indicá en qué cuenta deposita.');
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
        WHERE mp.procesador_id = $1 AND NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL
        ORDER BY t.dia, t.cerrado_en FOR UPDATE OF p`, [pr.id]);
    const libres = new Set(pagos.map(p => p.id));
    // Operación del procesador -> pago de la venta, con lo acreditado antes (para atar costos que llegan después).
    const { rows: previos } = await c.query(
      `SELECT l.operacion, p.id FROM pos.ticket_pago p JOIN fin.extracto_linea l ON l.id = p.acreditado_linea_id
        WHERE l.cuenta_id = $1 AND l.operacion IS NOT NULL`, [cuenta]);
    const pagoDe = new Map(previos.map(x => [x.operacion, x.id]));
    let acreditadas = 0, acreditado = 0n;
    for (const l of pend.filter(l => !usadas.has(l.id) && !l.importe.startsWith('-'))) {
      const dias = p => (Date.parse(l.fecha) - Date.parse(p.dia)) / 864e5;
      const p = pagos.filter(p => libres.has(p.id) && normImp(p.importe) === normImp(l.importe) && dias(p) >= 0 && dias(p) <= 4)
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
        [l.fecha, cuenta, l.importe.slice(1), `${pr.nombre} · ${l.concepto}`.slice(0, 300), g, ivaIncluido, pagoDe.get(op) || null]);
      await conciliar(l.id, mov.id);
      usadas.add(l.id); gastos[g] = (gastos[g] || 0n) + centavos(l.importe.slice(1));
    }
    const quedan = pend.filter(l => !usadas.has(l.id)).length;
    return { procesador: pr.nombre, compensadas, acreditadas, acreditado: deCentavos(acreditado), quedan,
             gastos: Object.fromEntries(Object.entries(gastos).map(([k, v]) => [k, deCentavos(v)])) };
  });
  res.status(201).json({ ok: true, ...out });
}));

// Pareos sugeridos (decisión de Fer, 25/10/2026): lo que la conciliación automática no parea porque no coincide
// exacto, se propone para confirmar con un toque. Nunca se aplica solo.
//   · división: una venta pagada en partes (2 o 3 ingresos que suman exacto un cobro sin acreditar);
//   · diferencia: un ingreso que difiere del cobro hasta el 10% o $5.000 (lo que sea mayor); al confirmar se dice
//     el motivo. Ventana de fechas, la de la automática: del día de la venta hasta 4 días después.
const TOLERANCIA = P => { const d = P / 10n; return d > 500000n ? d : 500000n; };   // centavos
async function sugerenciasProcesador(cuenta) {
  const { rows: [pr] } = await pool.query('SELECT id FROM fin.procesador WHERE cuenta_acredita_id = $1::uuid', [cuenta]);
  if (!pr) return [];
  const [{ rows: lineas }, { rows: pagos }] = await Promise.all([
    pool.query(`SELECT l.id, to_char(l.fecha, 'YYYY-MM-DD') AS fecha, l.importe::text FROM fin.extracto_linea l
                 WHERE l.cuenta_id = $1::uuid AND l.importe > 0 AND l.compensa_a IS NULL
                   AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id) ORDER BY l.fecha, l.id`, [cuenta]),
    pool.query(`SELECT p.id, p.importe::text, to_char(t.dia, 'YYYY-MM-DD') AS dia, t.id_externo, mp.tipo_operacion
                  FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
                  JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
                 WHERE mp.procesador_id = $1 AND NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL
                 ORDER BY t.dia`, [pr.id]),
  ]);
  const dias = (l, p) => (Date.parse(l.fecha) - Date.parse(p.dia)) / 864e5, enVentana = (l, p) => dias(l, p) >= 0 && dias(l, p) <= 4;
  const abs = v => v < 0n ? -v : v, sug = [];
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
  const enDivision = new Set(sug.flatMap(x => x.lineas));
  for (const l of lineas) {
    if (enDivision.has(l.id)) continue;
    const L = centavos(l.importe);
    const p = pagos.filter(p => enVentana(l, p) && L !== centavos(p.importe) && abs(L - centavos(p.importe)) <= TOLERANCIA(centavos(p.importe)))
      .sort((a, b) => Number(abs(L - centavos(a.importe)) - abs(L - centavos(b.importe))) || dias(l, a) - dias(l, b))[0];
    if (p) sug.push({ tipo: 'diferencia', pago: p, lineas: [l.id], diferencia: deCentavos(L - centavos(p.importe)) });
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
    const { rows: [p] } = await c.query(
      `SELECT p.id, p.importe::text, t.id_externo, to_char(t.dia, 'YYYY-MM-DD') AS dia, m.cuenta_id
         FROM pos.ticket_pago p JOIN pos.ticket t ON t.id = p.ticket_id JOIN pos.medio m ON m.id = p.medio_id
         JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id
        WHERE p.id = $1::uuid AND mp.procesador_id = $2 AND NOT p.anulado AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL
        FOR UPDATE OF p`, [pagoId, pr.id]);
    if (!p) throw new ErrorUsuario('Ese cobro no está pendiente de acreditar con este procesador (o sus cobros no se procesaron).');
    const P = centavos(p.importe), L = ls.reduce((s, l) => s + centavos(l.importe), 0n), D = L - P;
    if (ls.length > 1 && D !== 0n) throw new ErrorUsuario(`Las líneas suman ${deCentavos(L)} y el cobro es de ${p.importe}: en partes, tienen que sumar exacto.`);
    if (D !== 0n) {
      if ((D < 0n ? -D : D) > TOLERANCIA(P)) throw new ErrorUsuario('La diferencia es demasiado grande para parearlos: registrá la línea como movimiento.');
      if (!motivo) throw new ErrorUsuario('Indicá el motivo de la diferencia.');
    }
    const concepto = `Acreditación ${pr.nombre} · venta ${p.id_externo} del ${p.dia}` + (ls.length > 1 ? ` · en ${ls.length} partes` : '')
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
                 WHERE mp.procesador_id = $1 AND NOT p.anulado AND t.estado = 'cerrado' AND p.cobro_id IS NOT NULL AND p.acreditado_linea_id IS NULL
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
  return { ...pr, extracto: ext, pendientes, costos, gastos_sin_venta: sinLinea };
}

// ── Medios de pago globales ──────────────────────────────────────────────────────────────────
// Procesador (Mercado Pago, Getnet, Fudo Pagos…) + tipo de operación, más el efectivo. Cada procesador
// acredita en UNA cuenta (de cobranza): si no se elige, se crea "<procesador> a acreditar". El tipo de
// operación queda en cada cobro para calcular después el costo de operar con cada uno.
const TIPOS_OP = ['transferencia', 'qr', 'debito', 'credito', 'otro'];
const MEDIOS_SQL = `SELECT mp.id, mp.procesador_id, pr.nombre AS procesador, mp.tipo_operacion, mp.activo,
                           pr.cuenta_id, cu.nombre AS cuenta
                      FROM fin.medio_pago mp LEFT JOIN fin.procesador pr ON pr.id = mp.procesador_id
                      LEFT JOIN fin.cuenta cu ON cu.id = pr.cuenta_id`;
r.get('/fin/procesadores', h(async (req, res) => {
  const { rows: procesadores } = await pool.query(
    `SELECT pr.id, pr.nombre, pr.cuenta_id, cu.nombre AS cuenta, pr.activo, sc.saldo::text AS saldo,
            pr.cuenta_acredita_id, ca.nombre AS cuenta_acredita,
            COALESCE((SELECT json_agg(mp.tipo_operacion ORDER BY mp.tipo_operacion) FROM fin.medio_pago mp
                       WHERE mp.procesador_id = pr.id AND mp.activo), '[]') AS tipos
       FROM fin.procesador pr JOIN fin.cuenta cu ON cu.id = pr.cuenta_id JOIN fin.saldo_cuenta sc ON sc.cuenta_id = cu.id
       LEFT JOIN fin.cuenta ca ON ca.id = pr.cuenta_acredita_id
      ORDER BY pr.activo DESC, pr.nombre`);
  res.json({ ok: true, procesadores });
}));
function leerProcesador(b) {
  const p = { nombre: texto(b.nombre, { campo: 'el nombre del procesador', requerido: true }), cuenta_id: texto(b.cuenta_id),
              cuenta_acredita_id: texto(b.cuenta_acredita_id),
              activo: b.activo === undefined ? true : !!b.activo,
              tipos: (Array.isArray(b.tipos) ? b.tipos : []).map(String) };
  if (p.tipos.some(t => !TIPOS_OP.includes(t))) throw new ErrorUsuario('Tipo de operación inválido.');
  if (!p.tipos.length) throw new ErrorUsuario('Elegí al menos un tipo de operación (QR, transferencia, débito, crédito).');
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
  const { rows: [n] } = await c.query(`INSERT INTO fin.cuenta (nombre, tipo) VALUES ($1, 'cobranza') RETURNING id`, [`${p.nombre} a acreditar`]);
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
r.post('/fin/procesadores', h(async (req, res) => {
  const p = leerProcesador(req.body);
  const id = await enTransaccion(async c => {
    const cuenta = await cuentaProcesador(c, p);
    const { rows: [n] } = await c.query('INSERT INTO fin.procesador (nombre, cuenta_id, activo, cuenta_acredita_id) VALUES ($1,$2,$3,$4) RETURNING id',
      [p.nombre, cuenta, p.activo, await cuentaAcredita(c, p, cuenta)]);
    await guardarTipos(c, n.id, p.tipos);
    return n.id;
  });
  res.status(201).json({ ok: true, id });
}));
r.put('/fin/procesadores/:id', h(async (req, res) => {
  const p = leerProcesador(req.body);
  await enTransaccion(async c => {
    const { rows: [ant] } = await c.query('SELECT cuenta_id FROM fin.procesador WHERE id = $1::uuid FOR UPDATE', [req.params.id]);
    if (!ant) throw new ErrorUsuario('No existe ese procesador.', 404);
    const cuenta = await cuentaProcesador(c, { ...p, cuenta_id: p.cuenta_id || ant.cuenta_id });
    await c.query('UPDATE fin.procesador SET nombre = $1, cuenta_id = $2, activo = $3, cuenta_acredita_id = $4 WHERE id = $5',
      [p.nombre, cuenta, p.activo, await cuentaAcredita(c, p, cuenta), req.params.id]);
    await guardarTipos(c, req.params.id, p.tipos);
  });
  res.json({ ok: true });
}));

Object.assign(r, { MEDIOS_SQL });
module.exports = r;
