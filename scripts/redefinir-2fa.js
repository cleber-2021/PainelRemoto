// Emergencia: redefine a verificacao em duas etapas de um usuario do painel
// (ex.: o unico administrador perdeu o celular). No proximo login ele cadastra o app de novo.
// Uso, no servidor, dentro da pasta do painel:
//   node scripts\redefinir-2fa.js <login>
process.chdir(require('node:path').join(__dirname, '..'));
const db = require('../src/db');

const login = process.argv[2];
if (!login) { console.log('Uso: node scripts\\redefinir-2fa.js <login>'); process.exit(1); }
const u = db.prepare('SELECT id, nome FROM usuarios WHERE login = ?').get(login);
if (!u) { console.log('Usuário não encontrado:', login); process.exit(1); }
db.prepare('UPDATE usuarios SET totp_segredo = NULL, totp_ativo = 0 WHERE id = ?').run(u.id);
db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(u.id);
db.prepare('DELETE FROM dispositivos_confiaveis WHERE usuario_id = ?').run(u.id);
console.log(`Verificação em duas etapas de "${u.nome}" redefinida. No próximo login ele cadastra o aplicativo de novo.`);
