# Implantação do agente via GPO: passo a passo

> Opcional: só para quem tem Active Directory. Troque `SEUDOMINIO.local` pelo seu domínio e o endereço
> `wss://remoto.suaempresa.com.br:9443/` pelo do seu MeshCentral (o mesmo que aparece em `MeshServer=`
> no `MeshAgent.msh` de um agente instalado).

Resultado final: todas as estações do domínio instalam o agente sozinhas e aparecem no painel,
cada uma no grupo do seu setor (pela OU do AD). Servidores e controladores de domínio são ignorados.

Faça tudo **em um controlador de domínio** (ou num computador com as ferramentas de administração do AD),
logado com uma conta de **administrador do domínio**.

---

## Parte 1: Copiar os arquivos para o NETLOGON

O NETLOGON é uma pasta compartilhada do domínio que todos os computadores conseguem ler.
É de lá que cada estação vai buscar o script e o instalador.

1. Monte uma pasta **AcessoRemoto** com `instalar-agente.ps1`, `mapa-grupos.csv` (ajustado às suas OUs) e uma subpasta
   `instaladores` com o instalador de cada grupo, baixado pelo ⋯ do grupo no painel.
2. Clique com o botão direito na pasta **AcessoRemoto** → **Copiar**.
3. Aperte **Windows + R**, digite `\\SEUDOMINIO.local\NETLOGON` e dê Enter.
4. Clique com o botão direito num espaço vazio → **Colar**.
5. Confira: deve existir `\\SEUDOMINIO.local\NETLOGON\AcessoRemoto\instalar-agente.ps1`
   e a pasta `\\SEUDOMINIO.local\NETLOGON\AcessoRemoto\instaladores` com um `.exe` por linha do CSV.

---

## Parte 2: Criar a GPO

1. Aperte **Windows + R**, digite `gpmc.msc` e dê Enter. Abre o **Gerenciamento de Política de Grupo**.
2. No painel da esquerda, expanda: **Floresta: SEUDOMINIO.local** → **Domínios** → **SEUDOMINIO.local**.
3. Clique com o botão direito em **SEUDOMINIO.local** → **Criar um GPO neste domínio e vinculá-lo aqui...**
4. Nome: `Acesso Remoto - Instalar agente` → **OK**.
5. A GPO aparece logo abaixo de SEUDOMINIO.local. Não mexa em "Filtragem de Segurança": o padrão
   ("Usuários Autenticados") já inclui todos os computadores do domínio.

---

## Parte 3: Configurar a GPO

Clique com o botão direito na GPO **Acesso Remoto - Instalar agente** → **Editar...**
Abre o **Editor de Gerenciamento de Política de Grupo**.

### 3.1 Tarefa agendada que instala o agente

1. No painel da esquerda, abra: **Configuração do Computador** → **Preferências** →
   **Configurações do Painel de Controle** → **Tarefas Agendadas**.
2. Clique com o botão direito no espaço em branco da direita → **Novo** → **Tarefa Agendada (pelo menos o Windows 7)**.

**Aba Geral**
- **Ação:** `Substituir`
- **Nome:** `AcessoRemoto - Instalar agente`
- **Descrição:** `Instala o agente do Acesso Remoto (MeshCentral)`
- **Conta de usuário:** clique em **Alterar Usuário ou Grupo...**, digite `SYSTEM`, clique em **Verificar Nomes** e em **OK**.
  Deve aparecer `NT AUTHORITY\System`.
- Marque **Executar com privilégios mais altos**.
- Marque **Oculta**.
- **Configurar para:** `Windows 10`

**Aba Disparadores** (crie dois)
1. **Novo...** → *Iniciar a tarefa:* **Na inicialização**.
   Em *Configurações avançadas*, marque **Atrasar tarefa por:** `1 minuto`. Deixe **Habilitado** marcado → **OK**.
2. **Novo...** → *Iniciar a tarefa:* **Em um agendamento** → **Diariamente**, *Iniciar:* hoje às `08:00:00`, *Repetir a cada:* `1` dias.
   Em *Configurações avançadas*, marque **Repetir a tarefa a cada:** `1 hora` **por uma duração de:** `12 horas`.
   Deixe **Habilitado** marcado → **OK**.

**Aba Ações**
- **Novo...** → *Ação:* **Iniciar um programa**
- **Programa/script:** `powershell.exe`
- **Adicionar argumentos:**
  ```
  -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "\\SEUDOMINIO.local\NETLOGON\AcessoRemoto\instalar-agente.ps1" -ServidorEsperado "wss://remoto.suaempresa.com.br:9443/"
  ```
- **OK**

**Aba Condições**
- **Desmarque** *Iniciar a tarefa somente se o computador estiver ligado à rede elétrica*. Assim, notebooks na bateria também instalam.

**Aba Configurações**
- Marque **Permitir que a tarefa seja executada por demanda**.
- Marque **Interromper a tarefa se ela for executada por mais de:** `1 hora`.
- **Se a tarefa já estiver em execução:** `Não iniciar uma nova instância`.

Clique em **OK**. A tarefa aparece na lista da direita.

### 3.2 Esperar a rede na inicialização (recomendado)

1. Ainda no editor, abra: **Configuração do Computador** → **Políticas** → **Modelos Administrativos** → **Sistema** → **Logon**.
2. Dê dois cliques em **Sempre aguardar pela rede na inicialização e no logon do computador** → **Habilitado** → **OK**.

Feche o editor. A GPO é salva automaticamente.

---

## Parte 4: Quando começa a valer

- **Atualização automática:** cada estação atualiza as políticas a cada 90 a 120 minutos, ou ao reiniciar. Aí a tarefa é criada nela.
- **Primeira execução:** a tarefa roda na próxima hora cheia entre 08:00 e 20:00, ou ao ligar o computador.
- **Para adiantar numa máquina:** abra o **Prompt de Comando como administrador** e rode `gpupdate /force`.
  Depois abra o **Agendador de Tarefas** → *Biblioteca* → **AcessoRemoto - Instalar agente** → botão direito → **Executar**.
- **Log em cada máquina:** `C:\Windows\Temp\AcessoRemoto-instalacao.log`. A linha `OK: agente instalado` confirma a instalação.
- **No painel:** a máquina aparece em poucos segundos, no grupo do setor ou em **Sem classificação**.

---

## Referência

- `instalar-agente.ps1`: roda como SYSTEM. Se o agente já existe, sai sem fazer nada.
  Ignora Windows Server, escolhe o instalador pela OU e instala com `-fullinstall`.
  Teste sem instalar: `powershell -ExecutionPolicy Bypass -File instalar-agente.ps1 -ServidorEsperado "wss://remoto.suaempresa.com.br:9443/" -Simular`
- `mapa-grupos.csv`: `OU;Grupo;Instalador`. A linha `*` é o padrão ("Sem classificação").
- **Novo setor/OU:** crie o grupo no painel, baixe o instalador pelo ⋯ do grupo para `instaladores\` e acrescente uma linha no CSV.
- **Filiais:** recebem a GPO quando estão conectadas ao domínio (VPN).
- **Remover a GPO não desinstala os agentes.** Para desinstalar uma máquina: `"C:\Program Files\Mesh Agent\MeshAgent.exe" -fulluninstall`
