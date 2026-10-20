// Emergencia: define uma senha temporaria para um usuario do painel
// (ex.: o unico administrador esqueceu a senha). No proximo login ele cria a propria.
// Uso, no servidor, dentro da pasta do painel:
//   node scripts\redefinir-senha.js <login> <senha-temporaria>
process.chdir(require('node:path').join(__dirname, '..'));
const db = require('../src/db');
const auth = require('../src/auth');

const [login, senha] = process.argv.slice(2);
if (!login || !senha) { console.log('Uso: node scripts\\redefinir-senha.js <login> <senha-temporaria>'); process.exit(1); }
if (senha.length < 8) { console.log('A senha precisa ter pelo menos 8 caracteres.'); process.exit(1); }
const u = db.prepare('SELECT id, nome FROM usuarios WHERE login = ? AND excluido_em IS NULL').get(login);
if (!u) { console.log('Usuário não encontrado:', login); process.exit(1); }
db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 1, ativo = 1 WHERE id = ?').run(auth.hashSenha(senha), u.id);
db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(u.id);
console.log(`Senha temporária definida para "${u.nome}". No próximo login ele cria uma nova.`);
