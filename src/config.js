const path = require('node:path');
const fs = require('node:fs');

const arquivo = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(arquivo)) {
  console.error('Falta o config.json. Copie config.example.json para config.json e preencha.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const base = path.dirname(arquivo);
config.nome ??= 'PainelRemoto';
config.porta ??= 4500;
config.host ??= '0.0.0.0';
config.sessaoHoras ??= 10;
config.mesh.syncSegundos ??= 15;
// url: como o painel alcanca o MeshCentral; urlPublica: o endereco que vai nos links abertos pelo navegador.
config.mesh.urlPublica ??= config.mesh.url;
if (config.mesh.caFile) config.mesh.caFile = path.resolve(base, config.mesh.caFile);
if (config.https) {
  config.https.cert = path.resolve(base, config.https.cert);
  config.https.key = path.resolve(base, config.https.key);
}

module.exports = config;
