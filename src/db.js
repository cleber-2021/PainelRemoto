// Banco local do painel (SQLite nativo do Node). Guarda usuarios do painel,
// o cadastro complementar das maquinas e o historico de acessos.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'painel.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin', 'tecnico')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em INTEGER NOT NULL
);

-- node_id e o identificador do MeshCentral (node//xxxx). Os campos "mesh_*"
-- vem da sincronizacao; os demais sao o cadastro feito no painel.
CREATE TABLE IF NOT EXISTS maquinas (
  node_id TEXT PRIMARY KEY,
  mesh_nome TEXT NOT NULL,
  mesh_grupo_id TEXT,
  mesh_grupo_nome TEXT,
  mesh_os TEXT,
  mesh_ip TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  ultimo_online TEXT,
  removida_mesh INTEGER NOT NULL DEFAULT 0,
  apelido TEXT,
  cliente TEXT,
  local TEXT,
  setor TEXT,
  responsavel TEXT,
  patrimonio TEXT,
  observacao TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT
);

CREATE TABLE IF NOT EXISTS acessos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  node_id TEXT NOT NULL,
  maquina_nome TEXT NOT NULL,
  modo TEXT NOT NULL,
  ip_origem TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_acessos_data ON acessos(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_acessos_usuario ON acessos(usuario_id, id DESC);

-- Grupos (device groups do MeshCentral) que cada tecnico pode acessar.
-- Administradores acessam todos e nao usam esta tabela.
CREATE TABLE IF NOT EXISTS usuario_grupos (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  grupo_id TEXT NOT NULL,
  PRIMARY KEY (usuario_id, grupo_id)
);
`);

// "Confiar neste computador": dispensa o codigo do app (nunca a senha) naquele navegador por N dias.
// Guarda so o hash do token; o token fica num cookie HttpOnly do navegador.
db.exec(`
CREATE TABLE IF NOT EXISTS dispositivos_confiaveis (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  expira_em INTEGER NOT NULL,
  ip TEXT,
  navegador TEXT
);
`);

// Colunas novas em bancos ja existentes
function garantirColuna(tabela, coluna, definicao) {
  const existe = db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
  if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
}
garantirColuna('usuarios', 'mesh_usuario', 'TEXT');           // usuario limitado no MeshCentral (painel-<login>)
garantirColuna('usuarios', 'totp_segredo', 'TEXT');           // verificacao em duas etapas
garantirColuna('usuarios', 'totp_ativo', 'INTEGER NOT NULL DEFAULT 0');
// Copia local da regra "pedir permissao ao usuario" (a regra vale de fato no MeshCentral: node.consent)
garantirColuna('maquinas', 'pedir_permissao', 'INTEGER NOT NULL DEFAULT 0');
// IP da placa de rede da maquina (mesh_ip e o IP de onde a conexao chega: na rede interna e o roteador)
garantirColuna('maquinas', 'ip_local', 'TEXT');
garantirColuna('maquinas', 'ip_local_em', 'TEXT');
// 1 = nome nao existe no AD (ex.: VM de sandbox de antivirus); NULL = ainda nao conferido
garantirColuna('maquinas', 'fora_dominio', 'INTEGER');

module.exports = db;
