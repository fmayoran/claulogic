// Helpers comunes de la API: validación, traducción de errores de la base y transacciones.
//
// Las cantidades, temperaturas y costos viajan como TEXTO y llegan a la base como texto: Postgres
// los convierte a NUMERIC. Si pasaran por un Number de JavaScript serían float, y la decisión de
// no usar float en la base no serviría de nada.
const { pool } = require('./db');

// Error para mostrarle al usuario tal cual. `status` distingue un dato mal cargado (400) de un
// permiso que falta (403) o un freno por intentos (429).
class ErrorUsuario extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

// Acepta coma o punto decimal (en Argentina se escribe "1,5"). Devuelve el texto normalizado o null.
function numero(v, { campo, negativo = false, requerido = false, positivo = false } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (requerido) throw new ErrorUsuario(`Falta ${campo}.`);
    return null;
  }
  const s = String(v).trim().replace(',', '.');
  const re = negativo ? /^-?\d+(\.\d+)?$/ : /^\d+(\.\d+)?$/;
  if (!re.test(s)) throw new ErrorUsuario(`${campo}: "${v}" no es un número válido.`);
  if (positivo && /^0+(\.0+)?$/.test(s)) throw new ErrorUsuario(`${campo} tiene que ser mayor que cero.`);
  return s;
}

function texto(v, { campo, requerido = false } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s && requerido) throw new ErrorUsuario(`Falta ${campo}.`);
  return s || null;
}

function fecha(v, { campo, requerido = false } = {}) {
  const s = texto(v, { campo, requerido });
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ErrorUsuario(`${campo}: "${v}" no es una fecha válida.`);
  return s;
}

// Mensajes por restricción, para los errores de unicidad que el usuario puede provocar.
const UNICOS = {
  producto_codigo_key: 'Ya existe un producto con ese código.',
  categoria_nombre_ux: 'Ya existe una categoría con ese nombre.',
  presentacion_producto_id_nombre_key: 'Hay dos presentaciones con el mismo nombre.',
  unidad_pkey: 'Ya existe una unidad con ese código.',
  almacen_nombre_ux: 'Ya existe un almacén con ese nombre en la sede.',
  ubicacion_almacen_nombre_key: 'Ya existe una ubicación con ese nombre en el almacén.',
  lote_producto_id_codigo_key: 'Ese producto ya tiene un lote con ese código.',
  movimiento_anula_ux: 'Ese movimiento ya fue anulado.',
  receta_item_receta_id_producto_id_key: 'Un ingrediente está repetido en la receta.',
  unidad_productiva_nombre_ux: 'Ya existe una unidad productiva con ese nombre en la sede.',
  remito_pedido_ux: 'Ese pedido ya tiene un remito.',
  proveedor_cuit_ux: 'Ya existe un proveedor con ese CUIT.',
  comprobante_numero_ux: 'Ese comprobante ya está cargado para este proveedor.',
  gtin_pkey: 'Ese GTIN ya está asignado a otro producto o presentación.',
  usuario_usuario_key: 'Ya existe un usuario con ese nombre de ingreso.',
  sede_nombre_ux: 'Ya existe una sede con ese nombre.',
};

// Mensajes por restricción para los CHECK que el usuario puede violar con lo que tipea.
const CHECKS = {
  lote_codigo_gs1: 'El código de lote admite hasta 20 caracteres, sin espacios ni acentos (norma GS1).',
};

// Los errores de la base se traducen a algo que el encargado entienda. Los RAISE de nuestros
// triggers ya vienen redactados para una persona (P0001); el resto se nombra por la restricción.
function errorBase(e) {
  if (e instanceof ErrorUsuario) return e.message;
  if (e.code === 'P0001') return e.message;
  if (e.code === '23505') return UNICOS[e.constraint] || 'Ese dato ya existe.';
  if (e.code === '23503' && e.table === 'compra_item')
    return 'Una presentación que quitaste ya se usó en compras: no se puede borrar.';
  if (e.code === '23503' && /DELETE|delete/.test(e.message)) return 'No se puede borrar: está en uso.';
  if (e.code === '23503') return 'Alguno de los datos elegidos ya no existe. Recargá la página.';
  if (e.code === '23514') return CHECKS[e.constraint] || 'Algún valor está fuera de lo permitido (revisá temperaturas y cantidades).';
  if (e.code === '22P02' || e.code === '22007' || e.code === '22008') return 'Hay un dato con formato inválido.';
  if (e.code === '22003') return 'Hay un número demasiado grande.';
  return null;
}

// Envuelve un handler: errores del usuario -> 400 (o su status) con mensaje; el resto sigue al
// manejador general.
const h = fn => async (req, res, next) => {
  try { await fn(req, res, next); }
  catch (e) {
    const msg = errorBase(e);
    if (msg) return res.status(e.status || 400).json({ ok: false, error: msg });
    next(e);
  }
};

async function enTransaccion(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Cantidad en la unidad que eligió el usuario -> unidad base del producto, en NUMERIC. Se niega si
// las magnitudes no coinciden: no hay forma honesta de pasar litros a gramos.
async function aBase(c, cantidad, unidad, unidadBase, nombre) {
  const { rows: [r] } = await c.query(
    `SELECT ($1::numeric * u.factor_si / b.factor_si)::numeric(16,4)::text AS base,
            u.magnitud = b.magnitud AS compatible
       FROM logic.unidad u, logic.unidad b WHERE u.codigo = $2 AND b.codigo = $3`,
    [cantidad, unidad || unidadBase, unidadBase]);
  if (!r) throw new ErrorUsuario(`Unidad desconocida en ${nombre}.`);
  if (!r.compatible) throw new ErrorUsuario(`${nombre} está en ${unidad}, que no se puede convertir a ${unidadBase}.`);
  if (/^0+(\.0+)?$/.test(r.base)) throw new ErrorUsuario(`${nombre} queda en cero al pasarla a ${unidadBase}.`);
  return r.base;
}

// Alta de un lote. Sin código, se arma uno con la fecha ("L261020-1"): mejor un código generado
// que un lote sin identificar. Sin vencimiento, para un perecedero se calcula con la vida útil;
// si tampoco hay vida útil, la base lo rechaza.
async function crearLote(c, { producto_id, codigo, vencimiento, proveedor_id = null, costo_base = null, notas = null }) {
  const { rows: [p] } = await c.query('SELECT perecedero, vida_util_dias FROM logic.producto WHERE id = $1', [producto_id]);
  if (!p) throw new ErrorUsuario('No existe ese producto.');
  if (!vencimiento && p.perecedero && p.vida_util_dias)
    ({ rows: [{ vencimiento }] } = await c.query(
      "SELECT to_char(current_date + $1::int, 'YYYY-MM-DD') AS vencimiento", [p.vida_util_dias]));
  if (!codigo) {
    const { rows: [g] } = await c.query(
      `SELECT 'L' || to_char(current_date, 'YYMMDD') || '-' ||
              (COUNT(*) + 1) AS codigo
         FROM logic.lote WHERE producto_id = $1 AND codigo LIKE 'L' || to_char(current_date, 'YYMMDD') || '-%'`,
      [producto_id]);
    codigo = g.codigo;
  }
  const { rows: [l] } = await c.query(
    `INSERT INTO logic.lote (producto_id, codigo, vencimiento, proveedor_id, costo_base, notas)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, codigo`,
    [producto_id, codigo, vencimiento, proveedor_id, costo_base, notas]);
  return l;
}

// Unidad de REFERENCIA para mostrar costos (la marcada en logic.unidad: kg, l, u). Un costo se
// guarda por unidad base, pero "$0,0012 el gramo" no lo lee nadie; "$1.200 el kilo" sí.
// Esperan el producto con alias `p`.
const UNIDAD_REF = `(SELECT r.codigo FROM logic.unidad r JOIN logic.unidad b ON b.magnitud = r.magnitud
                      WHERE b.codigo = p.unidad_base AND r.es_referencia)`;
// Un costo por unidad base expresado en la unidad de referencia del producto `p`.
const enRef = expr => `(SELECT trim_scale((${expr} * r.factor_si / b.factor_si)::numeric(16,4))::text
                          FROM logic.unidad r, logic.unidad b
                         WHERE r.codigo = ${UNIDAD_REF} AND b.codigo = p.unidad_base)`;

module.exports = { ErrorUsuario, numero, texto, fecha, errorBase, h, enTransaccion, aBase, crearLote, UNIDAD_REF, enRef };
