// Personalizacao do MeshCentral para o Painel de Acesso Remoto.
// Quando a pagina e aberta pelo painel (?painel=1&gotonode=...&viewmode=11|12|13):
// - esconde a interface do MeshCentral (barra lateral) e deixa so a sessao, em tela cheia;
// - inicia a conexao sozinho (abrindo por link, o MeshCentral vai ate a maquina mas nao conecta);
// - liga a area de transferencia automatica (copiar aqui / colar la) por padrao;
// - adiciona o botao "Tela cheia + atalhos" (captura do teclado: Win, Alt+Tab, Ctrl+Shift+Esc...).
(function () {
  var q = new URLSearchParams(window.location.search); // lido ja no carregamento: a pagina limpa a URL depois
  if (q.get('painel') !== '1' || !q.get('gotonode')) return;
  var view = parseInt(q.get('viewmode'), 10);
  if ([11, 12, 13].indexOf(view) < 0) return;

  // Esconde a barra lateral desde o primeiro instante, para ela nao aparecer piscando.
  var estilo = document.createElement('style');
  estilo.textContent = '#page_leftbar{display:none!important}' +
    '#painelTelaCheia{margin-left:6px;cursor:pointer}';
  document.head.appendChild(estilo);

  // Botao "Tela cheia + atalhos": tela cheia do navegador com captura do teclado (Keyboard Lock).
  // Precisa de um clique (o navegador nao permite entrar em tela cheia sozinho).
  // Para sair: segure Esc por 2 segundos.
  function adicionarBotaoTelaCheia() {
    if (view !== 11 || document.getElementById('painelTelaCheia')) return;
    var alvo = document.getElementById('disconnectbutton1span');
    if (!alvo || !alvo.parentNode) return;
    var b = document.createElement('input');
    b.type = 'button'; b.id = 'painelTelaCheia'; b.value = 'Tela cheia + atalhos';
    b.title = 'Tela cheia com captura do teclado: Windows, Alt+Tab, Ctrl+Shift+Esc e outros atalhos vão para a máquina remota. Para sair, segure Esc.';
    b.onclick = function () {
      // Brave (e Firefox) nao tem a API de captura do teclado: avisa em vez de falhar calado
      if (!(navigator.keyboard && navigator.keyboard.lock)) {
        alert('Este navegador não permite capturar atalhos do teclado (o Brave e o Firefox bloqueiam esse recurso).\n\n' +
          'Para usar Windows, Alt+Tab, Ctrl+Shift+Esc etc. na máquina remota, abra o painel no Google Chrome ou no Microsoft Edge.\n\n' +
          'A sessão vai entrar em tela cheia mesmo assim.');
      }
      try {
        if (typeof enterBrowserFullscreen === 'function') { enterBrowserFullscreen(document.body); }
        if (typeof browserfullscreen !== 'undefined') { browserfullscreen = true; }
      } catch (e) { }
    };
    alvo.parentNode.insertBefore(b, alvo.nextSibling);
  }

  // Area de transferencia automatica (copiar aqui / colar la): liga UMA vez por usuario.
  // O MeshCentral guarda as preferencias da sessao por usuario no servidor e as aplica ao abrir
  // a pagina, por isso ligamos depois do carregamento e salvamos com putstore (vai para o servidor).
  // Se o tecnico desligar depois em Configuracoes, a escolha dele e respeitada.
  function ligarAreaTransferencia() {
    try {
      if (typeof desktopsettings === 'undefined' || typeof putstore !== 'function') return;
      if (getstore('painelClipboardPadrao', null)) return;
      desktopsettings.autoclipboard = true;
      putstore('desktopsettings', JSON.stringify(desktopsettings));
      putstore('painelClipboardPadrao', '1');
    } catch (e) { }
  }

  // ---- Enviar arquivos para a maquina remota (arrastar para a tela ou botao "Enviar arquivos") ----
  // Abre uma conexao de arquivos propria (mesmo protocolo do modo Arquivos do MeshCentral) e grava
  // na Area de Trabalho do usuario logado; sem usuario logado, na Area de Trabalho Publica.
  var envio = { ocupado: false, sessao: null, aoReceber: null };

  function painelEnvio() {
    var p = document.getElementById('painelEnvio');
    if (!p) {
      p = document.createElement('div'); p.id = 'painelEnvio';
      p.style.cssText = 'position:fixed;right:16px;bottom:56px;z-index:9999;width:340px;background:#111622;color:#e6ebf3;border:1px solid #2b3547;border-radius:10px;padding:12px 14px;font:13px Segoe UI,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.5)';
      document.body.appendChild(p);
    }
    return p;
  }
  function mostrarEnvio(html, fecharEm) {
    var p = painelEnvio(); p.innerHTML = html; p.style.display = 'block';
    clearTimeout(p._t); if (fecharEm) p._t = setTimeout(function () { p.style.display = 'none'; }, fecharEm);
  }
  var escHtml = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // Conexao de arquivos: resolve quando conectada; cada resposta JSON vai para envio.aoReceber
  function abrirSessaoArquivos(cb) {
    if (envio.sessao && envio.sessao.State == 3) return cb(null);
    var s = CreateAgentRedirect(meshserver, CreateRemoteFiles(function (data) {
      if ((data.length > 0) && (data.charCodeAt(0) != 123)) return;
      var j; try { j = JSON.parse(decode_utf8(data)); } catch (e) { try { j = JSON.parse(data); } catch (e2) { return; } }
      if (envio.aoReceber) envio.aoReceber(j);
    }), serverPublicNamePort, authCookie, authRelayCookie, domainUrl);
    s.attemptWebRTC = false;
    var pronto = false;
    s.onStateChanged = function (x, st) {
      if (st == 3 && !pronto) { pronto = true; cb(null); }
      if (st == 0) { if (!pronto) cb('Não foi possível abrir a conexão de arquivos.'); envio.sessao = null; }
    };
    envio.sessao = s;
    s.Start(currentNode._id);
  }

  function listar(caminho, cb) {
    envio.aoReceber = function (j) { if (j.path != null || j.dir === null) { envio.aoReceber = null; cb(j.dir || null); } };
    envio.sessao.sendText({ action: 'ls', reqid: 1, path: caminho });
  }
  var ehPasta = function (d) { return d && (d.t == 2 || d.t == 1); };
  var achar = function (dir, testa) { for (var i = 0; i < (dir || []).length; i++) { if (ehPasta(dir[i]) && testa(dir[i].n)) return dir[i].n; } return null; };

  // Descobre a Area de Trabalho do usuario logado (inclusive redirecionada para o OneDrive)
  function acharDestino(cb) {
    var publica = 'C:/Users/Public/Desktop';
    var u = ((getNodeFromId(currentNode._id) || currentNode).users || [])[0];
    if (!u) return cb(publica, 'Área de Trabalho Pública (ninguém logado)');
    var login = u.split('\\').pop().toLowerCase();
    listar('C:/Users', function (usuarios) {
      var perfil = achar(usuarios, function (n) { n = n.toLowerCase(); return n === login || n.indexOf(login + '.') === 0; });
      if (!perfil) return cb(publica, 'Área de Trabalho Pública (perfil de ' + login + ' não encontrado)');
      var base = 'C:/Users/' + perfil;
      listar(base, function (pastas) {
        var local = achar(pastas, function (n) { return n.toLowerCase() === 'desktop'; });
        // A Area de Trabalho pode estar redirecionada para o OneDrive. Pode haver mais de um
        // (pessoal e "OneDrive - empresa"): olha todos, o da empresa primeiro.
        var ods = (pastas || []).filter(function (d) { return ehPasta(d) && /^onedrive/i.test(d.n); })
          .map(function (d) { return d.n; })
          .sort(function (a, b) { return (b.indexOf(' - ') >= 0) - (a.indexOf(' - ') >= 0); });
        (function tentar(i) {
          if (i >= ods.length) return cb(local ? base + '/' + local : publica, local ? 'Área de Trabalho de ' + login : 'Área de Trabalho Pública (Área de Trabalho de ' + login + ' não encontrada)');
          listar(base + '/' + ods[i], function (dentro) {
            var dk = achar(dentro, function (n) { return /^(desktop|área de trabalho|area de trabalho)$/i.test(n); });
            if (dk) return cb(base + '/' + ods[i] + '/' + dk, 'Área de Trabalho de ' + login + ' (' + ods[i] + ')');
            tentar(i + 1);
          });
        })(0);
      });
    });
  }

  // Envia um arquivo em blocos de 64 KB, esperando a confirmacao do agente (mesmo esquema do MeshCentral)
  function enviarArquivo(pasta, arq, progresso, cb) {
    var pos = 0, lendo = false, terminou = false;
    function proximo() {
      if (lendo || pos >= arq.size) return;
      lendo = true;
      var fim = Math.min(pos + 65536, arq.size);
      var r = new FileReader();
      r.onload = function () {
        lendo = false;
        var d = new Uint8Array(r.result);
        if (d[0] == 123 || d[0] == 0) { var x = new Uint8Array(d.length + 1); x.set(d, 1); envio.sessao.send(x); } else { envio.sessao.send(d); }
        pos = fim; progresso(pos);
        if (pos >= arq.size) envio.sessao.sendText(JSON.stringify({ action: 'uploaddone', reqid: 0 }));
      };
      r.onerror = function () { cb('Falha ao ler ' + arq.name); };
      r.readAsArrayBuffer(arq.slice(pos, fim));
    }
    envio.aoReceber = function (j) {
      if (terminou || !j.action || j.action.indexOf('upload') !== 0) return;
      if (j.action === 'uploadstart' || j.action === 'uploadack') proximo();
      else if (j.action === 'uploaddone') { terminou = true; envio.aoReceber = null; cb(null); }
      else if (j.action === 'uploaderror') { terminou = true; envio.aoReceber = null; cb('O computador remoto recusou gravar ' + arq.name + '.'); }
    };
    envio.sessao.sendText(JSON.stringify({ action: 'upload', reqid: 0, path: pasta, name: arq.name, size: arq.size }));
    if (arq.size === 0) envio.sessao.sendText(JSON.stringify({ action: 'uploaddone', reqid: 0 }));
  }

  function enviarArquivos(lista) {
    var arquivos = [];
    for (var i = 0; i < lista.length; i++) { if (lista[i] && lista[i].size != null) arquivos.push(lista[i]); }
    if (!arquivos.length) return;
    if (envio.ocupado) return mostrarEnvio('Aguarde o envio anterior terminar.', 3000);
    envio.ocupado = true;
    var total = arquivos.reduce(function (s, f) { return s + f.size; }, 0), feito = 0;
    var fim = function (erro, destinoNome) {
      envio.ocupado = false;
      if (erro) mostrarEnvio('<b style="color:#f87171">Erro no envio</b><br>' + escHtml(erro), 8000);
      else mostrarEnvio('<b style="color:#4ade80">✓ ' + arquivos.length + ' arquivo(s) enviado(s)</b><br>Para: ' + escHtml(destinoNome), 6000);
    };
    mostrarEnvio('Preparando envio…');
    abrirSessaoArquivos(function (erro) {
      if (erro) return fim(erro);
      acharDestino(function (pasta, nome) {
        var i = 0;
        (function prox() {
          if (i >= arquivos.length) return fim(null, nome + ' (' + pasta.replace(/\//g, '\\') + ')');
          var f = arquivos[i++];
          var desenhar = function (pos) {
            var pct = total ? Math.round(100 * (feito + pos) / total) : 100;
            mostrarEnvio('Enviando para <b>' + escHtml(nome) + '</b><br><span style="color:#96a1b4">' + i + '/' + arquivos.length + ' · ' + escHtml(f.name) + '</span>' +
              '<div style="height:6px;background:#1f2737;border-radius:3px;margin-top:8px"><div style="height:6px;width:' + pct + '%;background:#4f8cff;border-radius:3px"></div></div>');
          };
          desenhar(0);
          enviarArquivo(pasta, f, desenhar, function (e) { if (e) return fim(e); feito += f.size; prox(); });
        })();
      });
    });
  }

  // Arrastar arquivos para a tela remota (substitui o comportamento padrao do MeshCentral)
  function ativarArrastar() {
    var area = document.getElementById('deskarea0') || document.body;
    var aviso = document.createElement('div');
    aviso.style.cssText = 'display:none;position:fixed;inset:0;z-index:9998;background:rgba(10,14,22,.6);border:3px dashed #4f8cff;color:#fff;font:600 20px Segoe UI,sans-serif;align-items:center;justify-content:center;pointer-events:none';
    aviso.textContent = 'Solte para enviar à Área de Trabalho do computador remoto';
    document.body.appendChild(aviso);
    var temArquivos = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; };
    var conectado = function () { return typeof desktop !== 'undefined' && desktop && desktop.State == 3; };
    window.addEventListener('dragover', function (e) { if (!temArquivos(e) || !conectado()) return; e.preventDefault(); e.stopPropagation(); aviso.style.display = 'flex'; }, true);
    window.addEventListener('dragleave', function (e) { if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight) aviso.style.display = 'none'; }, true);
    window.addEventListener('drop', function (e) {
      if (!temArquivos(e)) return;
      e.preventDefault(); e.stopPropagation(); aviso.style.display = 'none';
      if (conectado()) enviarArquivos(e.dataTransfer.files);
    }, true);
  }

  function adicionarBotaoEnviar() {
    if (view !== 11 || document.getElementById('painelEnviarArq')) return;
    var ref = document.getElementById('painelTelaCheia') || document.getElementById('disconnectbutton1span');
    if (!ref || !ref.parentNode) return;
    var entrada = document.createElement('input'); entrada.type = 'file'; entrada.multiple = true; entrada.style.display = 'none';
    entrada.onchange = function () { enviarArquivos(entrada.files); entrada.value = ''; };
    var b = document.createElement('input'); b.type = 'button'; b.id = 'painelEnviarArq'; b.value = 'Enviar arquivos';
    b.title = 'Envia arquivos do seu computador para a Área de Trabalho do usuário logado no computador remoto. Também dá para arrastar os arquivos para a tela.';
    b.style.marginLeft = '6px'; b.style.cursor = 'pointer';
    b.onclick = function () { entrada.click(); };
    ref.parentNode.insertBefore(b, ref.nextSibling);
    ref.parentNode.appendChild(entrada);
  }

  // ---- Atalhos rapidos: enviados pelo proprio MeshCentral (funcionam em qualquer navegador,
  // sem tela cheia). Codigo = modificadores (0x010000 Shift, 0x020000 Alt, 0x080000 Ctrl,
  // 0x100000 Win) + codigo da tecla.
  var ATALHOS = [
    ['Win + R  (Executar)', 0x100052],
    ['Ctrl + Shift + Esc  (Gerenciador de Tarefas)', 0x09001B],
    ['Win + E  (Explorador de Arquivos)', 0x100045],
    ['Win + X  (menu de administração)', 0x100058],
    ['Win + I  (Configurações)', 0x100049],
    ['Win + D  (mostrar Área de Trabalho)', 0x100044],
    ['Win + L  (bloquear a tela)', 0x10004C],
    ['Ctrl + Alt + Del  (tela de segurança)', 0x0A002E],
  ];
  function enviarAtalho(codigo) {
    var sel = document.getElementById('deskkeys');
    if (!sel || typeof deskSendKeys !== 'function') return;
    // deskSendKeys usa o valor selecionado no menu do rodape: inclui a opcao se faltar, envia e restaura
    var antes = sel.value, criada = null;
    if (![].some.call(sel.options, function (o) { return parseInt(o.value) === codigo; })) {
      criada = document.createElement('option'); criada.value = codigo; criada.text = 'painel'; sel.appendChild(criada);
    }
    sel.value = String(codigo);
    try { deskSendKeys(); } catch (e) { }
    if (criada) sel.removeChild(criada);
    sel.value = antes;
  }
  function adicionarAtalhos() {
    if (view !== 11 || document.getElementById('painelAtalhos')) return;
    var ref = document.getElementById('painelEnviarArq') || document.getElementById('painelTelaCheia') || document.getElementById('disconnectbutton1span');
    if (!ref || !ref.parentNode) return;
    var s = document.createElement('select'); s.id = 'painelAtalhos';
    s.title = 'Envia o atalho para o computador remoto';
    s.style.cssText = 'margin-left:6px;cursor:pointer;max-width:250px';
    s.innerHTML = '<option value="">Atalhos rápidos…</option>' + ATALHOS.map(function (a) { return '<option value="' + a[1] + '">' + a[0] + '</option>'; }).join('');
    s.onchange = function () { var v = parseInt(s.value); s.value = ''; s.blur(); if (v) enviarAtalho(v); };
    ref.parentNode.insertBefore(s, ref.nextSibling);
  }

  // Qualidade automatica: mede a latencia a cada 3s. Quando ela sobe em relacao a melhor latencia da
  // sessao (fila de imagens = rede congestionada), reduz qualidade, escala e quadros; quando normaliza,
  // volta aos poucos para as configuracoes do usuario. Comparar com a melhor latencia (e nao com um valor
  // fixo) evita derrubar a qualidade em links que sao sempre "longe" mas tem banda (ex.: filiais, ~300 ms).
  var NIVEIS = [
    null,                                              // 0: configuracoes do usuario
    { q: 30, esc: 768, fr: 100, nome: 'rede lenta' },  // 1
    { q: 15, esc: 512, fr: 400, nome: 'rede muito lenta' }, // 2
  ];
  var auto = { ligado: true, nivel: 0, base: null, amostras: [], bons: 0, sessao: null, orig: null, pinger: null };
  try { auto.ligado = localStorage.getItem('painel.qualidadeAuto') !== '0'; } catch (e) { }

  function aplicarNivel(n) {
    var m = desktop && desktop.m; if (!m || !m.SendCompressionLevel || !auto.orig) return;
    auto.nivel = n;
    var o = auto.orig, p = NIVEIS[n];
    if (p) m.SendCompressionLevel(o.tipo, Math.min(o.q, p.q), Math.min(o.esc, p.esc), Math.max(o.fr, p.fr));
    else m.SendCompressionLevel(o.tipo, o.q, o.esc, o.fr);
    atualizarStatusAuto();
  }
  function atualizarStatusAuto() {
    var s = document.getElementById('painelQualidadeStatus'); if (!s) return;
    var p = auto.ligado && NIVEIS[auto.nivel];
    s.textContent = p ? p.nome + ': qualidade reduzida' : '';
    s.title = p ? 'A conexão está lenta. A imagem foi simplificada para a sessão continuar fluida e volta ao normal sozinha quando a rede melhorar.' : '';
  }
  function novaAmostra(ms) {
    if (!auto.ligado || ms < 0) return;
    auto.amostras.push(ms); if (auto.amostras.length > 3) auto.amostras.shift();
    var media = auto.amostras.reduce(function (a, b) { return a + b; }, 0) / auto.amostras.length;
    if (auto.base == null || ms < auto.base) auto.base = ms;
    var excesso = media - auto.base;
    var alvo = (excesso > 400 || media > 1200) ? 2 : (excesso > 150 ? 1 : 0);
    if (alvo > auto.nivel) { auto.bons = 0; aplicarNivel(alvo); }           // piora: reage na hora
    else if (alvo < auto.nivel && excesso < 80) {                           // melhora: so depois de ~10s estavel, um degrau por vez
      if (++auto.bons >= 3) { auto.bons = 0; aplicarNivel(auto.nivel - 1); }
    } else auto.bons = 0;
  }
  function acompanharSessao() {
    if (typeof desktop === 'undefined' || !desktop || desktop.State != 3 || !desktop.m) return;
    if (auto.sessao !== desktop) { // sessao nova (ou reconexao): guarda as configuracoes e passa a medir
      auto.sessao = desktop; auto.nivel = 0; auto.base = null; auto.amostras = []; auto.bons = 0;
      var m = desktop.m;
      auto.orig = { tipo: m.ImageType || 1, q: parseInt(m.CompressionLevel) || 50, esc: parseInt(m.ScalingLevel) || 1024, fr: parseInt(m.FrameRateTimer) || 100 };
      var original = desktop.latency && desktop.latency.callback;
      if (desktop.latency) desktop.latency.callback = function (ms) { if (original) original(ms); novaAmostra(ms); };
      atualizarStatusAuto();
    }
    // O MeshCentral so mede a cada 10s; pedimos uma medida a cada 3s (mensagem minuscula)
    if (auto.ligado && desktop.sendCtrlMsg) desktop.sendCtrlMsg(JSON.stringify({ ctrlChannel: '102938', type: 'rtt', time: new Date().getTime() }));
  }
  function adicionarQualidade() {
    if (view !== 11 || document.getElementById('painelQualidade')) return;
    var ref = document.getElementById('painelAtalhos') || document.getElementById('disconnectbutton1span');
    if (!ref || !ref.parentNode) return;
    var s = document.createElement('select'); s.id = 'painelQualidade';
    s.title = 'Automática: reduz a qualidade da imagem quando a rede fica lenta e volta ao normal quando melhora';
    s.style.cssText = 'margin-left:6px;cursor:pointer';
    s.innerHTML = '<option value="1">Qualidade automática</option><option value="0">Qualidade fixa</option>';
    s.value = auto.ligado ? '1' : '0';
    s.onchange = function () {
      auto.ligado = s.value === '1'; s.blur();
      try { localStorage.setItem('painel.qualidadeAuto', auto.ligado ? '1' : '0'); } catch (e) { }
      if (!auto.ligado && auto.nivel) aplicarNivel(0);
      atualizarStatusAuto();
    };
    var st = document.createElement('span'); st.id = 'painelQualidadeStatus';
    st.style.cssText = 'margin-left:8px;color:#f0b429;font-size:12px';
    ref.parentNode.insertBefore(st, ref.nextSibling);
    ref.parentNode.insertBefore(s, ref.nextSibling);
    if (!auto.pinger) auto.pinger = setInterval(function () { try { acompanharSessao(); } catch (e) { } }, 3000);
  }

  var tentativas = 0;
  var timer = setInterval(function () {
    tentativas++;
    if (tentativas > 120) { clearInterval(timer); return; } // desiste apos ~30s
    try {
      if (typeof currentNode === 'undefined' || !currentNode) return;
      if (typeof xxcurrentView === 'undefined' || xxcurrentView !== view) return;
      if (typeof xxdialogMode !== 'undefined' && xxdialogMode) return;
      var node = getNodeFromId(currentNode._id) || currentNode;
      // Espera o status do agente chegar; depois de ~3s tenta mesmo assim (o painel so libera maquinas online).
      if (((node.conn & 1) === 0) && tentativas < 12) return;

      // Modo tela cheia nativo do MeshCentral (o mesmo do botao de expandir da sessao).
      if (view === 13) { document.body.classList.add('fulldesk'); }
      else if (typeof fullscreen !== 'undefined' && !fullscreen) { deskToggleFull({}); }
      document.title = (node.name || 'Máquina') + ' - PainelRemoto';
      adicionarBotaoTelaCheia();
      adicionarBotaoEnviar();
      adicionarAtalhos();
      adicionarQualidade();
      if (view === 11) ativarArrastar();
      ligarAreaTransferencia();

      if (view === 11 && desktop == null) connectDesktop(null, 3);
      else if (view === 12 && terminal == null) connectTerminal(null, 1);
      else if (view === 13 && files == null) connectFiles(null);
      clearInterval(timer);
    } catch (e) { /* pagina ainda montando */ }
  }, 250);
})();
