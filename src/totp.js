// Verificacao em duas etapas (TOTP, RFC 6238): codigo de 6 digitos que muda a cada 30s,
// compativel com Google Authenticator, Microsoft Authenticator, Authy etc.
const crypto = require('node:crypto');
const qrcode = require('qrcode-generator');
const config = require('./config');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0, valor = 0, saida = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte; bits += 8;
    while (bits >= 5) { saida += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) saida += ALFABETO[(valor << (5 - bits)) & 31];
  return saida;
}

function deBase32(txt) {
  let bits = 0, valor = 0;
  const saida = [];
  for (const c of txt.replace(/=+$/, '').toUpperCase()) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) continue;
    valor = (valor << 5) | i; bits += 5;
    if (bits >= 8) { saida.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(saida);
}

const gerarSegredo = () => base32(crypto.randomBytes(20));

function codigoNoPasso(segredo, passo) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', deBase32(segredo)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// Aceita o passo atual e um de cada lado (relogio do celular um pouco adiantado/atrasado).
// Retorna o passo usado (para impedir reuso do mesmo codigo) ou null.
function verificar(segredo, codigo) {
  const c = String(codigo || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const agora = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const esperado = codigoNoPasso(segredo, agora + d);
    if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(c))) return agora + d;
  }
  return null;
}

function qrSvg(login, segredo) {
  const uri = `otpauth://totp/${encodeURIComponent(config.nome + ':' + login)}?secret=${segredo}&issuer=${encodeURIComponent(config.nome)}`;
  const q = qrcode(0, 'M');
  q.addData(uri);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

module.exports = { gerarSegredo, verificar, qrSvg, codigoNoPasso };
