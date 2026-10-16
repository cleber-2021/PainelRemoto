// Integracao com o MeshCentral.
// - Gera "login tokens" (cookie AES-256-GCM, mesmo formato do encodeCookie do MeshCentral)
//   com a chave LoginCookieEncryptionKey configurada nos dois lados.
// - Usa esse token para abrir o websocket de controle (control.ashx) e listar grupos/maquinas.
// - Monta o link que abre a tela remota direto na maquina.
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const WebSocket = require('ws');
const db = require('./db');
const config = require('./config');

const key = Buffer.from(config.mesh.loginTokenKey, 'hex');
if (key.length !== 80) throw new Error('mesh.loginTokenKey deve ter 160 caracteres hex (80 bytes)');

// Verificacao TLS do MeshCentral:
// - caFile (teste, certificado proprio): so aceita servidor assinado por essa raiz privada,
//   e dispensa a checagem de hostname porque a raiz e exclusiva deste servidor;
// - sem caFile (producao, Let's Encrypt): validacao normal pelas CAs do sistema, conferindo o
//   nome em "servername" (permite conectar por 127.0.0.1 validando o certificado do dominio).
const tlsOpts = config.mesh.caFile
  ? { ca: fs.readFileSync(config.mesh.caFile), checkServerIdentity: () => undefined }
  : (config.mesh.servername ? { servername: config.mesh.servername } : {});

const meshUserId = 'user//' + config.mesh.user.toLowerCase();

// "loginKey" do MeshCentral: sem ela, a tela de login, a pagina principal, o websocket de controle
// e o download de instaladores respondem 404. Os agentes (agent.ashx) nao sao afetados.
const chaveUrl = config.mesh.loginKey ? '&key=' + encodeURIComponent(config.mesh.loginKey) : '';

function encodeCookie(o) {
  o.time = Math.floor(Date.now() / 1000);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key.subarray(0, 32), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(o), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64').replace(/\+/g, '@').replace(/\//g, '$');
}

// Token de uso unico, valido por 1 minuto: serve apenas para abrir aquela sessao.
// E emitido para o usuario MeshCentral DA PESSOA (painel-<login>), que so tem direito
// aos grupos liberados para ela. A conta de servico (config.mesh.user) nunca vai para o navegador.
function tokenDeAcesso(meshUsuario) {
  return encodeCookie({ u: 'user//' + meshUsuario, a: 3, expire: 1, once: crypto.randomBytes(12).toString('hex') });
}

const VIEWMODES = { desktop: 11, terminal: 12, arquivos: 13 };

function linkDeAcesso(nodeId, modo, meshUsuario) {
  const viewmode = VIEWMODES[modo];
  if (!viewmode) throw new Error('modo invalido');
  if (!meshUsuario) throw new Error('usuario do MeshCentral nao informado');
  // O id usa base64 com '@' e '$' e vai sem codificar: o MeshCentral le "gotonode" sem
  // decodificar a URL, entao "%24" no lugar de "$" faz a pagina abrir sem maquina (tela preta).
  const nodePart = nodeId.split('/')[2];
  if (!/^[A-Za-z0-9@$]+$/.test(nodePart)) throw new Error('id de maquina invalido');
  return config.mesh.urlPublica.replace(/\/$/, '') + '/?login=' + encodeURIComponent(tokenDeAcesso(meshUsuario)) +
    '&gotonode=' + nodePart +
    '&viewmode=' + viewmode +
    '&hide=31' + // esconde cabecalho, abas, rodape, titulo e menu lateral (16: sem a faixa ao sair da tela cheia)
    '&painel=1' + // ativa a conexao automatica do meshcentral-web/public/scripts/custom.js
    chaveUrl;
}

// ---- Sincronizacao das maquinas -------------------------------------------

const estado = { conectado: false, ultimaSync: null, erro: null, grupos: [] };
let ws = null;
let pedidoTimer = null;

function wsUrl() {
  const base = config.mesh.url.replace(/^http/, 'ws').replace(/\/$/, '');
  return base + '/control.ashx?auth=' + encodeURIComponent(encodeCookie({ u: meshUserId, a: 3 })) + chaveUrl;
}

const upsertMaquina = db.prepare(`
  INSERT INTO maquinas (node_id, mesh_nome, mesh_grupo_id, mesh_grupo_nome, mesh_os, mesh_ip, online, ultimo_online, removida_mesh, pedir_permissao)
  VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') END, 0, ?)
  ON CONFLICT(node_id) DO UPDATE SET
    pedir_permissao = excluded.pedir_permissao,
    mesh_nome = excluded.mesh_nome,
    mesh_grupo_id = excluded.mesh_grupo_id,
    mesh_grupo_nome = excluded.mesh_grupo_nome,
    mesh_os = COALESCE(excluded.mesh_os, maquinas.mesh_os),
    mesh_ip = COALESCE(excluded.mesh_ip, maquinas.mesh_ip),
    online = excluded.online,
    ultimo_online = CASE WHEN excluded.online = 1 THEN datetime('now') ELSE maquinas.ultimo_online END,
    removida_mesh = 0
`);

function aplicarNodes(nodesPorGrupo) {
  const nomesGrupo = Object.fromEntries(estado.grupos.map((g) => [g.id, g.nome]));
  const vistos = new Set();
  db.exec('BEGIN');
  try {
    for (const [grupoId, nodes] of Object.entries(nodesPorGrupo || {})) {
      for (const n of nodes) {
        const online = (n.conn & 1) ? 1 : 0; // bit 1 = agente conectado
        vistos.add(n._id);
        upsertMaquina.run(n._id, n.rname || n.name || n.host || n._id, // rname = nome atual do Windows (o agente informa a cada conexao)
          grupoId, nomesGrupo[grupoId] || null,
          n.osdesc || null, n.ip || null, online, online, (n.consent & CONSENTIMENTO) ? 1 : 0);
      }
    }
    // Maquinas que sumiram do MeshCentral ficam marcadas, sem apagar o cadastro.
    const todas = db.prepare('SELECT node_id FROM maquinas WHERE removida_mesh = 0').all();
    const marcar = db.prepare('UPDATE maquinas SET removida_mesh = 1, online = 0 WHERE node_id = ?');
    for (const { node_id } of todas) if (!vistos.has(node_id)) marcar.run(node_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  estado.ultimaSync = new Date().toISOString();
}

function pedirAtualizacao() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'meshes' }));
    ws.send(JSON.stringify({ action: 'nodes' }));
  }
}

function conectar() {
  ws = new WebSocket(wsUrl(), tlsOpts);

  ws.on('open', () => {
    estado.conectado = true;
    estado.erro = null;
    pedirAtualizacao();
    clearInterval(pedidoTimer);
    pedidoTimer = setInterval(pedirAtualizacao, config.mesh.syncSegundos * 1000);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.responseid && pendentes.has(msg.responseid)) {
      const p = pendentes.get(msg.responseid);
      pendentes.delete(msg.responseid);
      clearTimeout(p.timer);
      if (p.bruto || msg.result === 'ok') p.resolve(msg); else p.reject(new Error(traduzErro(msg.result)));
      return;
    }
    if (msg.action === 'users' && msg.tag && pendentes.has(msg.tag)) { // 'users' responde por tag, nao por responseid
      const p = pendentes.get(msg.tag);
      pendentes.delete(msg.tag);
      clearTimeout(p.timer);
      p.resolve(msg.users || []);
      return;
    }
    if (msg.action === 'close') {
      estado.erro = 'MeshCentral recusou a autenticacao (' + (msg.msg || msg.cause) + '). Confira o usuario "' + config.mesh.user + '" e a chave.';
      return;
    }
    if (msg.action === 'getnetworkinfo') { gravarIpLocal(msg); return; }
    if (msg.action === 'meshes') {
      estado.grupos = (msg.meshes || [])
        .filter((m) => m.mtype === 2 && !m.deleted) // so grupos de agente
        .map((m) => ({ id: m._id, nome: m.name, descricao: m.desc || '', links: m.links || {} }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      agendarSincronizacao(); // confere/corrige as permissoes sempre que a lista de grupos chega
    } else if (msg.action === 'nodes') {
      try { aplicarNodes(msg.nodes); } catch (e) { estado.erro = 'Falha ao gravar maquinas: ' + e.message; }
      pedirIpsLocais();
    } else if (msg.action === 'event' && msg.event && ['nodeconnect', 'addnode', 'removenode', 'changenode', 'nodemeshchange', 'createmesh', 'deletemesh', 'meshchange'].includes(msg.event.action)) {
      pedirAtualizacao(); // mudanca de status: atualiza na hora em vez de esperar o ciclo
    }
  });

  ws.on('close', () => {
    estado.conectado = false;
    clearInterval(pedidoTimer);
    setTimeout(conectar, 5000);
  });

  ws.on('error', (e) => {
    estado.erro = 'Sem conexao com o MeshCentral: ' + e.message;
  });
}

// ---- IP da maquina ----------------------------------------------------------
// O "ip" que o MeshCentral mostra e o de onde a conexao chega; na rede interna todas chegam
// pelo roteador. O IP real vem das placas de rede que o agente informa (getnetworkinfo).
// Pedimos aos poucos (LOTE por ciclo) e renovamos a cada 30 min.

const LOTE_IP = 20;
const RENOVAR_IP_MS = 30 * 60 * 1000;

const ehApipa = (ip) => ip.startsWith('169.254.');
function escolherIpLocal(netif2) {
  const ipv4 = [];
  for (const lista of Object.values(netif2 || {})) {
    for (const i of lista || []) {
      if ((i.family === 'IPv4' || i.family === 4) && i.address && i.type !== 'loopback' && !i.address.startsWith('127.') && !ehApipa(i.address)) ipv4.push(i);
    }
  }
  const ativas = ipv4.filter((i) => i.status === 'up');
  // 1) ativa e com gateway (a placa que de fato fala com a rede), preferindo cabo
  const comGateway = ativas.filter((i) => i.gateway);
  const escolhida = comGateway.find((i) => i.type === 'ethernet') || comGateway[0] || ativas[0] || null;
  return escolhida ? escolhida.address : null;
}

// Registra a hora da consulta mesmo sem IP valido (senao a maquina seria consultada a cada ciclo);
// sem IP novo, mantem o ultimo conhecido.
const gravarIp = db.prepare("UPDATE maquinas SET ip_local = ?, ip_local_em = datetime('now') WHERE node_id = ?");
// Sem IP na resposta (comum logo apos instalar: o agente ainda nao informou as placas):
// mantem o ultimo IP conhecido e agenda nova consulta em ~2 min, em vez de 30.
const adiarIp = db.prepare("UPDATE maquinas SET ip_local_em = datetime('now', '-28 minutes') WHERE node_id = ?");
function gravarIpLocal(msg) {
  if (!msg.nodeid) return;
  const ip = msg.noinfo ? null : escolherIpLocal(msg.netif2);
  if (ip) gravarIp.run(ip, msg.nodeid); else adiarIp.run(msg.nodeid);
}

function pedirIpsLocais() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const limite = new Date(Date.now() - RENOVAR_IP_MS).toISOString().replace('T', ' ').slice(0, 19);
  const pendentes = db.prepare(`
    SELECT node_id FROM maquinas WHERE online = 1 AND removida_mesh = 0 AND (ip_local_em IS NULL OR ip_local_em < ?)
    ORDER BY ip_local_em IS NOT NULL, ip_local_em LIMIT ?`).all(limite, LOTE_IP);
  for (const { node_id } of pendentes) ws.send(JSON.stringify({ action: 'getnetworkinfo', nodeid: node_id }));
}

// ---- Comandos com resposta (grupos) ---------------------------------------

const pendentes = new Map();

function traduzErro(e) {
  const mapa = {
    'Permission denied': 'Sem permissão no MeshCentral.',
    'Invalid group name': 'Nome de grupo inválido.',
    'Unknown device group': 'Grupo não encontrado.',
    'Device already in correct group': 'A máquina já está nesse grupo.',
    'Denied': 'Sem permissão no MeshCentral para excluir esta máquina.',
  };
  return mapa[e] || ('MeshCentral: ' + e);
}

// bruto: resolve com a resposta como veio (para comandos que nao respondem "ok", como addmeshuser)
function comando(cmd, bruto = false) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('Sem conexão com o MeshCentral.'));
    const responseid = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => { pendentes.delete(responseid); reject(new Error('MeshCentral não respondeu.')); }, 15000);
    pendentes.set(responseid, { resolve, reject, timer, bruto });
    ws.send(JSON.stringify({ ...cmd, responseid }));
  });
}

function listarUsuariosMesh() {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('Sem conexão com o MeshCentral.'));
    const tag = 'u' + crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => { pendentes.delete(tag); reject(new Error('MeshCentral não respondeu.')); }, 15000);
    pendentes.set(tag, { resolve, reject, timer });
    ws.send(JSON.stringify({ action: 'users', tag }));
  });
}

// ---- Usuarios limitados e permissoes por grupo -----------------------------
// Cada pessoa do painel tem um usuario proprio no MeshCentral ("painel-<login>"), sem senha
// conhecida e sem direitos de administracao do servidor. O painel e a fonte da verdade:
// cria/apaga esses usuarios e acerta os direitos de cada um em cada grupo. So mexe em contas
// com o prefixo "painel-"; as demais (como a conta pessoal do administrador) ficam intactas.

const PREFIXO = 'painel-';
const R = {
  MANAGECOMPUTERS: 4, REMOTECONTROL: 8, AGENTCONSOLE: 16, WAKEDEVICE: 64, SETNOTES: 128,
  UNINSTALL: 32768, REMOTECOMMAND: 131072, RESETOFF: 262144, DEVICEDETAILS: 1048576,
};
// Tecnico: tela, terminal e arquivos (inclusos em REMOTECONTROL) e detalhes da maquina.
const DIREITOS_TECNICO = R.REMOTECONTROL | R.DEVICEDETAILS;
// Administrador do painel: tudo sobre as maquinas, mas sem editar o grupo nem gerenciar usuarios dele.
const DIREITOS_ADMIN = R.MANAGECOMPUTERS | R.REMOTECONTROL | R.AGENTCONSOLE | R.WAKEDEVICE | R.SETNOTES |
  R.UNINSTALL | R.REMOTECOMMAND | R.RESETOFF | R.DEVICEDETAILS;
// Direitos no servidor: nao cria grupos, nao usa MeshCmd, nao altera a propria conta, nao adiciona dispositivos.
const DIREITOS_SITE = 64 | 128 | 1024 | 4096;

const nomeMeshDe = (login) => PREFIXO + String(login).toLowerCase().replace(/[^a-z0-9._-]/g, '-');

let sincronizando = false, pendenteDeNovo = false, timerSync = null;
function agendarSincronizacao() {
  clearTimeout(timerSync);
  timerSync = setTimeout(() => sincronizarPermissoes().catch((e) => { estado.erroPermissoes = e.message; }), 1500);
}

async function sincronizarPermissoes() {
  if (sincronizando) { pendenteDeNovo = true; return; }
  sincronizando = true;
  try {
    const usuariosMesh = new Map((await listarUsuariosMesh()).map((u) => [u._id, u]));
    const pessoas = db.prepare('SELECT id, nome, login, perfil, ativo, mesh_usuario FROM usuarios').all();
    const liberados = db.prepare('SELECT usuario_id, grupo_id FROM usuario_grupos').all();
    const gruposDe = new Map();
    for (const l of liberados) { if (!gruposDe.has(l.usuario_id)) gruposDe.set(l.usuario_id, new Set()); gruposDe.get(l.usuario_id).add(l.grupo_id); }

    const gravarNome = db.prepare('UPDATE usuarios SET mesh_usuario = ? WHERE id = ?');
    const desejado = new Map(); // meshUserId -> Map(grupoId -> direitos)
    let mudou = false;

    for (const p of pessoas) {
      const nome = nomeMeshDe(p.login);
      const id = 'user//' + nome;
      if (!p.ativo) {
        if (usuariosMesh.has(id)) { await comando({ action: 'deleteuser', userid: id }, true); mudou = true; }
        if (p.mesh_usuario) gravarNome.run(null, p.id);
        continue;
      }
      if (!usuariosMesh.has(id)) {
        await comando({ action: 'adduser', username: nome, pass: 'x', randomPassword: true, realname: p.nome, siteadmin: DIREITOS_SITE }, true);
        mudou = true;
      }
      if (p.mesh_usuario !== nome) gravarNome.run(nome, p.id);
      const mapa = new Map();
      for (const g of estado.grupos) {
        if (p.perfil === 'admin') mapa.set(g.id, DIREITOS_ADMIN);
        else if (gruposDe.get(p.id)?.has(g.id)) mapa.set(g.id, DIREITOS_TECNICO);
      }
      desejado.set(id, mapa);
    }

    // Acerta os direitos grupo a grupo, so para usuarios "painel-"
    for (const g of estado.grupos) {
      for (const [userId, mapa] of desejado) {
        const quer = mapa.get(g.id);
        const tem = g.links[userId]?.rights;
        if (quer != null && tem !== quer) {
          await comando({ action: 'addmeshuser', meshid: g.id, userids: [userId], meshadmin: quer }, true); mudou = true;
        }
      }
      for (const userId of Object.keys(g.links)) {
        if (!userId.startsWith('user//' + PREFIXO)) continue;
        if (!desejado.get(userId)?.has(g.id)) {
          await comando({ action: 'addmeshuser', meshid: g.id, userids: [userId], remove: true }, true); mudou = true;
        }
      }
    }
    estado.erroPermissoes = null;
    if (mudou) pedirAtualizacao();
  } finally {
    sincronizando = false;
    if (pendenteDeNovo) { pendenteDeNovo = false; agendarSincronizacao(); }
  }
}

async function criarGrupo(nome, descricao) {
  const r = await comando({ action: 'createmesh', meshname: nome, meshtype: 2, desc: descricao || '' });
  pedirAtualizacao();
  return r.meshid;
}

async function editarGrupo(id, nome, descricao) {
  await comando({ action: 'editmesh', meshid: id, meshname: nome, desc: descricao || '' });
  pedirAtualizacao();
}

// Excluir um grupo no MeshCentral remove tambem as maquinas dele, por isso so permitimos grupo vazio.
async function excluirGrupo(id) {
  const n = db.prepare('SELECT COUNT(*) n FROM maquinas WHERE mesh_grupo_id = ? AND removida_mesh = 0').get(id).n;
  if (n > 0) throw new Error('O grupo ainda tem ' + n + ' máquina(s). Mova-as para outro grupo antes de excluir.');
  await comando({ action: 'deletemesh', meshid: id });
  pedirAtualizacao();
}

async function moverMaquinas(nodeIds, grupoId) {
  const falhas = [];
  for (const id of nodeIds) {
    try { await comando({ action: 'changeDeviceMesh', nodeids: [id], meshid: grupoId }); }
    catch (e) { if (!/já está nesse grupo/.test(e.message)) falhas.push(e.message); }
  }
  pedirAtualizacao();
  if (falhas.length) throw new Error(falhas.length + ' máquina(s) não foram movidas: ' + falhas[0]);
}

// "Pedir permissao ao usuario" por maquina (node.consent no MeshCentral, somado as regras do
// servidor e do grupo): 0x08 tela, 0x10 terminal, 0x20 arquivos. A barra de aviso (0x40) ja vem do servidor.
const CONSENTIMENTO = 0x08 | 0x10 | 0x20;

async function definirPedirPermissao(nodeIds, pedir) {
  const falhas = [];
  for (const id of nodeIds) {
    try { await comando({ action: 'changedevice', nodeid: id, consent: pedir ? CONSENTIMENTO : 0 }); }
    catch (e) { falhas.push(e.message); }
  }
  pedirAtualizacao();
  if (falhas.length) throw new Error(falhas.length + ' máquina(s) não foram alteradas: ' + falhas[0]);
}

// Apaga o registro da maquina no MeshCentral. So faz sentido offline: com o agente
// ainda instalado e conectado, ele reconecta e se cadastra de novo.
async function excluirMaquina(nodeId) {
  await comando({ action: 'removedevices', nodeids: [nodeId] });
  pedirAtualizacao();
}

// Instalador do agente ja vinculado ao grupo (o MeshCentral embute a configuracao no .exe).
function baixarInstalador(grupoId, res) {
  const meshPart = grupoId.split('/')[2];
  const url = config.mesh.url.replace(/\/$/, '') + '/meshagents?id=4&meshid=' + encodeURIComponent(meshPart) + '&installflags=0' + chaveUrl;
  https.get(url, tlsOpts, (r) => {
    if (r.statusCode !== 200) { res.status(502).json({ erro: 'MeshCentral respondeu ' + r.statusCode }); r.resume(); return; }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', r.headers['content-disposition'] || 'attachment; filename="AcessoRemoto-Agente.exe"');
    r.pipe(res);
  }).on('error', (e) => res.status(502).json({ erro: e.message }));
}

module.exports = {
  conectar, estado, linkDeAcesso, baixarInstalador, pedirAtualizacao,
  criarGrupo, editarGrupo, excluirGrupo, moverMaquinas, excluirMaquina, definirPedirPermissao,
  sincronizarPermissoes, agendarSincronizacao, nomeMeshDe,
};
