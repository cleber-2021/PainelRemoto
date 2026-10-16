const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const totp = require('./totp');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const mesh = require('./mesh');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const txt = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '') || null;

// ---- Sessao ----------------------------------------------------------------

app.get('/api/estado', (req, res) => {
  const temUsuarios = db.prepare('SELECT COUNT(*) n FROM usuarios').get().n > 0;
  res.json({ precisaConfigurar: !temUsuarios, usuario: auth.usuarioDaSessao(req), confiarDias: auth.DIAS_CONFIAR });
});

// Primeiro acesso: cria o administrador inicial (so funciona enquanto nao houver usuarios).
app.post('/api/configurar', (req, res) => {
  if (db.prepare('SELECT COUNT(*) n FROM usuarios').get().n > 0) return res.status(409).json({ erro: 'Painel ja configurado.' });
  const nome = txt(req.body.nome), login = txt(req.body.login, 60), senha = req.body.senha;
  if (!nome || !login || typeof senha !== 'string' || senha.length < 8) return res.status(400).json({ erro: 'Preencha nome, login e uma senha de pelo menos 8 caracteres.' });
  const r = db.prepare("INSERT INTO usuarios (nome, login, senha_hash, perfil) VALUES (?, ?, ?, 'admin')").run(nome, login, auth.hashSenha(senha));
  auth.criarSessao(res, r.lastInsertRowid);
  res.json({ ok: true });
});

// Login em duas etapas: 1) login e senha; 2) codigo do app autenticador.
// Quem ainda nao configurou o app (e config.exigir2fa nao e false) cadastra no proprio login.
// Entre as etapas vale um "desafio" de 5 minutos, guardado so na memoria.
const desafios = new Map();
const ultimoPasso = new Map(); // usuario -> ultimo passo TOTP aceito (impede reusar o mesmo codigo)
const exigir2fa = config.exigir2fa !== false;

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (auth.bloqueado(ip)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  const u = db.prepare('SELECT * FROM usuarios WHERE login = ? AND ativo = 1').get(txt(req.body.login, 60) || '');
  if (!u || typeof req.body.senha !== 'string' || !auth.confereSenha(req.body.senha, u.senha_hash)) {
    auth.registrarFalha(ip);
    return res.status(401).json({ erro: 'Login ou senha incorretos.' });
  }
  if (!u.totp_ativo && !exigir2fa) { auth.criarSessao(res, u.id); return res.json({ ok: true }); }
  // Computador marcado como confiavel por esta pessoa: senha basta (o codigo ja foi conferido nele antes).
  if (u.totp_ativo && auth.dispositivoConfiavel(req, u.id)) { auth.criarSessao(res, u.id); return res.json({ ok: true }); }

  for (const [k, d] of desafios) if (d.expira < Date.now()) desafios.delete(k);
  const desafio = crypto.randomBytes(24).toString('hex');
  if (u.totp_ativo) {
    desafios.set(desafio, { usuarioId: u.id, tipo: 'verificar', expira: Date.now() + 5 * 60_000, tentativas: 0 });
    return res.json({ etapa: 'codigo', desafio });
  }
  const segredo = totp.gerarSegredo();
  desafios.set(desafio, { usuarioId: u.id, tipo: 'cadastrar', segredo, expira: Date.now() + 10 * 60_000, tentativas: 0 });
  res.json({ etapa: 'cadastrar', desafio, segredo, qr: totp.qrSvg(u.login, segredo) });
});

app.post('/api/login/codigo', (req, res) => {
  const ip = req.ip;
  if (auth.bloqueado(ip)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  const d = desafios.get(String(req.body.desafio || ''));
  if (!d || d.expira < Date.now()) return res.status(401).json({ erro: 'Tempo esgotado. Entre novamente.', reiniciar: true });
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND ativo = 1').get(d.usuarioId);
  if (!u) return res.status(401).json({ erro: 'Usuário inativo.', reiniciar: true });

  const segredo = d.tipo === 'cadastrar' ? d.segredo : u.totp_segredo;
  const passo = totp.verificar(segredo, req.body.codigo);
  if (passo == null || passo <= (ultimoPasso.get(u.id) || 0)) {
    auth.registrarFalha(ip);
    if (++d.tentativas >= 5) { desafios.delete(req.body.desafio); return res.status(401).json({ erro: 'Código incorreto várias vezes. Entre novamente.', reiniciar: true }); }
    return res.status(401).json({ erro: 'Código incorreto. Confira o código atual no aplicativo.' });
  }
  ultimoPasso.set(u.id, passo);
  desafios.delete(req.body.desafio);
  if (d.tipo === 'cadastrar') db.prepare('UPDATE usuarios SET totp_segredo = ?, totp_ativo = 1 WHERE id = ?').run(d.segredo, u.id);
  if (req.body.confiar === true) auth.confiarDispositivo(req, res, u.id);
  auth.criarSessao(res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { auth.encerrarSessao(req, res); res.json({ ok: true }); });

// Daqui pra baixo, tudo exige login.
app.use('/api', auth.exigeLogin);

// Grupos liberados: null = todos (administrador); Set = so os marcados para o tecnico.
function gruposPermitidos(usuario) {
  if (usuario.perfil === 'admin') return null;
  return new Set(db.prepare('SELECT grupo_id FROM usuario_grupos WHERE usuario_id = ?').all(usuario.id).map((r) => r.grupo_id));
}
const podeVer = (permitidos, grupoId) => permitidos == null || permitidos.has(grupoId);

// ---- Maquinas --------------------------------------------------------------

app.get('/api/maquinas', (req, res) => {
  const permitidos = gruposPermitidos(req.usuario);
  const maquinas = db.prepare(`
    SELECT * FROM maquinas
    ORDER BY removida_mesh, online DESC, COALESCE(cliente, 'zzz'), COALESCE(apelido, mesh_nome)
  `).all().filter((m) => podeVer(permitidos, m.mesh_grupo_id));
  res.json({
    maquinas,
    mesh: { conectado: mesh.estado.conectado, ultimaSync: mesh.estado.ultimaSync, erro: mesh.estado.erro },
  });
});

// "Pedir permissao ao usuario antes de acessar" em uma ou varias maquinas (so administrador).
// A regra vale no MeshCentral; aqui atualizamos a copia local e registramos no historico.
async function aplicarPedirPermissao(req, ids, pedir) {
  const alvos = ids.map((id) => db.prepare('SELECT node_id, apelido, mesh_nome, pedir_permissao, removida_mesh FROM maquinas WHERE node_id = ?').get(id))
    .filter((m) => m && !m.removida_mesh && !!m.pedir_permissao !== pedir);
  if (!alvos.length) return 0;
  await mesh.definirPedirPermissao(alvos.map((m) => m.node_id), pedir);
  const upd = db.prepare('UPDATE maquinas SET pedir_permissao = ? WHERE node_id = ?');
  const hist = db.prepare('INSERT INTO acessos (usuario_id, node_id, maquina_nome, modo, ip_origem) VALUES (?, ?, ?, ?, ?)');
  for (const m of alvos) {
    upd.run(pedir ? 1 : 0, m.node_id);
    hist.run(req.usuario.id, m.node_id, m.apelido || m.mesh_nome, pedir ? 'permissao-on' : 'permissao-off', req.ip);
  }
  return alvos.length;
}

app.post('/api/maquinas/permissao', auth.exigeAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ erro: 'Nenhuma máquina selecionada.' });
  try { res.json({ alteradas: await aplicarPedirPermissao(req, ids, req.body.pedir === true) }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});

app.put('/api/maquinas/:id', auth.exigeAdmin, async (req, res, next) => {
  if (typeof req.body.pedirPermissao === 'boolean') {
    try { await aplicarPedirPermissao(req, [req.params.id], req.body.pedirPermissao); }
    catch (e) { return res.status(502).json({ erro: e.message }); }
  }
  next();
});

app.put('/api/maquinas/:id', auth.exigeAdmin, (req, res) => {
  const b = req.body;
  const r = db.prepare(`
    UPDATE maquinas SET apelido = ?, cliente = ?, local = ?, setor = ?, responsavel = ?, patrimonio = ?, observacao = ?,
      atualizado_em = datetime('now')
    WHERE node_id = ?
  `).run(txt(b.apelido), txt(b.cliente), txt(b.local), txt(b.setor), txt(b.responsavel), txt(b.patrimonio), txt(b.observacao, 2000), req.params.id);
  if (!r.changes) return res.status(404).json({ erro: 'Maquina nao encontrada.' });
  res.json({ ok: true });
});

// Exclui a maquina do MeshCentral e do painel. Apenas offline: online, o agente se recadastraria.
// O historico de acessos e mantido e a exclusao fica registrada nele.
async function excluirUma(req, m) {
  if (!m.removida_mesh) await mesh.excluirMaquina(m.node_id);
  db.prepare('DELETE FROM maquinas WHERE node_id = ?').run(m.node_id);
  db.prepare("INSERT INTO acessos (usuario_id, node_id, maquina_nome, modo, ip_origem) VALUES (?, ?, ?, 'exclusao', ?)")
    .run(req.usuario.id, m.node_id, m.apelido || m.mesh_nome, req.ip);
}

app.delete('/api/maquinas/:id', auth.exigeAdmin, async (req, res) => {
  const m = db.prepare('SELECT * FROM maquinas WHERE node_id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ erro: 'Máquina não encontrada.' });
  if (m.online) return res.status(400).json({ erro: 'A máquina está online. Desinstale o agente nela antes de excluir.' });
  try { await excluirUma(req, m); } catch (e) { return res.status(502).json({ erro: e.message }); }
  res.json({ ok: true });
});

// Exclusao em lote: so as offline (as online sao ignoradas e informadas)
app.post('/api/maquinas/excluir', auth.exigeAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ erro: 'Nenhuma máquina selecionada.' });
  let excluidas = 0, online = 0; const falhas = [];
  for (const id of ids) {
    const m = db.prepare('SELECT * FROM maquinas WHERE node_id = ?').get(id);
    if (!m) continue;
    if (m.online) { online++; continue; }
    try { await excluirUma(req, m); excluidas++; } catch (e) { falhas.push(e.message); }
  }
  res.json({ excluidas, online, falhas: falhas.length, erro: falhas[0] });
});

app.post('/api/maquinas/:id/acessar', (req, res) => {
  const m = db.prepare('SELECT * FROM maquinas WHERE node_id = ?').get(req.params.id);
  if (!m || !podeVer(gruposPermitidos(req.usuario), m.mesh_grupo_id)) return res.status(404).json({ erro: 'Maquina nao encontrada.' });
  const meshUsuario = db.prepare('SELECT mesh_usuario FROM usuarios WHERE id = ?').get(req.usuario.id).mesh_usuario;
  if (!meshUsuario) {
    mesh.agendarSincronizacao();
    return res.status(503).json({ erro: 'Seu acesso ainda está sendo preparado no MeshCentral. Tente de novo em alguns segundos.' });
  }
  const modo = ['desktop', 'terminal', 'arquivos'].includes(req.body.modo) ? req.body.modo : 'desktop';
  const url = mesh.linkDeAcesso(m.node_id, modo, meshUsuario);
  db.prepare('INSERT INTO acessos (usuario_id, node_id, maquina_nome, modo, ip_origem) VALUES (?, ?, ?, ?, ?)')
    .run(req.usuario.id, m.node_id, m.apelido || m.mesh_nome, modo, req.ip);
  res.json({ url });
});

// ---- Grupos e instalador ---------------------------------------------------

// Grupos vem do MeshCentral (sao eles que definem o instalador); as contagens vem do banco local.
app.get('/api/grupos', (req, res) => {
  const cont = Object.fromEntries(db.prepare(`
    SELECT mesh_grupo_id id, COUNT(*) total, SUM(online) online FROM maquinas WHERE removida_mesh = 0 GROUP BY mesh_grupo_id
  `).all().map((r) => [r.id, r]));
  const permitidos = gruposPermitidos(req.usuario);
  res.json({
    grupos: mesh.estado.grupos
      .filter((g) => podeVer(permitidos, g.id))
      .map(({ links, ...g }) => ({ ...g, total: cont[g.id]?.total || 0, online: cont[g.id]?.online || 0 })),
  });
});

const grupoExiste = (id) => mesh.estado.grupos.some((g) => g.id === id);

app.post('/api/grupos', auth.exigeAdmin, async (req, res) => {
  const nome = txt(req.body.nome, 128);
  if (!nome) return res.status(400).json({ erro: 'Informe o nome do grupo.' });
  if (mesh.estado.grupos.some((g) => g.nome.toLowerCase() === nome.toLowerCase())) return res.status(409).json({ erro: 'Já existe um grupo com esse nome.' });
  try { res.json({ id: await mesh.criarGrupo(nome, txt(req.body.descricao, 1000)) }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});

app.put('/api/grupos', auth.exigeAdmin, async (req, res) => {
  const nome = txt(req.body.nome, 128);
  if (!grupoExiste(req.body.id)) return res.status(404).json({ erro: 'Grupo não encontrado.' });
  if (!nome) return res.status(400).json({ erro: 'Informe o nome do grupo.' });
  try { await mesh.editarGrupo(req.body.id, nome, txt(req.body.descricao, 1000)); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});

app.delete('/api/grupos', auth.exigeAdmin, async (req, res) => {
  if (!grupoExiste(req.body.id)) return res.status(404).json({ erro: 'Grupo não encontrado.' });
  try { await mesh.excluirGrupo(req.body.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

app.post('/api/maquinas/mover', auth.exigeAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ erro: 'Nenhuma máquina selecionada.' });
  if (!grupoExiste(req.body.grupoId)) return res.status(404).json({ erro: 'Grupo não encontrado.' });
  try { await mesh.moverMaquinas(ids, req.body.grupoId); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ erro: e.message }); }
});

// Instalador do grupo: administrador baixa de qualquer grupo; tecnico, so dos grupos liberados para ele.
// Cada download fica no historico.
app.get('/api/grupos/instalador', (req, res) => {
  const grupo = mesh.estado.grupos.find((g) => g.id === req.query.id);
  if (!grupo || !podeVer(gruposPermitidos(req.usuario), grupo.id)) return res.status(404).json({ erro: 'Grupo nao encontrado.' });
  db.prepare("INSERT INTO acessos (usuario_id, node_id, maquina_nome, modo, ip_origem) VALUES (?, ?, ?, 'instalador', ?)")
    .run(req.usuario.id, grupo.id, 'Grupo: ' + grupo.nome, req.ip);
  mesh.baixarInstalador(grupo.id, res);
});

// ---- Historico -------------------------------------------------------------

// Historico com filtros e paginacao no servidor.
// Filtros (query): usuario (id), maquina (parte do nome), modo, de/ate (AAAA-MM-DD, horario local do servidor).
// formato=csv exporta o resultado filtrado (ate 20 mil linhas).
const MODOS_HIST = ['desktop', 'terminal', 'arquivos', 'exclusao', 'permissao-on', 'permissao-off', 'instalador'];
const dataValida = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

app.get('/api/acessos', auth.exigeAdmin, (req, res) => {
  const q = req.query;
  const onde = [], args = [];
  if (/^\d+$/.test(q.usuario || '')) { onde.push('a.usuario_id = ?'); args.push(Number(q.usuario)); }
  if (typeof q.maquina === 'string' && q.maquina.trim()) { onde.push("a.maquina_nome LIKE ? ESCAPE '\\'"); args.push('%' + q.maquina.trim().slice(0, 100).replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }
  if (q.modo === 'permissao') onde.push("a.modo IN ('permissao-on', 'permissao-off')");
  else if (MODOS_HIST.includes(q.modo)) { onde.push('a.modo = ?'); args.push(q.modo); }
  // criado_em e gravado em UTC; as datas do filtro sao do dia local
  if (dataValida(q.de)) { onde.push("a.criado_em >= datetime(? || ' 00:00:00', 'utc')"); args.push(q.de); }
  if (dataValida(q.ate)) { onde.push("a.criado_em < datetime(? || ' 00:00:00', '+1 day', 'utc')"); args.push(q.ate); }
  const where = onde.length ? 'WHERE ' + onde.join(' AND ') : '';
  const base = `FROM acessos a JOIN usuarios u ON u.id = a.usuario_id ${where}`;

  if (q.formato === 'csv') {
    const linhas = db.prepare(`SELECT datetime(a.criado_em, 'localtime') quando, u.nome usuario, a.maquina_nome, a.modo, a.ip_origem ${base} ORDER BY a.criado_em DESC, a.id DESC LIMIT 20000`).all(...args);
    const nomeModo = { desktop: 'Tela remota', terminal: 'Terminal', arquivos: 'Arquivos', exclusao: 'Máquina excluída', 'permissao-on': 'Passou a pedir permissão', 'permissao-off': 'Voltou ao acesso direto', instalador: 'Baixou instalador' };
    const cel = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const csv = ['Data/hora;Usuário;Máquina;Ação;IP de origem']
      .concat(linhas.map((l) => [l.quando, l.usuario, l.maquina_nome, nomeModo[l.modo] || l.modo, l.ip_origem].map(cel).join(';'))).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="historico-acesso-remoto-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send('﻿' + csv); // BOM: o Excel abre com acentos corretos
  }

  const porPagina = Math.min(Math.max(parseInt(q.porPagina, 10) || 50, 10), 200);
  const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...args).n;
  const paginas = Math.max(1, Math.ceil(total / porPagina));
  const pagina = Math.min(Math.max(parseInt(q.pagina, 10) || 1, 1), paginas);
  res.json({
    total, pagina, paginas, porPagina,
    acessos: db.prepare(`SELECT a.*, u.nome AS usuario_nome ${base} ORDER BY a.criado_em DESC, a.id DESC LIMIT ? OFFSET ?`).all(...args, porPagina, (pagina - 1) * porPagina),
    // quem ja tem registro (para o filtro de usuario)
    usuarios: db.prepare('SELECT DISTINCT u.id, u.nome FROM acessos a JOIN usuarios u ON u.id = a.usuario_id ORDER BY u.nome').all(),
  });
});

// ---- Usuarios do painel ----------------------------------------------------

app.get('/api/usuarios', auth.exigeAdmin, (req, res) => {
  const usuarios = db.prepare('SELECT id, nome, login, perfil, ativo, criado_em, totp_ativo, mesh_usuario FROM usuarios ORDER BY nome').all();
  const grupos = db.prepare('SELECT usuario_id, grupo_id FROM usuario_grupos').all();
  const confiaveis = Object.fromEntries(db.prepare('SELECT usuario_id, COUNT(*) n FROM dispositivos_confiaveis WHERE expira_em > ? GROUP BY usuario_id').all(Date.now()).map((r) => [r.usuario_id, r.n]));
  for (const u of usuarios) {
    u.grupos = grupos.filter((g) => g.usuario_id === u.id).map((g) => g.grupo_id);
    u.computadores_confiaveis = confiaveis[u.id] || 0;
  }
  res.json({ usuarios });
});

// Grava os grupos liberados para um tecnico (so ids de grupos que existem no MeshCentral).
function gravarGrupos(usuarioId, grupos) {
  const validos = new Set(mesh.estado.grupos.map((g) => g.id));
  const lista = Array.isArray(grupos) ? [...new Set(grupos.filter((g) => validos.has(g)))] : [];
  db.prepare('DELETE FROM usuario_grupos WHERE usuario_id = ?').run(usuarioId);
  const ins = db.prepare('INSERT INTO usuario_grupos (usuario_id, grupo_id) VALUES (?, ?)');
  for (const g of lista) ins.run(usuarioId, g);
}

// Login: letras, numeros, ponto, hifen e sublinhado (vira o usuario "painel-<login>" no MeshCentral).
const loginValido = (l) => /^[A-Za-z0-9._-]{2,60}$/.test(l || '');

app.post('/api/usuarios', auth.exigeAdmin, (req, res) => {
  const nome = txt(req.body.nome), login = txt(req.body.login, 60), senha = req.body.senha;
  const perfil = req.body.perfil === 'admin' ? 'admin' : 'tecnico';
  if (!nome || !login || typeof senha !== 'string' || senha.length < 8) return res.status(400).json({ erro: 'Preencha nome, login e uma senha de pelo menos 8 caracteres.' });
  if (!loginValido(login)) return res.status(400).json({ erro: 'O login aceita só letras, números, ponto, hífen e sublinhado, sem espaços.' });
  try {
    const r = db.prepare('INSERT INTO usuarios (nome, login, senha_hash, perfil) VALUES (?, ?, ?, ?)').run(nome, login, auth.hashSenha(senha), perfil);
    if (perfil === 'tecnico') gravarGrupos(r.lastInsertRowid, req.body.grupos);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ erro: 'Ja existe um usuario com esse login.' });
    throw e;
  }
  mesh.agendarSincronizacao();
  res.json({ ok: true });
});

app.put('/api/usuarios/:id', auth.exigeAdmin, (req, res) => {
  const id = Number(req.params.id);
  const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!alvo) return res.status(404).json({ erro: 'Usuario nao encontrado.' });
  const perfil = req.body.perfil === 'admin' ? 'admin' : 'tecnico';
  const ativo = req.body.ativo ? 1 : 0;
  if (id === req.usuario.id && (perfil !== 'admin' || !ativo)) return res.status(400).json({ erro: 'Voce nao pode remover o proprio acesso de administrador.' });
  if (req.body.redefinir2fa === true && id === req.usuario.id) return res.status(400).json({ erro: 'Peça a outro administrador para redefinir a sua verificação em duas etapas.' });
  const novaSenha = typeof req.body.senha === 'string' ? req.body.senha : '';
  if (novaSenha && novaSenha.length < 8) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
  db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ? WHERE id = ?').run(txt(req.body.nome) || alvo.nome, perfil, ativo, id);
  if (novaSenha) {
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(auth.hashSenha(novaSenha), id);
  }
  // Troca de senha, redefinicao do app, desativacao ou pedido explicito: computadores confiaveis deixam de valer.
  if (novaSenha || req.body.redefinir2fa === true || !ativo || req.body.esquecerComputadores === true) auth.esquecerDispositivos(id);
  if (perfil === 'tecnico') gravarGrupos(id, req.body.grupos);
  else db.prepare('DELETE FROM usuario_grupos WHERE usuario_id = ?').run(id);
  // Redefinir a verificacao em duas etapas: no proximo login a pessoa cadastra o app de novo.
  if (req.body.redefinir2fa === true) {
    db.prepare('UPDATE usuarios SET totp_segredo = NULL, totp_ativo = 0 WHERE id = ?').run(id);
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
  }
  if (!ativo) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
  mesh.agendarSincronizacao();
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno: ' + err.message });
});

mesh.conectar();
require('./backup').iniciarBackups();
require('./ad').iniciar();

if (config.https) {
  // HTTPS com o certificado do servidor (ex.: C:\certs). Quando o certificado e renovado,
  // o arquivo muda e o painel passa a usar o novo sem precisar reiniciar.
  const fs = require('node:fs');
  const https = require('node:https');
  const ler = () => ({ cert: fs.readFileSync(config.https.cert), key: fs.readFileSync(config.https.key) });
  const versao = () => fs.statSync(config.https.cert).mtimeMs + ':' + fs.statSync(config.https.key).mtimeMs;
  let atual = versao();
  const servidor = https.createServer(ler(), app);
  setInterval(() => {
    try {
      const v = versao();
      if (v !== atual) { servidor.setSecureContext(ler()); atual = v; console.log('Certificado HTTPS recarregado.'); }
    } catch (e) { console.error('Falha ao recarregar certificado:', e.message); }
  }, 60 * 60 * 1000);
  servidor.listen(config.porta, config.host, () => console.log(`${config.nome} (HTTPS) na porta ${config.porta}`));
} else {
  app.listen(config.porta, config.host, () => {
    console.log(`${config.nome} em http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.porta}`);
  });
}
