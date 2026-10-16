// Confere as maquinas do painel com os computadores do Active Directory.
// Maquina que nao existe no AD (ex.: VMs de sandbox de antivirus que executaram o instalador)
// ganha fora_dominio = 1, para aparecer marcada e no filtro "Fora do dominio".
// A consulta roda pelo PowerShell (ADSI), com a conta do servico (SYSTEM = conta do computador),
// e e refeita a cada 10 minutos. Se a consulta falhar, nada e marcado.
// Ligar: "ad": true no config.json (so funciona com o painel rodando no Windows, em maquina do dominio).
const { execFile } = require('node:child_process');
const db = require('./db');
const config = require('./config');

const estado = { nomes: null, atualizadoEm: null, erro: null };

const SCRIPT = [
  "$s = [adsisearcher]'(objectCategory=computer)'",
  '$s.PageSize = 1000',
  "[void]$s.PropertiesToLoad.Add('cn'); [void]$s.PropertiesToLoad.Add('samaccountname'); [void]$s.PropertiesToLoad.Add('dnshostname')",
  "$s.FindAll() | ForEach-Object { $_.Properties['cn'][0]; ([string]$_.Properties['samaccountname'][0]).TrimEnd('$'); ([string]$_.Properties['dnshostname'][0]).Split('.')[0] }",
].join('; ');

function consultar() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { timeout: 60_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, saida) => {
        if (err) { estado.erro = 'Falha ao consultar o AD: ' + err.message; return resolve(); }
        const nomes = new Set(String(saida).split(/\r?\n/).map((s) => s.trim().toUpperCase()).filter(Boolean));
        // Seguranca: uma resposta quase vazia indica problema na consulta, nao um AD vazio
        if (nomes.size < 10) { estado.erro = 'Consulta ao AD retornou poucos computadores (' + nomes.size + '); ignorada.'; return resolve(); }
        estado.nomes = nomes; estado.atualizadoEm = new Date().toISOString(); estado.erro = null;
        resolve();
      });
  });
}

const marcarUma = db.prepare('UPDATE maquinas SET fora_dominio = ? WHERE node_id = ? AND COALESCE(fora_dominio, -1) <> ?');
function marcar() {
  if (!estado.nomes) return;
  const maquinas = db.prepare('SELECT node_id, mesh_nome FROM maquinas WHERE removida_mesh = 0').all();
  for (const m of maquinas) {
    const nome = String(m.mesh_nome || '').trim().toUpperCase();
    // O nome NetBIOS (sAMAccountName) e cortado em 15 caracteres
    const fora = !(estado.nomes.has(nome) || estado.nomes.has(nome.slice(0, 15))) ? 1 : 0;
    marcarUma.run(fora, m.node_id, fora);
  }
}

function iniciar() {
  if (config.ad !== true || process.platform !== 'win32') return;
  const ciclo = () => consultar().then(marcar);
  ciclo();
  setInterval(ciclo, 10 * 60 * 1000);
  setInterval(marcar, 60 * 1000); // maquinas novas entram a cada sincronizacao; marca em ate 1 min
}

module.exports = { iniciar, estado };
