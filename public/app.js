const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const POR_PAGINA = 100;

let usuario = null;
let maquinas = [];
let grupos = [];
let modoConfigurar = false;
const selecionadas = new Set();

// Estado da lista (filtro lateral, ordenacao, pagina) lembrado entre visitas.
const lista = carregarPreferencias();
function carregarPreferencias() {
  const padrao = { filtro: 'todas', grupo: null, ordem: 'online', dir: 'desc', pagina: 1 };
  try { return { ...padrao, ...JSON.parse(localStorage.getItem('painel.lista') || '{}'), pagina: 1 }; } catch { return padrao; }
}
function salvarPreferencias() {
  try { localStorage.setItem('painel.lista', JSON.stringify({ filtro: lista.filtro, grupo: lista.grupo, ordem: lista.ordem, dir: lista.dir })); } catch { /* sem storage */ }
}

// ---- Tema (automatico / claro / escuro) ------------------------------------
// O <head> ja aplica o tema salvo antes de desenhar; aqui so trocamos e lembramos.
const TEMAS = { auto: { prox: 'claro', icone: 'i-auto', nome: 'automático (segue o sistema)' },
  claro: { prox: 'escuro', icone: 'i-sol', nome: 'claro' }, escuro: { prox: 'auto', icone: 'i-lua', nome: 'escuro' } };
function temaAtual() { try { return localStorage.getItem('painel.tema') || 'auto'; } catch { return 'auto'; } }
function aplicarTema(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-tema');
  else document.documentElement.setAttribute('data-tema', t);
  document.querySelectorAll('[data-tema-botao]').forEach((b) => {
    b.querySelector('use').setAttribute('href', '#' + TEMAS[t].icone);
    b.title = `Tema: ${TEMAS[t].nome}. Clique para trocar.`;
  });
}
document.querySelectorAll('[data-tema-botao]').forEach((b) => b.addEventListener('click', () => {
  const t = TEMAS[temaAtual()].prox;
  try { localStorage.setItem('painel.tema', t); } catch { /* sem storage: vale so nesta pagina */ }
  aplicarTema(t);
}));
aplicarTema(temaAtual());

const iniciais = (nome) => String(nome || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

async function api(metodo, url, corpo) {
  const r = await fetch(url, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') { mostrarEntrada(); throw new Error(dados.erro || 'Sessão expirada'); }
  if (r.status === 403 && dados.trocarSenha) abrirMinhaSenha(true);
  if (!r.ok) throw new Error(dados.erro || 'Erro ' + r.status);
  return dados;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

const paraData = (iso) => (iso ? new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z') : null);
function dataBR(iso) {
  const d = paraData(iso);
  return d ? d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}
function haQuanto(iso) {
  const d = paraData(iso);
  if (!d) return 'nunca';
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 2) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const dias = Math.round(h / 24);
  return dias < 30 ? `há ${dias} dia${dias > 1 ? 's' : ''}` : d.toLocaleDateString('pt-BR');
}
// IP mostrado: o da placa de rede da maquina; sem ele, o da conexao. IP de internet da conexao aparece como "via".
const ipPrivado = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip || '');
const ipDe = (m) => m.ip_local || m.mesh_ip || '';
const ipVia = (m) => (m.mesh_ip && !ipPrivado(m.mesh_ip) && m.mesh_ip !== m.ip_local ? m.mesh_ip : '');
const osCurto = (os) => (os || '').replace(/^Microsoft\s+/, '').replace(/\s+-\s+.*$/, '');
const nomeDe = (m) => m.apelido || m.mesh_nome;
const semCadastro = (m) => !m.apelido && !m.cliente && !m.local && !m.setor && !m.responsavel;
const ehAdmin = () => usuario?.perfil === 'admin';
// "EMPRESA\\joao.silva" -> "joao.silva" (o dominio fica no title)
const usuarioCurto = (u) => (u || '').split(',').map((x) => x.trim().split('\\').pop()).filter(Boolean).join(', ');

// ---- Entrada ---------------------------------------------------------------

function mostrarEntrada() {
  $('#app').hidden = true;
  $('#tela-entrada').hidden = false;
  $('#campo-nome').hidden = !modoConfigurar;
  $('#form-entrada [name=nome]').required = modoConfigurar;
  $('#entrada-sub').textContent = modoConfigurar ? 'Primeiro acesso: crie o administrador do painel.' : 'Entre com seu usuário do painel.';
  $('#entrada-btn').textContent = modoConfigurar ? 'Criar administrador' : 'Entrar';
  $('#form-entrada [name=senha]').autocomplete = modoConfigurar ? 'new-password' : 'current-password';
}

$('#form-entrada').addEventListener('submit', async (e) => {
  e.preventDefault();
  const erro = $('#entrada-erro');
  erro.hidden = true;
  try {
    const r = await api('POST', modoConfigurar ? '/api/configurar' : '/api/login', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    if (r.etapa) return mostrarEtapaCodigo(r);
    await iniciar();
  } catch (err) {
    erro.textContent = err.message;
    erro.hidden = false;
  }
});

$('#btn-esqueci').addEventListener('click', () => { $('#texto-esqueci').hidden = !$('#texto-esqueci').hidden; });

// ---- Mostrar/ocultar senha -------------------------------------------------
// Todo campo de senha ganha um botao de olho. Ao enviar o formulario, volta a ficar oculto.
function prepararCamposSenha() {
  document.querySelectorAll('input[type=password]').forEach((input) => {
    if (input.parentElement.classList.contains('campo-senha')) return;
    const caixa = document.createElement('span');
    caixa.className = 'campo-senha';
    input.replaceWith(caixa);
    const botao = document.createElement('button');
    botao.type = 'button'; botao.className = 'icone ver-senha'; botao.tabIndex = -1;
    botao.innerHTML = '<svg><use href="#i-olho"/></svg>';
    const mostrar = (sim) => {
      input.type = sim ? 'text' : 'password';
      botao.querySelector('use').setAttribute('href', sim ? '#i-olho-fechado' : '#i-olho');
      botao.title = sim ? 'Ocultar senha' : 'Mostrar senha';
      botao.setAttribute('aria-label', botao.title);
    };
    botao.addEventListener('click', () => { mostrar(input.type === 'password'); input.focus(); });
    input.form?.addEventListener('submit', () => mostrar(false));
    input.form?.addEventListener('reset', () => mostrar(false));
    mostrar(false);
    caixa.append(input, botao);
  });
}
prepararCamposSenha();

// ---- Segunda etapa do login (codigo do aplicativo) --------------------------

let desafioAtual = null;
function mostrarEtapaCodigo(r) {
  desafioAtual = r.desafio;
  const cadastrar = r.etapa === 'cadastrar';
  $('#form-entrada').hidden = true;
  $('#form-codigo').hidden = false;
  $('#cadastro-2fa').hidden = !cadastrar;
  $('#instrucao-codigo').hidden = cadastrar;
  if (cadastrar) {
    $('#qr-2fa').innerHTML = r.qr; // SVG gerado pelo servidor
    $('#segredo-2fa').textContent = r.segredo.replace(/(.{4})/g, '$1 ').trim();
  }
  $('#codigo-erro').hidden = true;
  $('#form-codigo').elements.codigo.value = '';
  $('#form-codigo').elements.codigo.focus();
}

function voltarAoLogin() {
  desafioAtual = null;
  $('#form-codigo').hidden = true;
  $('#form-entrada').hidden = false;
  $('#qr-2fa').innerHTML = '';
}
$('#btn-voltar-login').addEventListener('click', voltarAoLogin);

$('#form-codigo').addEventListener('submit', async (e) => {
  e.preventDefault();
  const erro = $('#codigo-erro');
  erro.hidden = true;
  const r = await fetch('/api/login/codigo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desafio: desafioAtual, codigo: e.target.elements.codigo.value, confiar: e.target.elements.confiar.checked }),
  });
  const dados = await r.json().catch(() => ({}));
  if (r.ok) { voltarAoLogin(); return iniciar(); }
  if (dados.reiniciar) { voltarAoLogin(); $('#entrada-erro').textContent = dados.erro; $('#entrada-erro').hidden = false; return; }
  erro.textContent = dados.erro || 'Erro ' + r.status;
  erro.hidden = false;
  e.target.elements.codigo.select();
});

$('#btn-sair').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  usuario = null;
  mostrarEntrada();
});

// ---- Minha senha -----------------------------------------------------------
// obrigatoria = senha temporaria definida por um administrador: nao da para fechar sem trocar.
let senhaObrigatoria = false;
function abrirMinhaSenha(obrigatoria) {
  senhaObrigatoria = !!obrigatoria;
  const m = $('#modal-senha');
  if (m.open) return;
  $('#form-senha').reset();
  $('#senha-titulo').textContent = senhaObrigatoria ? 'Crie a sua senha' : 'Alterar minha senha';
  $('#senha-sub').hidden = !senhaObrigatoria;
  $('#rotulo-senha-atual').textContent = senhaObrigatoria ? 'Senha temporária' : 'Senha atual';
  $('#btn-senha-cancelar').hidden = senhaObrigatoria;
  $('#btn-senha-sair').hidden = !senhaObrigatoria;
  $('#senha-erro').hidden = true;
  m.showModal();
}
$('#btn-minha-senha').addEventListener('click', () => abrirMinhaSenha(false));
$('#btn-senha-sair').addEventListener('click', () => { senhaObrigatoria = false; $('#modal-senha').close(); $('#btn-sair').click(); });
$('#modal-senha').addEventListener('cancel', (e) => { if (senhaObrigatoria) e.preventDefault(); }); // Esc nao fecha

$('#form-senha').addEventListener('submit', async (e) => {
  if (e.submitter?.value === 'cancelar') return;
  e.preventDefault();
  const f = e.target, erro = $('#senha-erro');
  erro.hidden = true;
  if (f.elements.nova.value !== f.elements.repetir.value) { erro.textContent = 'As duas senhas novas não são iguais.'; erro.hidden = false; return; }
  try {
    await api('POST', '/api/minha-senha', { atual: f.elements.atual.value, nova: f.elements.nova.value });
    const eraObrigatoria = senhaObrigatoria;
    senhaObrigatoria = false;
    $('#modal-senha').close();
    toast('Senha alterada.');
    if (eraObrigatoria) iniciar();
  } catch (err) {
    erro.textContent = err.message;
    erro.hidden = false;
  }
});

// ---- Abas ------------------------------------------------------------------

function abrirAba(nome) {
  document.querySelectorAll('#abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === nome));
  document.querySelectorAll('[data-pagina]').forEach((p) => (p.hidden = p.dataset.pagina !== nome));
  if (nome === 'historico') carregarAcessos();
  if (nome === 'usuarios') carregarUsuarios();
}
$('#abas').addEventListener('click', (e) => { if (e.target.dataset.aba) abrirAba(e.target.dataset.aba); });

// ---- Carga de dados --------------------------------------------------------

async function carregarMaquinas() {
  try {
    const [dm, dg] = await Promise.all([api('GET', '/api/maquinas'), api('GET', '/api/grupos')]);
    maquinas = dm.maquinas;
    grupos = dg.grupos;
    const aviso = $('#aviso-mesh');
    aviso.textContent = dm.mesh.erro || 'Conectando ao MeshCentral…';
    aviso.hidden = dm.mesh.conectado && !dm.mesh.erro;
    // Descarta selecao de maquinas que sumiram
    for (const id of [...selecionadas]) if (!maquinas.some((m) => m.node_id === id)) selecionadas.delete(id);
    if (lista.grupo && !grupos.some((g) => g.id === lista.grupo)) { lista.grupo = null; lista.filtro = 'todas'; }
    renderTudo();
  } catch (e) { /* 401 ja tratado */ }
}

function renderTudo() {
  renderLateral();
  atualizarListasAuxiliares();
  renderMaquinas();
}

// ---- Barra lateral ---------------------------------------------------------

function renderLateral() {
  const online = maquinas.filter((m) => m.online).length;
  $('#c-todas').textContent = maquinas.length;
  $('#c-online').textContent = online;
  $('#c-offline').textContent = maquinas.length - online;
  const novas = maquinas.filter(semCadastro).length;
  $('#c-semcadastro').textContent = novas || '';
  const fora = maquinas.filter((m) => m.fora_dominio).length;
  $('#c-foradominio').textContent = fora || '';
  $('#f-foradominio').hidden = !fora && lista.filtro !== 'foradominio';

  document.querySelectorAll('#lat-filtros button').forEach((b) => b.classList.toggle('ativo', !lista.grupo && b.dataset.filtro === lista.filtro));

  $('#lat-grupos').innerHTML = grupos.length ? grupos.map((g) => `
    <li data-grupo="${esc(g.id)}" class="${lista.grupo === g.id ? 'ativo' : ''}" title="${esc(g.descricao || g.nome)}">
      <span class="g-nome">${esc(g.nome)}</span>
      <span class="cont">${g.online}/${g.total}</span>
      ${ehAdmin() ? '<button class="icone" data-menu-grupo title="Opções do grupo"><svg><use href="#i-mais"/></svg></button>' : ''}
    </li>`).join('')
    : '<li class="lat-vazio">Nenhum grupo ainda.</li>';
}

$('#lat-filtros').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filtro]');
  if (!b) return;
  if ($('#busca').value) { $('#busca').value = ''; buscaSoNoGrupo = false; }
  lista.filtro = b.dataset.filtro;
  lista.grupo = null;
  lista.pagina = 1;
  salvarPreferencias();
  renderTudo();
});

$('#lat-grupos').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-grupo]');
  if (!li) return;
  if (e.target.closest('[data-menu-grupo]')) return abrirMenuGrupo(li.dataset.grupo, e.target.closest('button'));
  if ($('#busca').value) { $('#busca').value = ''; buscaSoNoGrupo = false; }
  lista.grupo = li.dataset.grupo;
  lista.filtro = 'todas';
  lista.pagina = 1;
  salvarPreferencias();
  renderTudo();
});

// ---- Menu e cadastro de grupos ---------------------------------------------

let grupoDoMenu = null;
function abrirMenuGrupo(id, botao) {
  grupoDoMenu = grupos.find((g) => g.id === id);
  const menu = $('#menu-grupo');
  menu.hidden = false;
  const r = botao.getBoundingClientRect();
  menu.style.top = Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8) + 'px';
  menu.style.left = Math.min(r.left, innerWidth - menu.offsetWidth - 8) + 'px';
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#menu-grupo') && !e.target.closest('[data-menu-grupo]')) $('#menu-grupo').hidden = true;
});

const baixarInstalador = (id) => { window.location = '/api/grupos/instalador?id=' + encodeURIComponent(id); };

$('#menu-grupo').addEventListener('click', async (e) => {
  const acao = e.target.dataset.menu;
  if (!acao || !grupoDoMenu) return;
  $('#menu-grupo').hidden = true;
  const g = grupoDoMenu;
  if (acao === 'instalador') baixarInstalador(g.id);
  if (acao === 'editar') abrirGrupo(g);
  if (acao === 'excluir') {
    if (g.total > 0) return toast(`O grupo tem ${g.total} máquina(s). Mova-as para outro grupo antes de excluir.`);
    if (!confirm(`Excluir o grupo "${g.nome}"? O instalador dele deixa de funcionar.`)) return;
    try { await api('DELETE', '/api/grupos', { id: g.id }); toast('Grupo excluído.'); setTimeout(carregarMaquinas, 600); }
    catch (err) { toast(err.message); }
  }
});

let editandoGrupo = null;
function abrirGrupo(g) {
  editandoGrupo = g;
  const f = $('#form-grupo');
  f.reset();
  $('#grupo-titulo').textContent = g ? 'Renomear grupo' : 'Novo grupo';
  f.elements.nome.value = g?.nome || '';
  f.elements.descricao.value = g?.descricao || '';
  $('#grupo-erro').hidden = true;
  $('#modal-grupo').showModal();
}
$('#btn-novo-grupo').addEventListener('click', () => abrirGrupo(null));

$('#form-grupo').addEventListener('submit', async (e) => {
  if (e.submitter?.value === 'cancelar') return;
  e.preventDefault();
  const dados = { nome: e.target.elements.nome.value, descricao: e.target.elements.descricao.value };
  try {
    if (editandoGrupo) await api('PUT', '/api/grupos', { id: editandoGrupo.id, ...dados });
    else {
      const { id } = await api('POST', '/api/grupos', dados);
      lista.grupo = id; lista.filtro = 'todas'; salvarPreferencias();
    }
    $('#modal-grupo').close();
    toast(editandoGrupo ? 'Grupo atualizado.' : 'Grupo criado. Baixe o instalador dele no botão acima da lista.');
    setTimeout(carregarMaquinas, 600);
  } catch (err) {
    $('#grupo-erro').textContent = err.message;
    $('#grupo-erro').hidden = false;
  }
});

$('#btn-instalador').addEventListener('click', () => { if (lista.grupo) baixarInstalador(lista.grupo); });

// ---- Lista de maquinas -----------------------------------------------------

function atualizarListasAuxiliares() {
  const unicos = (campo) => [...new Set(maquinas.map((m) => m[campo]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const sel = $('#filtro-cliente');
  const atual = sel.value;
  const clientes = unicos('cliente');
  sel.innerHTML = '<option value="">Todos os clientes</option>' + clientes.map((v) => `<option>${esc(v)}</option>`).join('');
  sel.value = clientes.includes(atual) ? atual : '';
  for (const c of ['cliente', 'local', 'setor']) $('#sugestoes-' + c).innerHTML = unicos(c).map((v) => `<option value="${esc(v)}">`).join('');
  const opcoesGrupo = grupos.map((g) => `<option value="${esc(g.id)}">${esc(g.nome)}</option>`).join('');
  $('#massa-grupo').innerHTML = '<option value="">Mover para o grupo…</option>' + opcoesGrupo;
  $('#form-maquina').elements.grupo.innerHTML = opcoesGrupo;
}

// ---- Busca -----------------------------------------------------------------
// Por padrao a busca procura em TODAS as maquinas, ignorando o grupo/filtro da lateral.
// "Somente neste grupo" restringe ao que esta selecionado. Ignora acentos e maiusculas,
// e com varias palavras exige todas ("ufsm portaria").
const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let buscaSoNoGrupo = false;
const termosBusca = () => normalizar($('#busca').value).split(/\s+/).filter(Boolean);
const temSelecaoLateral = () => !!lista.grupo || lista.filtro !== 'todas';

function filtradas() {
  const termos = termosBusca();
  const restringir = !termos.length || buscaSoNoGrupo;
  const cliente = $('#filtro-cliente').value;
  return maquinas.filter((m) => {
    if (restringir) {
      if (lista.grupo && m.mesh_grupo_id !== lista.grupo) return false;
      if (lista.filtro === 'online' && !m.online) return false;
      if (lista.filtro === 'offline' && m.online) return false;
      if (lista.filtro === 'semcadastro' && !semCadastro(m)) return false;
      if (lista.filtro === 'foradominio' && !m.fora_dominio) return false;
    }
    if (cliente && m.cliente !== cliente) return false;
    if (!termos.length) return true;
    const texto = normalizar([m.apelido, m.mesh_nome, m.cliente, m.local, m.setor, m.responsavel, m.patrimonio, m.ip_local, m.mesh_ip, m.mac, m.usuario_logado, m.observacao, m.mesh_grupo_nome, osCurto(m.mesh_os), m.pedir_permissao ? 'pede permissao' : '', m.fora_dominio ? 'fora do dominio' : ''].filter(Boolean).join(' | '));
    return termos.every((t) => texto.includes(t));
  });
}

// Destaca os termos buscados no texto (sem acento/maiuscula), devolvendo HTML seguro.
function destacar(valor) {
  const original = String(valor ?? '');
  const termos = termosBusca();
  if (!original || !termos.length) return esc(original);
  let norm = '';
  const mapa = []; // indice no texto normalizado -> indice no original
  for (let i = 0; i < original.length; i++) {
    const n = normalizar(original[i]);
    for (let k = 0; k < n.length; k++) { norm += n[k]; mapa.push(i); }
  }
  const marcado = new Array(original.length).fill(false);
  for (const t of termos) {
    let p = norm.indexOf(t);
    while (p >= 0) { for (let k = p; k < p + t.length; k++) marcado[mapa[k]] = true; p = norm.indexOf(t, p + 1); }
  }
  let html = '', dentro = false;
  for (let i = 0; i < original.length; i++) {
    if (marcado[i] !== dentro) { html += marcado[i] ? '<mark>' : '</mark>'; dentro = marcado[i]; }
    html += esc(original[i]);
  }
  return html + (dentro ? '</mark>' : '');
}

function renderEscopoBusca() {
  const caixa = $('#escopo-busca');
  if (!termosBusca().length) { caixa.hidden = true; return; }
  const grupoAtual = grupos.find((g) => g.id === lista.grupo);
  const nomeSelecao = grupoAtual ? grupoAtual.nome : ({ online: 'Online', offline: 'Offline', semcadastro: 'Sem cadastro', foradominio: 'Fora do domínio' }[lista.filtro] || '');
  caixa.hidden = false;
  if (buscaSoNoGrupo && temSelecaoLateral()) {
    caixa.innerHTML = `Buscando só em <b>${esc(nomeSelecao)}</b> · <button type="button" data-escopo="todas">Buscar em todas as máquinas</button>`;
  } else {
    caixa.innerHTML = 'Buscando em <b>todas as máquinas</b>' +
      (temSelecaoLateral() ? ` · <button type="button" data-escopo="grupo">Só em ${esc(nomeSelecao)}</button>` : '');
  }
}

$('#escopo-busca').addEventListener('click', (e) => {
  const b = e.target.closest('[data-escopo]');
  if (!b) return;
  buscaSoNoGrupo = b.dataset.escopo === 'grupo';
  lista.pagina = 1;
  renderMaquinas();
});

// Atalhos: "/" ou Ctrl+K focam a busca; Esc limpa
document.addEventListener('keydown', (e) => {
  const campo = $('#busca');
  if ($('#app').hidden || document.querySelector('dialog[open]')) return;
  const digitando = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.key === '/' && !digitando) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    if ($('[data-pagina=maquinas]').hidden) abrirAba('maquinas');
    campo.focus(); campo.select();
  } else if (e.key === 'Escape' && document.activeElement === campo && campo.value) {
    campo.value = ''; buscaSoNoGrupo = false; lista.pagina = 1; renderMaquinas();
  }
});

const CHAVES = {
  online: (m) => (m.online ? 1 : 0),
  nome: (m) => nomeDe(m).toLowerCase(),
  grupo: (m) => (m.mesh_grupo_nome || '').toLowerCase(),
  local: (m) => (m.local || '').toLowerCase(),
  usuario: (m) => usuarioCurto(m.usuario_logado).toLowerCase(),
  mac: (m) => m.mac || '',
  ip: (m) => ipDe(m).split('.').map((n) => n.padStart(3, '0')).join('.'),
  os: (m) => osCurto(m.mesh_os).toLowerCase(),
  visto: (m) => (m.online ? '9' : (m.ultimo_online || '0')),
};

function ordenadas(itens) {
  const k = CHAVES[lista.ordem] || CHAVES.online;
  const dir = lista.dir === 'asc' ? 1 : -1;
  return [...itens].sort((a, b) => {
    const va = k(a), vb = k(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return nomeDe(a).localeCompare(nomeDe(b), 'pt-BR'); // desempate sempre por nome
  });
}

function renderMaquinas() {
  const grupoAtual = grupos.find((g) => g.id === lista.grupo);
  const titulos = { todas: 'Todas as máquinas', online: 'Máquinas online', offline: 'Máquinas offline', semcadastro: 'Máquinas sem cadastro', foradominio: 'Máquinas fora do domínio' };
  const buscaGlobal = termosBusca().length > 0 && !(buscaSoNoGrupo && temSelecaoLateral());
  $('#titulo-lista').textContent = buscaGlobal ? 'Resultado da busca' : (grupoAtual ? grupoAtual.nome : titulos[lista.filtro]);
  renderEscopoBusca();
  document.querySelector('.lateral').classList.toggle('buscando', buscaGlobal);
  $('#btn-instalador').hidden = !grupoAtual; // tecnico tambem baixa (so dos grupos que ele ve)

  const itens = ordenadas(filtradas());
  const paginas = Math.max(1, Math.ceil(itens.length / POR_PAGINA));
  lista.pagina = Math.min(lista.pagina, paginas);
  const pagina = itens.slice((lista.pagina - 1) * POR_PAGINA, lista.pagina * POR_PAGINA);
  const online = itens.filter((m) => m.online).length;
  $('#resumo').innerHTML = `<b>${itens.length}</b> máquina${itens.length === 1 ? '' : 's'} · <b>${online}</b> online` +
    (grupoAtual?.descricao ? ` · ${esc(grupoAtual.descricao)}` : '');

  document.querySelectorAll('.tab-maq th[data-ordem]').forEach((th) => {
    th.classList.toggle('asc', th.dataset.ordem === lista.ordem && lista.dir === 'asc');
    th.classList.toggle('desc', th.dataset.ordem === lista.ordem && lista.dir === 'desc');
  });

  const admin = ehAdmin();
  const corpo = $('#lista-maquinas');
  if (!pagina.length) {
    const msg = !maquinas.length
      ? (admin ? 'Nenhuma máquina ainda. Crie um grupo na lateral e baixe o instalador dele.' : 'Nenhuma máquina ainda.')
      : (grupoAtual && !grupoAtual.total ? 'Grupo vazio. Baixe o instalador e execute no computador.' : 'Nenhuma máquina com esses filtros.');
    corpo.innerHTML = `<tr><td colspan="11" class="vazio-celula">${msg}</td></tr>`;
  } else {
    // Mesma placa de rede (MAC) em mais de um registro = mesmo computador com o agente reinstalado
    const porMac = new Map();
    for (const x of maquinas) if (x.mac && !x.removida_mesh) porMac.set(x.mac, [...(porMac.get(x.mac) || []), x]);
    const duplicadaDe = (m) => {
      if (!m.mac || m.online) return null;
      const outra = (porMac.get(m.mac) || []).find((x) => x !== m && x.online);
      return outra ? nomeDe(outra) : null;
    };
    corpo.innerHTML = pagina.map((m) => {
      const dup = duplicadaDe(m);
      const usu = usuarioCurto(m.usuario_logado);
      const des = m.online ? '' : 'disabled';
      const localSetor = [m.local, m.setor].filter(Boolean).join(' · ');
      const traco = '<span class="traco">—</span>';
      const info = [m.cliente, localSetor, m.mesh_grupo_nome].filter(Boolean).join(' · ');
      return `
      <tr data-id="${esc(m.node_id)}" class="${m.online ? '' : 'off'} ${selecionadas.has(m.node_id) ? 'sel' : ''}">
        ${admin ? `<td class="col-chk"><input type="checkbox" data-chk ${selecionadas.has(m.node_id) ? 'checked' : ''}></td>` : ''}
        <td class="col-st"><span class="status ${m.online ? 'on' : ''}" title="${m.online ? 'Online' : 'Offline'}"></span></td>
        <td title="${esc(m.mesh_nome)}">
          <span class="nome">${destacar(nomeDe(m))}</span>${m.pedir_permissao ? '<span class="pede-permissao" title="Pede permissão ao usuário antes do acesso"><svg><use href="#i-permissao"/></svg></span>' : ''}${m.removida_mesh ? '<span class="etiqueta">removida</span>' : dup ? `<span class="etiqueta" title="Mesma placa de rede (MAC) de &quot;${esc(dup)}&quot;, que está online: é o mesmo computador com o agente reinstalado. Copie o cadastro para o registro online e exclua este.">duplicada</span>` : m.fora_dominio ? '<span class="etiqueta" title="O nome desta máquina não existe no AD">fora do domínio</span>' : semCadastro(m) ? '<span class="etiqueta nova">nova</span>' : ''}
          ${m.apelido ? `<div class="nome-sub">${destacar(m.mesh_nome)}</div>` : ''}
          <div class="mobile-info">${esc(info)}</div>
        </td>
        <td class="col-grupo">${destacar(m.mesh_grupo_nome) || traco}</td>
        <td class="col-local" title="${esc(localSetor)}">${destacar(m.local) || traco}</td>
        <td class="col-usuario ${m.online ? '' : 'ultimo'}" title="${esc(m.usuario_logado ? (m.online ? 'Logado agora: ' : 'Último usuário visto: ') + m.usuario_logado : (m.online ? 'Ninguém logado' : ''))}">${destacar(usu) || traco}</td>
        <td class="col-mac">${destacar(m.mac) || traco}</td>
        <td class="col-ip" title="${esc(m.ip_local ? 'IP da máquina: ' + m.ip_local + (m.mesh_ip ? ' · conexão vinda de ' + m.mesh_ip : '') : 'IP da conexão (IP da máquina ainda não informado)')}">${destacar(ipDe(m)) || traco}${ipVia(m) ? `<div class="ip-via">via ${destacar(ipVia(m))}</div>` : ''}</td>
        <td class="col-os" title="${esc(m.mesh_os)}">${esc(osCurto(m.mesh_os)) || traco}</td>
        <td class="col-visto" title="${m.online ? 'Online agora' : dataBR(m.ultimo_online)}">${m.online ? 'agora' : haQuanto(m.ultimo_online)}</td>
        <td class="col-acoes"><div>
          <button class="icone principal" data-acao="desktop" title="Acessar a tela" ${des}><svg><use href="#i-tela"/></svg></button>
          <button class="icone" data-acao="terminal" title="Terminal" ${des}><svg><use href="#i-terminal"/></svg></button>
          <button class="icone" data-acao="arquivos" title="Arquivos" ${des}><svg><use href="#i-pasta"/></svg></button>
          ${admin ? '<button class="icone" data-acao="editar" title="Editar cadastro"><svg><use href="#i-editar"/></svg></button>' : ''}
        </div></td>
      </tr>`;
    }).join('');
  }

  // Paginacao
  const pag = $('#paginacao');
  if (itens.length <= POR_PAGINA) pag.innerHTML = '';
  else {
    const ini = (lista.pagina - 1) * POR_PAGINA + 1, fim = Math.min(lista.pagina * POR_PAGINA, itens.length);
    pag.innerHTML = `<span>${ini}–${fim} de ${itens.length}</span>
      <div class="pags">
        <button class="btn fantasma pequeno" data-pag="${lista.pagina - 1}" ${lista.pagina === 1 ? 'disabled' : ''}>Anterior</button>
        <span>Página ${lista.pagina} de ${paginas}</span>
        <button class="btn fantasma pequeno" data-pag="${lista.pagina + 1}" ${lista.pagina === paginas ? 'disabled' : ''}>Próxima</button>
      </div>`;
  }

  // Selecao em massa
  const chkTodas = $('#chk-todas');
  const naPagina = pagina.map((m) => m.node_id);
  const marcadas = naPagina.filter((id) => selecionadas.has(id)).length;
  chkTodas.checked = naPagina.length > 0 && marcadas === naPagina.length;
  chkTodas.indeterminate = marcadas > 0 && marcadas < naPagina.length;
  $('#massa').hidden = selecionadas.size === 0;
  $('#massa-qtd').textContent = `${selecionadas.size} selecionada${selecionadas.size === 1 ? '' : 's'}`;
}

$('#busca').addEventListener('input', () => { lista.pagina = 1; if (!$('#busca').value.trim()) buscaSoNoGrupo = false; renderMaquinas(); });
$('#filtro-cliente').addEventListener('input', () => { lista.pagina = 1; renderMaquinas(); });

document.querySelector('.tab-maq thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-ordem]');
  if (!th) return;
  if (lista.ordem === th.dataset.ordem) lista.dir = lista.dir === 'asc' ? 'desc' : 'asc';
  else { lista.ordem = th.dataset.ordem; lista.dir = th.dataset.ordem === 'online' || th.dataset.ordem === 'visto' ? 'desc' : 'asc'; }
  salvarPreferencias();
  renderMaquinas();
});

$('#paginacao').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pag]');
  if (!b || b.disabled) return;
  lista.pagina = Number(b.dataset.pag);
  renderMaquinas();
  document.querySelector('.conteudo').scrollIntoView({ block: 'start' });
});

$('#chk-todas').addEventListener('change', (e) => {
  document.querySelectorAll('#lista-maquinas tr[data-id]').forEach((tr) => {
    if (e.target.checked) selecionadas.add(tr.dataset.id); else selecionadas.delete(tr.dataset.id);
  });
  renderMaquinas();
});

async function massaPermissao(pedir) {
  const n = selecionadas.size;
  const msg = pedir ? `Pedir permissão ao usuário antes de acessar ${n} máquina(s)?` : `Voltar ao acesso direto (sem pedir permissão) em ${n} máquina(s)?`;
  if (!confirm(msg)) return;
  try {
    const { alteradas } = await api('POST', '/api/maquinas/permissao', { ids: [...selecionadas], pedir });
    toast(alteradas ? `${alteradas} máquina(s) atualizada(s).` : 'Nenhuma alteração: já estavam assim.');
  } catch (err) { toast(err.message); }
  setTimeout(carregarMaquinas, 600);
}
$('#massa-excluir').addEventListener('click', async () => {
  const sel = maquinas.filter((m) => selecionadas.has(m.node_id));
  const off = sel.filter((m) => !m.online).length, on = sel.length - off;
  if (!off) return toast('Nenhuma das selecionadas está offline. Só é possível excluir máquinas offline.');
  const avisoOnline = on ? `\n\n${on} selecionada(s) estão online e serão mantidas.` : '';
  if (!confirm(`Excluir ${off} máquina(s) offline do MeshCentral e do painel?${avisoOnline}\n\nSe alguma tiver o agente instalado, ela volta a aparecer quando ligar.`)) return;
  try {
    const r = await api('POST', '/api/maquinas/excluir', { ids: [...selecionadas] });
    selecionadas.clear();
    toast(`${r.excluidas} excluída(s)` + (r.online ? `, ${r.online} online mantida(s)` : '') + (r.falhas ? `, ${r.falhas} com erro: ${r.erro}` : '') + '.');
  } catch (err) { toast(err.message); }
  setTimeout(carregarMaquinas, 600);
});
$('#massa-pedir').addEventListener('click', () => massaPermissao(true));
$('#massa-direto').addEventListener('click', () => massaPermissao(false));

$('#massa-limpar').addEventListener('click', () => { selecionadas.clear(); renderMaquinas(); });

$('#massa-mover').addEventListener('click', async () => {
  const grupoId = $('#massa-grupo').value;
  if (!grupoId) return toast('Escolha o grupo de destino.');
  const g = grupos.find((x) => x.id === grupoId);
  if (!confirm(`Mover ${selecionadas.size} máquina(s) para "${g.nome}"?`)) return;
  try {
    await api('POST', '/api/maquinas/mover', { ids: [...selecionadas], grupoId });
    selecionadas.clear();
    toast('Máquinas movidas.');
  } catch (err) { toast(err.message); }
  setTimeout(carregarMaquinas, 800);
});

$('#lista-maquinas').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;

  if (e.target.matches('[data-chk]')) {
    if (e.target.checked) selecionadas.add(id); else selecionadas.delete(id);
    return renderMaquinas();
  }

  const btn = e.target.closest('button[data-acao]');
  if (!btn) return;
  if (btn.dataset.acao === 'editar') return abrirEdicao(id);

  // Abre a janela no clique (evita bloqueio de pop-up) e so depois define o endereco.
  const janela = window.open('', '_blank');
  try {
    const { url } = await api('POST', `/api/maquinas/${encodeURIComponent(id)}/acessar`, { modo: btn.dataset.acao });
    if (janela) janela.location = url; else window.location = url;
  } catch (err) {
    if (janela) janela.close();
    toast(err.message);
  }
});

// Duplo clique na linha abre a tela remota
$('#lista-maquinas').addEventListener('dblclick', (e) => {
  if (e.target.closest('button, input')) return;
  const b = e.target.closest('tr[data-id]')?.querySelector('[data-acao=desktop]:not(:disabled)');
  if (b) b.click();
});

// ---- Edicao de maquina -----------------------------------------------------

let editandoId = null;
const camposMaquina = ['apelido', 'cliente', 'local', 'setor', 'responsavel', 'patrimonio', 'observacao'];

function abrirEdicao(id) {
  const m = maquinas.find((x) => x.node_id === id);
  if (!m) return;
  editandoId = id;
  const f = $('#form-maquina');
  camposMaquina.forEach((c) => (f.elements[c].value = m[c] || ''));
  f.elements.grupo.value = m.mesh_grupo_id || '';
  f.elements.grupo.disabled = !!m.removida_mesh;
  f.elements.pedirPermissao.checked = !!m.pedir_permissao;
  f.elements.pedirPermissao.disabled = !!m.removida_mesh;
  $('#maquina-info').textContent = `${m.mesh_nome} · ${osCurto(m.mesh_os)}${ipDe(m) ? ' · ' + ipDe(m) : ''}${ipVia(m) ? ' (via ' + ipVia(m) + ')' : ''}`;
  $('#btn-remover-maquina').hidden = !!m.online;
  $('#maquina-nota-excluir').hidden = !m.online;
  $('#maquina-erro').hidden = true;
  $('#modal-maquina').showModal();
}

$('#form-maquina').addEventListener('submit', async (e) => {
  const acao = e.submitter?.value;
  if (acao === 'cancelar') return;
  e.preventDefault();
  try {
    if (acao === 'remover') {
      const m = maquinas.find((x) => x.node_id === editandoId);
      if (!confirm(`Excluir "${nomeDe(m)}"?\n\nO cadastro e o histórico de eventos dela no MeshCentral serão apagados. ` +
        'Se o agente ainda estiver instalado, ela volta a aparecer como nova quando ligar.')) return;
      await api('DELETE', `/api/maquinas/${encodeURIComponent(editandoId)}`);
      selecionadas.delete(editandoId);
      $('#modal-maquina').close();
      toast('Máquina excluída.');
      return setTimeout(carregarMaquinas, 500);
    } else {
      const f = e.target;
      await api('PUT', `/api/maquinas/${encodeURIComponent(editandoId)}`, { ...Object.fromEntries(camposMaquina.map((c) => [c, f.elements[c].value])), ...(f.elements.pedirPermissao.disabled ? {} : { pedirPermissao: f.elements.pedirPermissao.checked }) });
      const m = maquinas.find((x) => x.node_id === editandoId);
      if (!f.elements.grupo.disabled && f.elements.grupo.value && f.elements.grupo.value !== m.mesh_grupo_id) {
        await api('POST', '/api/maquinas/mover', { ids: [editandoId], grupoId: f.elements.grupo.value });
      }
    }
    $('#modal-maquina').close();
    toast('Salvo.');
    setTimeout(carregarMaquinas, 500);
  } catch (err) {
    $('#maquina-erro').textContent = err.message;
    $('#maquina-erro').hidden = false;
  }
});

// ---- Historico -------------------------------------------------------------

const MODOS = { desktop: 'Tela remota', terminal: 'Terminal', arquivos: 'Arquivos', exclusao: 'Máquina excluída', 'permissao-on': 'Passou a pedir permissão', 'permissao-off': 'Voltou ao acesso direto', instalador: 'Baixou instalador' };

// ---- Historico: filtros e paginacao feitos no servidor ---------------------
let histPagina = 1;
const histForm = () => $('#filtros-hist');
const CLASSE_MODO = { desktop: 'tela', terminal: 'terminal', arquivos: 'arquivos', exclusao: 'perigo', 'permissao-on': 'permissao', 'permissao-off': 'permissao', instalador: 'instalador' };

function histParametros(extra = {}) {
  const f = histForm();
  const p = new URLSearchParams();
  for (const c of ['usuario', 'maquina', 'modo', 'de', 'ate']) { const v = f.elements[c].value.trim(); if (v) p.set(c, v); }
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

async function carregarAcessos() {
  const p = histParametros({ pagina: histPagina, porPagina: 50 });
  let d;
  try { d = await api('GET', '/api/acessos?' + p.toString()); } catch (e) { d = { erro: e.message }; }
  if (typeof d.total !== 'number') {
    // Servidor desatualizado (pagina nova com servico antigo) ou erro: avisa em vez de ficar em branco
    $('#lista-acessos').innerHTML = `<tr><td colspan="5" class="vazio-celula">${esc(d.erro || 'Não foi possível carregar o histórico. Se o painel acabou de ser atualizado, reinicie o serviço AcessoRemotoPainel.')}</td></tr>`;
    $('#hist-paginacao').innerHTML = ''; $('#hist-resumo').textContent = '';
    return;
  }
  histPagina = d.pagina;

  // lista de usuarios do filtro (mantem a escolha)
  const sel = histForm().elements.usuario;
  const atual = sel.value;
  sel.innerHTML = '<option value="">Todos</option>' + d.usuarios.map((u) => `<option value="${u.id}">${esc(u.nome)}</option>`).join('');
  sel.value = d.usuarios.some((u) => String(u.id) === atual) ? atual : '';

  const filtrando = [...histParametros().keys()].length > 0;
  $('#hist-resumo').innerHTML = `<b>${d.total.toLocaleString('pt-BR')}</b> registro${d.total === 1 ? '' : 's'}${filtrando ? ' com os filtros' : ''}`;
  $('#hist-csv').href = '/api/acessos?' + histParametros({ formato: 'csv' }).toString();

  $('#lista-acessos').innerHTML = d.acessos.length ? d.acessos.map((a) => `
    <tr>
      <td class="mono">${dataBR(a.criado_em)}</td>
      <td><button type="button" class="link-filtro" data-filtro-usuario="${a.usuario_id}" title="Filtrar por este usuário">${esc(a.usuario_nome)}</button></td>
      <td><button type="button" class="link-filtro" data-filtro-maquina="${esc(a.maquina_nome)}" title="Filtrar por esta máquina">${esc(a.maquina_nome)}</button></td>
      <td><span class="acao acao-${CLASSE_MODO[a.modo] || 'outra'}">${MODOS[a.modo] || esc(a.modo)}</span></td>
      <td class="mono">${esc(a.ip_origem || '')}</td>
    </tr>`).join('')
    : `<tr><td colspan="5" class="vazio-celula">${filtrando ? 'Nenhum registro com esses filtros.' : 'Nenhum acesso registrado.'}</td></tr>`;

  renderPaginacao($('#hist-paginacao'), d.pagina, d.paginas, d.total, d.porPagina);
}

// Paginacao numerada: 1 … 4 5 [6] 7 8 … 20
function renderPaginacao(el, pagina, paginas, total, porPagina) {
  if (paginas <= 1) { el.innerHTML = ''; return; }
  const nums = new Set([1, paginas, pagina - 2, pagina - 1, pagina, pagina + 1, pagina + 2].filter((n) => n >= 1 && n <= paginas));
  const lista = [...nums].sort((a, b) => a - b);
  let botoes = '', ultimo = 0;
  for (const n of lista) {
    if (n - ultimo > 1) botoes += '<span class="reticencias">…</span>';
    botoes += `<button class="btn ${n === pagina ? 'primario' : 'fantasma'} pequeno pag-num" data-pag="${n}" ${n === pagina ? 'aria-current="page"' : ''}>${n}</button>`;
    ultimo = n;
  }
  const ini = (pagina - 1) * porPagina + 1, fim = Math.min(pagina * porPagina, total);
  el.innerHTML = `<span>${ini.toLocaleString('pt-BR')}–${fim.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}</span>
    <div class="pags">
      <button class="btn fantasma pequeno" data-pag="${pagina - 1}" ${pagina === 1 ? 'disabled' : ''}>‹ Anterior</button>
      ${botoes}
      <button class="btn fantasma pequeno" data-pag="${pagina + 1}" ${pagina === paginas ? 'disabled' : ''}>Próxima ›</button>
    </div>`;
}

$('#hist-paginacao').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pag]');
  if (!b || b.disabled) return;
  histPagina = Number(b.dataset.pag);
  carregarAcessos();
  $('[data-pagina=historico]').scrollIntoView({ block: 'start' });
});

// Qualquer mudanca de filtro volta para a pagina 1 (texto com pequena espera ao digitar)
let histEspera = null;
histForm().addEventListener('input', (e) => {
  clearTimeout(histEspera);
  histEspera = setTimeout(() => { histPagina = 1; carregarAcessos(); }, e.target.name === 'maquina' ? 300 : 0);
});
histForm().addEventListener('submit', (e) => e.preventDefault());

const isoDia = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
histForm().addEventListener('click', (e) => {
  const b = e.target.closest('[data-periodo]');
  if (!b) return;
  const hoje = new Date(), inicio = new Date();
  inicio.setDate(hoje.getDate() - Number(b.dataset.periodo));
  histForm().elements.de.value = isoDia(inicio);
  histForm().elements.ate.value = isoDia(hoje);
  histPagina = 1; carregarAcessos();
});
$('#hist-limpar').addEventListener('click', () => { histForm().reset(); histPagina = 1; carregarAcessos(); });

// Clicar no usuario ou na maquina da tabela filtra por ele
$('#lista-acessos').addEventListener('click', (e) => {
  const b = e.target.closest('.link-filtro');
  if (!b) return;
  const f = histForm();
  if (b.dataset.filtroUsuario) f.elements.usuario.value = b.dataset.filtroUsuario;
  if (b.dataset.filtroMaquina != null) f.elements.maquina.value = b.dataset.filtroMaquina;
  histPagina = 1; carregarAcessos();
});

// ---- Usuarios --------------------------------------------------------------

let usuarios = [];
let editandoUsuario = null;

async function carregarUsuarios() {
  const [du, dg] = await Promise.all([api('GET', '/api/usuarios'), api('GET', '/api/grupos')]);
  usuarios = du.usuarios;
  grupos = dg.grupos;
  const nomeGrupo = Object.fromEntries(grupos.map((g) => [g.id, g.nome]));
  $('#lista-usuarios').innerHTML = usuarios.map((u) => {
    const nomes = u.grupos.map((id) => nomeGrupo[id]).filter(Boolean).join(', ');
    const celula = u.perfil === 'admin' ? 'Todos' : (nomes ? esc(nomes) : '<span class="traco">nenhum</span>');
    return `
    <tr><td>${esc(u.nome)}</td><td>${esc(u.login)}</td><td>${u.perfil === 'admin' ? 'Administrador' : 'Técnico'}</td>
    <td class="celula-grupos" title="${esc(nomes)}">${celula}</td>
    <td>${u.totp_ativo ? '<span class="selo ok">Ativa</span>' : '<span class="selo pendente">No próximo login</span>'}</td>
    <td>${u.trocar_senha ? '<span class="selo pendente" title="Definida por um administrador; a pessoa cria a própria no próximo login">Temporária</span>' : '<span class="selo ok">Própria</span>'}</td>
    <td>${u.ativo ? 'Ativo' : 'Inativo'}</td>
    <td><button class="btn fantasma pequeno" data-usuario="${u.id}">Editar</button></td></tr>`;
  }).join('');
}

function atualizarCampoGrupos() {
  const f = $('#form-usuario');
  const tecnico = f.elements.perfil.value === 'tecnico';
  $('#campo-grupos').hidden = !tecnico;
  $('#nota-admin-grupos').hidden = tecnico;
}
$('#form-usuario').elements.perfil.addEventListener('change', atualizarCampoGrupos);

function abrirUsuario(u) {
  editandoUsuario = u;
  const f = $('#form-usuario');
  f.reset();
  const marcados = new Set(u?.grupos || []);
  $('#lista-grupos-usuario').innerHTML = grupos.length
    ? grupos.map((g) => `<label class="check"><input type="checkbox" name="grupo" value="${esc(g.id)}" ${marcados.has(g.id) ? 'checked' : ''}> ${esc(g.nome)}</label>`).join('')
    : '<span class="nota">Nenhum grupo criado ainda.</span>';
  $('#campo-2fa').hidden = !u;
  if (u) $('#status-2fa').innerHTML = 'Verificação em duas etapas: ' + (u.totp_ativo ? '<span class="selo ok">Ativa</span>' : '<span class="selo pendente">Será cadastrada no próximo login</span>');
  const nConf = u?.computadores_confiaveis || 0;
  $('#campo-esquecer').hidden = !nConf;
  $('#texto-esquecer').textContent = `Esquecer ${nConf === 1 ? 'o computador confiável' : `os ${nConf} computadores confiáveis`} (volta a pedir o código neles)`;
  $('#usuario-titulo').textContent = u ? 'Editar usuário' : 'Novo usuário';
  f.elements.nome.value = u?.nome || '';
  f.elements.login.value = u?.login || '';
  f.elements.login.disabled = !!u;
  f.elements.senha.required = !u;
  f.elements.senha.placeholder = u ? 'Deixe vazio para manter' : 'Mínimo 8 caracteres';
  f.elements.perfil.value = u?.perfil || 'tecnico';
  f.elements.ativo.checked = u ? !!u.ativo : true;
  $('#campo-ativo').hidden = !u;
  $('#btn-excluir-usuario').hidden = !u || u.id === usuario.id;
  // Na propria conta a senha nunca e temporaria (troca direto)
  $('#campo-senha-temp').hidden = !!u && u.id === usuario.id;
  f.elements.senhaTemporaria.checked = true;
  $('#usuario-erro').hidden = true;
  atualizarCampoGrupos();
  $('#modal-usuario').showModal();
}

$('#btn-novo-usuario').addEventListener('click', () => abrirUsuario(null));
$('#lista-usuarios').addEventListener('click', (e) => {
  const id = e.target.dataset.usuario;
  if (id) abrirUsuario(usuarios.find((u) => u.id === Number(id)));
});

$('#btn-excluir-usuario').addEventListener('click', async () => {
  const u = editandoUsuario;
  if (!u || !confirm(`Excluir o usuário "${u.nome}" (${u.login})?\n\nEle perde o acesso na hora. O histórico de acessos dele continua guardado.`)) return;
  try {
    await api('DELETE', `/api/usuarios/${u.id}`);
    $('#modal-usuario').close();
    toast('Usuário excluído.');
    carregarUsuarios();
  } catch (err) {
    $('#usuario-erro').textContent = err.message;
    $('#usuario-erro').hidden = false;
  }
});

$('#form-usuario').addEventListener('submit', async (e) => {
  if (e.submitter?.value === 'cancelar') return;
  e.preventDefault();
  const f = e.target;
  const dados = {
    nome: f.elements.nome.value, senha: f.elements.senha.value, perfil: f.elements.perfil.value, senhaTemporaria: f.elements.senhaTemporaria.checked,
    grupos: [...f.querySelectorAll('input[name=grupo]:checked')].map((c) => c.value),
  };
  if (dados.perfil === 'tecnico' && !dados.grupos.length && !confirm('Nenhum grupo marcado: este técnico não vai ver nenhuma máquina. Salvar assim mesmo?')) return;
  try {
    if (editandoUsuario) await api('PUT', `/api/usuarios/${editandoUsuario.id}`, { ...dados, ativo: f.elements.ativo.checked, redefinir2fa: f.elements.redefinir2fa.checked, esquecerComputadores: f.elements.esquecerComputadores.checked });
    else await api('POST', '/api/usuarios', { ...dados, login: f.elements.login.value });
    $('#modal-usuario').close();
    toast('Usuário salvo.');
    carregarUsuarios();
  } catch (err) {
    $('#usuario-erro').textContent = err.message;
    $('#usuario-erro').hidden = false;
  }
});

// ---- Inicio ----------------------------------------------------------------

let atualizador = null;

async function iniciar() {
  const estado = await api('GET', '/api/estado');
  modoConfigurar = estado.precisaConfigurar;
  usuario = estado.usuario;
  if (estado.confiarDias) $('#dias-confiar').textContent = estado.confiarDias;
  if (!usuario) return mostrarEntrada();

  $('#tela-entrada').hidden = true;
  $('#app').hidden = false;
  $('#usuario-nome').textContent = usuario.nome;
  $('#usuario-avatar').textContent = iniciais(usuario.nome);
  $('#usuario-avatar').title = usuario.nome + (usuario.perfil === 'admin' ? ' · Administrador' : ' · Técnico');
  document.querySelectorAll('[data-admin]').forEach((el) => (el.hidden = !ehAdmin()));
  if (usuario.trocar_senha) return abrirMinhaSenha(true);
  abrirAba('maquinas');
  await carregarMaquinas();
  clearInterval(atualizador);
  atualizador = setInterval(() => {
    // Nao redesenha enquanto um modal ou menu esta aberto
    if (!document.querySelector('dialog[open]') && $('#menu-grupo').hidden) carregarMaquinas();
  }, 10000);
}

iniciar();
