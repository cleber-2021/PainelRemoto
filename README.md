# PainelRemoto

Painel web para gerenciar o acesso remoto a um parque de computadores Windows.
O técnico procura a máquina, clica em **Acessar** e a tela remota abre direto no navegador, já autenticada,
sem instalar nada do lado de quem dá suporte.

O motor de acesso remoto é o [MeshCentral](https://github.com/Ylianst/MeshCentral) (Apache 2.0): agente nas máquinas,
relay e protocolo de tela. O PainelRemoto é a camada de gestão por cima dele: cadastro, permissões, histórico,
autenticação em duas etapas e uma experiência de uso simplificada para a equipe de TI.

> Desenvolvido e usado em produção num parque com centenas de estações Windows 10/11, dentro e fora do domínio.

## Recursos

**Máquinas**
- Lista sincronizada com o MeshCentral a cada 15 s e em tempo real quando uma máquina conecta ou desconecta
- Busca global (nome, IP, usuário logado, setor, responsável, patrimônio...), filtros e lista compacta para parques grandes
- Cadastro complementar por máquina: nome no painel, cliente, local, setor, responsável, patrimônio e observação
- IP real da interface de rede (não o do gateway/NAT) e nome atual do Windows, mesmo após renomear o computador
- Grupos (um instalador por grupo: a máquina entra sozinha no grupo do instalador usado), mover em lote e excluir offline em lote
- Por máquina, o administrador pode exigir **consentimento do usuário** antes do acesso (com aceite automático se ninguém estiver logado)
- Integração opcional com Active Directory: marca máquinas que não existem no domínio (ex.: VMs de sandbox do antivírus que executaram o instalador)

**Sessão remota**
- Tela, terminal e arquivos com um clique, conectando automaticamente e sem a interface do MeshCentral
- Botão **Tela cheia + atalhos** (Keyboard Lock API): Win, Alt+Tab, Ctrl+Shift+Esc vão para a máquina remota
- Menu de atalhos rápidos (Win+R, Win+E, Win+X, Win+L, Ctrl+Alt+Del...)
- Área de transferência sincronizada por padrão (copiar aqui, colar lá)
- **Enviar arquivos** ou arrastar arquivos para a janela: vão para a Área de Trabalho do usuário logado (com suporte a OneDrive)

**Segurança**
- Verificação em duas etapas (TOTP, RFC 6238) obrigatória, implementada sem dependências, com opção "confiar neste computador"
- Links de acesso com token AES-256-GCM **de uso único e válido por 1 minuto**
- Cada usuário do painel tem uma conta própria no MeshCentral (`painel-<login>`), criada e com direitos reconciliados pelo painel:
  técnicos veem e acessam só os grupos liberados para eles
- `loginKey` do MeshCentral: sem a chave, a interface web do MeshCentral nem responde
- Histórico de acessos com filtros por usuário, máquina e período
- Backup diário do banco (`VACUUM INTO`) com retenção configurável

**Interface**
- Tema claro e escuro, fontes Inter e JetBrains Mono embutidas, HTML/CSS/JS puro (sem framework nem build)

## Arquitetura

```
 Navegador do técnico
   │  HTTPS
   ▼
 PainelRemoto (Node.js + Express + SQLite)
   │  websocket de controle (control.ashx) com token AES-256-GCM
   ▼
 MeshCentral  ◄──── wss ──── Agentes (MeshAgent) nas estações
```

- O painel e o MeshCentral compartilham a `loginCookieEncryptionKey`. Ao clicar em Acessar, o painel emite um token para a conta
  MeshCentral daquela pessoa e abre `https://<meshcentral>/?login=<token>&gotonode=<id>&viewmode=11&hide=31&painel=1`.
- `meshcentral-custom/custom.js` roda dentro da página do MeshCentral e transforma a sessão aberta pelo painel
  em uma tela limpa: conexão automática, tela cheia, atalhos, área de transferência e envio de arquivos.
- O banco (`data/painel.db`) usa o `node:sqlite` nativo do Node (modo WAL).

| Pasta | Conteúdo |
|---|---|
| `src/` | servidor: rotas, autenticação, TOTP, integração com o MeshCentral, AD, backup |
| `public/` | interface web |
| `meshcentral-custom/` | script que personaliza a sessão do MeshCentral |
| `implantacao/` | instalação em massa do agente via GPO (opcional, para quem tem AD) |
| `docs/` | exemplo de configuração do MeshCentral |
| `scripts/` | utilitários de administração |

## Requisitos

- Node.js 22.5 ou mais novo
- MeshCentral 1.2 ou mais novo (testado na 1.2.5)
- Navegador Chrome ou Edge para os técnicos (o Brave e o Firefox não têm a API de captura do teclado)

## Instalação

1. **MeshCentral.** Instale (`npm install meshcentral`) e use `docs/meshcentral-config.exemplo.json` como base do
   `meshcentral-data/config.json`. Gere as chaves:
   ```bash
   node -e "console.log(require('crypto').randomBytes(80).toString('hex'))"
   ```
   ```bash
   node -e "console.log(require('crypto').randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g,''))"
   ```
   A primeira é a `loginCookieEncryptionKey`. A segunda é a `loginKey`, que precisa ter só letras e números, senão o MeshCentral não sobe.
2. **Script de personalização.** Copie `meshcentral-custom/custom.js` para `meshcentral-web/public/scripts/custom.js`
   (pasta ao lado de `meshcentral-data`). Sem ele, a sessão aberta pelo painel fica preta com o status "Desconectado".
3. **Conta de serviço.** Crie no MeshCentral um usuário administrador para o painel usar (`mesh.user`).
4. **Painel.**
   ```bash
   npm install
   ```
   Copie `config.example.json` para `config.json`, preencha e rode:
   ```bash
   npm start
   ```
   No primeiro acesso, o painel pede para criar o administrador e cadastrar o app autenticador.

### `config.json`

| Chave | Para que serve |
|---|---|
| `nome` | nome exibido no app autenticador (padrão `PainelRemoto`) |
| `porta`, `host` | onde o painel escuta (padrão `4500`, `0.0.0.0`) |
| `https.cert`, `https.key` | certificado do painel; recarregado sozinho quando é renovado. Sem `https`, sobe em HTTP |
| `exigir2fa` | `false` desliga a obrigatoriedade da verificação em duas etapas |
| `confiarDias` | por quantos dias "confiar neste computador" dispensa o código (padrão 30) |
| `ad` | `true` liga a conferência com o Active Directory (painel rodando no Windows, em máquina do domínio) |
| `backup.pasta`, `backup.dias` | backup diário do banco e retenção |
| `mesh.url` | como o painel alcança o MeshCentral (ex.: `https://127.0.0.1:9443`) |
| `mesh.urlPublica` | endereço do MeshCentral nos links abertos pelo navegador |
| `mesh.servername` | nome do certificado do MeshCentral, para validar o TLS conectando por IP |
| `mesh.caFile` | alternativa ao `servername` com certificado próprio: `meshcentral-data/root-cert-public.crt` |
| `mesh.user` | conta de serviço do MeshCentral |
| `mesh.loginTokenKey` | a mesma `loginCookieEncryptionKey` do MeshCentral |
| `mesh.loginKey` | a mesma `loginKey` do domínio no MeshCentral |

### Instalando o agente nas máquinas

- **Manual:** baixe o instalador pelo menu ⋯ do grupo no painel e execute na máquina.
- **Em massa, via GPO:** veja `implantacao/LEIA-ME.md`. O script escolhe o grupo pela OU do computador, ignora servidores
  e reinstala sozinho agentes que apontam para um endereço antigo do servidor.

### Antivírus

Antivírus com proteção comportamental podem injetar módulos no agente e impedir a captura de tela
(a sessão conecta, mas a imagem não chega). Nesse caso, crie exceção para o processo
`C:\Program Files\Mesh Agent\MeshAgent.exe` e reinicie o agente.

## Operação

- **Perfis:** Administrador (cadastra, gerencia grupos e usuários, baixa instaladores, vê o histórico de todos) e
  Técnico (acessa e baixa instaladores só dos grupos liberados).
- **Emergência 2FA** (único administrador perdeu o celular), no servidor:
  ```bash
  node scripts/redefinir-2fa.js <login>
  ```
- **Backup:** guarde fora do servidor a pasta `data/` do painel e o backup do MeshCentral (`autoBackup`).
  Sem as chaves do `meshcentral-data`, todos os agentes precisam ser reinstalados.

## Licença

MIT. Veja [LICENSE](LICENSE). O MeshCentral é distribuído sob a licença Apache 2.0 pelos seus autores.
As fontes Inter e JetBrains Mono são distribuídas sob a SIL Open Font License (`public/fonts/`).
