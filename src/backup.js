// Backup diario do banco do painel (usuarios, cadastro das maquinas, historico).
// Usa "VACUUM INTO", que gera uma copia consistente mesmo com o painel em uso.
// Configuracao opcional no config.json: "backup": { "pasta": "...", "dias": 30 }
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const config = require('./config');

const UM_DIA = 24 * 60 * 60 * 1000;

function pasta() {
  return path.resolve(path.join(__dirname, '..'), config.backup?.pasta || 'data/backups');
}

function fazerBackup() {
  const dir = pasta();
  fs.mkdirSync(dir, { recursive: true });
  const dia = new Date().toISOString().slice(0, 10);
  const destino = path.join(dir, `painel-${dia}.db`);
  if (fs.existsSync(destino)) return; // ja feito hoje
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  console.log('Backup do painel gravado em', destino);

  const limite = Date.now() - (config.backup?.dias ?? 30) * UM_DIA;
  for (const f of fs.readdirSync(dir)) {
    const m = /^painel-(\d{4}-\d{2}-\d{2})\.db$/.exec(f);
    if (m && new Date(m[1]).getTime() < limite) fs.rmSync(path.join(dir, f));
  }
}

function iniciarBackups() {
  const rodar = () => { try { fazerBackup(); } catch (e) { console.error('Falha no backup do painel:', e.message); } };
  rodar();
  setInterval(rodar, 60 * 60 * 1000); // confere de hora em hora; grava uma vez por dia
}

module.exports = { iniciarBackups, fazerBackup };
