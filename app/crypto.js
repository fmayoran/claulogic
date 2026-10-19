// Cifrado simétrico de secretos operables (AES-256-GCM), formato 'gcm$<hex iv>$<hex ct||tag>'.
//
// Mismo formato que ClaUsina a propósito —es interoperable con sus helpers de Python— pero con
// CLAVE PROPIA. APP_ENC_KEY de ClauLogic no es la de ClaUsina y no se comparte: compartirla haría
// que cualquiera de las dos apps pudiera leer los secretos de la otra, y ahí la independencia
// entre ambas deja de existir.
//
// La clave vive en el env del servicio (EasyPanel), nunca en git ni en la base.
const crypto = require('crypto');

function key() {
  const k = process.env.APP_ENC_KEY;
  if (!k) throw new Error('falta APP_ENC_KEY');
  return Buffer.from(k, 'hex');
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'gcm$' + iv.toString('hex') + '$' + Buffer.concat([ct, c.getAuthTag()]).toString('hex');
}

function decrypt(blob) {
  if (!blob) return '';
  const [v, ivh, cth] = String(blob).split('$');
  if (v !== 'gcm' || !ivh || !cth) throw new Error('ciphertext inválido');
  const buf = Buffer.from(cth, 'hex');
  const ct = buf.subarray(0, buf.length - 16), tag = buf.subarray(buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivh, 'hex'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, hasKey: () => !!process.env.APP_ENC_KEY };
