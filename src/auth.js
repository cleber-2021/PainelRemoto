// Login do painel: senhas com scrypt, sessao em cookie HttpOnly guardada no SQLite.
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');

const COOKIE = 'painel_sessao';

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function confereSenha(senha, armazenado) {
  const [saltHex, hashHex] = armazenado.split(':');
  const hash = crypto.scryptSync(senha, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function criarSessao(res, usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = Date.now() + config.sessaoHoras * 3600_000;
  db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?, ?, ?)').run(token, usuarioId, expira);
  db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(Date.now());
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: !!config.https, maxAge: config.sessaoHoras * 3600_000 });
}

function encerrarSessao(req, res) {
  const token = lerCookie(req);
  if (token) db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
  res.clearCookie(COOKIE);
}

function lerCookie(req, nome = COOKIE) {
  const header = req.headers.cookie || '';
  for (const parte of header.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

function usuarioDaSessao(req) {
  const token = lerCookie(req);
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.nome, u.login, u.perfil, u.trocar_senha FROM sessoes s
    JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token = ? AND s.expira_em > ? AND u.ativo = 1
  `).get(token, Date.now()) || null;
}

function exigeLogin(req, res, next) {
  const u = usuarioDaSessao(req);
  if (!u) return res.status(401).json({ erro: 'Sessao expirada. Entre novamente.' });
  req.usuario = u;
  next();
}

// Com senha temporaria, so da para criar a nova senha (e sair).
function exigeSenhaDefinitiva(req, res, next) {
  if (req.usuario.trocar_senha && req.path !== '/minha-senha') return res.status(403).json({ erro: 'Crie uma nova senha para continuar.', trocarSenha: true });
  next();
}

function exigeAdmin(req, res, next) {
  if (req.usuario?.perfil !== 'admin') return res.status(403).json({ erro: 'Apenas administradores.' });
  next();
}

// ---- Computador confiavel ---------------------------------------------------

const COOKIE_DISPOSITIVO = 'painel_dispositivo';
const DIAS_CONFIAR = config.confiarDias ?? 30;
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function confiarDispositivo(req, res, usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const ms = DIAS_CONFIAR * 24 * 3600_000;
  db.prepare('INSERT INTO dispositivos_confiaveis (token_hash, usuario_id, expira_em, ip, navegador) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), usuarioId, Date.now() + ms, req.ip, String(req.headers['user-agent'] || '').slice(0, 200));
  db.prepare('DELETE FROM dispositivos_confiaveis WHERE expira_em < ?').run(Date.now());
  res.cookie(COOKIE_DISPOSITIVO, token, { httpOnly: true, sameSite: 'strict', secure: !!config.https, maxAge: ms });
}

function dispositivoConfiavel(req, usuarioId) {
  const token = lerCookie(req, COOKIE_DISPOSITIVO);
  if (!token) return false;
  return !!db.prepare('SELECT 1 FROM dispositivos_confiaveis WHERE token_hash = ? AND usuario_id = ? AND expira_em > ?')
    .get(hashToken(token), usuarioId, Date.now());
}

function esquecerDispositivos(usuarioId) {
  db.prepare('DELETE FROM dispositivos_confiaveis WHERE usuario_id = ?').run(usuarioId);
}

// Limite simples contra tentativa de senha: 10 erros por IP a cada 15 minutos.
const falhas = new Map();
function bloqueado(ip) {
  const f = falhas.get(ip);
  if (!f || Date.now() - f.inicio > 15 * 60_000) return false;
  return f.qtd >= 10;
}
function registrarFalha(ip) {
  const f = falhas.get(ip);
  if (!f || Date.now() - f.inicio > 15 * 60_000) falhas.set(ip, { inicio: Date.now(), qtd: 1 });
  else f.qtd++;
}

module.exports = {
  hashSenha, confereSenha, criarSessao, encerrarSessao, usuarioDaSessao,
  exigeLogin, exigeSenhaDefinitiva, exigeAdmin, lerCookie, bloqueado, registrarFalha,
  confiarDispositivo, dispositivoConfiavel, esquecerDispositivos, DIAS_CONFIAR,
};
