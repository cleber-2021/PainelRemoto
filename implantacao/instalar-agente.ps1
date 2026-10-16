# ============================================================
#  Instala o agente do Acesso Remoto (MeshCentral) via GPO
#
#  Roda como SYSTEM (tarefa agendada da GPO). Pode rodar quantas vezes for preciso:
#  se o agente ja estiver instalado, sai sem fazer nada.
#
#  - So estacoes de trabalho (pula Windows Server e controladores de dominio)
#  - Escolhe o instalador pelo OU do computador no AD (mapa-grupos.csv)
#  - Computador sem OU mapeada usa o instalador padrao ("Sem classificacao")
#  - Log local: C:\Windows\Temp\AcessoRemoto-instalacao.log
#
#  Teste sem instalar:  powershell -ExecutionPolicy Bypass -File instalar-agente.ps1 -Simular
# ============================================================
param(
    [switch]$Simular,
    [string]$Pasta = $PSScriptRoot,   # pasta com mapa-grupos.csv e a subpasta instaladores\
    # Servidor que o agente deve usar. Agente instalado apontando para outro endereco/porta
    # (ex.: apos trocar a porta do servidor) e removido e reinstalado automaticamente.
    [Parameter(Mandatory)] [string]$ServidorEsperado   # ex.: 'wss://remoto.suaempresa.com.br:9443/'
)

$ErrorActionPreference = 'Stop'
$Log = 'C:\Windows\Temp\AcessoRemoto-instalacao.log'
$Servico = 'Mesh Agent'

function Registrar($msg) {
    $linha = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg
    try { Add-Content -Path $Log -Value $linha -Encoding UTF8 } catch { }
    Write-Host $msg
}

# Compara nomes de OU sem acento e sem diferenciar maiusculas ("Recepção" = "recepcao")
function Normalizar([string]$s) {
    $d = $s.Normalize([Text.NormalizationForm]::FormD)
    (-join ($d.ToCharArray() | Where-Object { [Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne 'NonSpacingMark' })).Trim().ToLowerInvariant()
}

try {
    # 1) So estacoes (ProductType 1). 2 = controlador de dominio, 3 = servidor. Servidores nunca sao tocados.
    $tipo = (Get-CimInstance Win32_OperatingSystem).ProductType
    if ($tipo -ne 1) { if ($Simular) { Registrar "Ignorado: Windows Server (ProductType $tipo)." }; exit 0 }

    # 2) Ja instalado? Se aponta para o servidor certo, nada a fazer. Se aponta para outro
    #    (instalador antigo), remove para reinstalar abaixo.
    if (Get-Service -Name $Servico -ErrorAction SilentlyContinue) {
        $pastaAgente = Join-Path $env:ProgramFiles 'Mesh Agent'
        $msh = Join-Path $pastaAgente 'MeshAgent.msh'
        $atual = $null
        if (Test-Path $msh) {
            $linha = Select-String -Path $msh -Pattern '^MeshServer=(.+)$' | Select-Object -First 1
            if ($linha) { $atual = $linha.Matches[0].Groups[1].Value.Trim() }
        }
        if (-not $atual -or $atual.StartsWith($ServidorEsperado, [StringComparison]::OrdinalIgnoreCase)) {
            if ($Simular) { Registrar "Agente ja instalado e correto ($atual)." }
            exit 0
        }
        Registrar "Agente antigo aponta para $atual (esperado $ServidorEsperado). Reinstalando."
        if ($Simular) { Registrar 'Simulacao: nada foi alterado.'; exit 0 }
        $exe = Join-Path $pastaAgente 'MeshAgent.exe'
        if (-not (Test-Path $exe)) { throw "Agente antigo sem $exe para desinstalar." }
        $u = Start-Process -FilePath $exe -ArgumentList '-fulluninstall' -PassThru -WindowStyle Hidden
        if (-not $u.WaitForExit(180000)) { try { $u.Kill() } catch { }; throw 'Desinstalacao do agente antigo nao terminou em 3 minutos.' }
        Start-Sleep -Seconds 5
        if (Get-Service -Name $Servico -ErrorAction SilentlyContinue) { throw 'Nao foi possivel remover o agente antigo.' }
        Registrar 'Agente antigo removido.'
    }

    # 3) OU do computador no AD (tenta por ate ~2 min: no boot a rede pode demorar)
    $dn = $null
    for ($i = 0; $i -lt 12 -and -not $dn; $i++) {
        try {
            $busca = [adsisearcher]"(&(objectCategory=computer)(sAMAccountName=$($env:COMPUTERNAME)`$))"
            [void]$busca.PropertiesToLoad.Add('distinguishedname')
            $r = $busca.FindOne()
            if ($r) { $dn = [string]$r.Properties['distinguishedname'][0] }
        } catch { }
        if (-not $dn) { Start-Sleep -Seconds 10 }
    }
    if (-not $dn) { Registrar 'ERRO: nao foi possivel consultar o AD (rede indisponivel?). Tenta de novo na proxima execucao.'; exit 1 }

    # OUs do mais especifico para o mais geral, ignorando a OU "Computers"
    $ous = @(($dn -split '(?<!\\),') | Where-Object { $_ -like 'OU=*' } | ForEach-Object { $_.Substring(3) } | Where-Object { (Normalizar $_) -ne 'computers' })

    # 4) Mapa OU -> instalador
    $mapa = Import-Csv -Path (Join-Path $Pasta 'mapa-grupos.csv') -Delimiter ';' -Encoding UTF8
    $padrao = ($mapa | Where-Object { (Normalizar $_.OU) -eq '*' } | Select-Object -First 1).Instalador
    $escolhido = $null; $ouUsada = $null
    foreach ($ou in $ous) {
        $linha = $mapa | Where-Object { (Normalizar $_.OU) -eq (Normalizar $ou) } | Select-Object -First 1
        if ($linha) { $escolhido = $linha.Instalador; $ouUsada = $ou; break }
    }
    if (-not $escolhido) { $escolhido = $padrao; $ouUsada = '(sem OU mapeada)' }
    if (-not $escolhido) { throw 'mapa-grupos.csv sem linha padrao (OU = *).' }

    $origem = Join-Path (Join-Path $Pasta 'instaladores') $escolhido
    Registrar "Computador: $env:COMPUTERNAME | DN: $dn | OU usada: $ouUsada | Instalador: $escolhido"
    if ($Simular) { Registrar 'Simulacao: nada foi instalado.'; exit 0 }
    if (-not (Test-Path $origem)) { throw "Instalador nao encontrado: $origem" }

    # 5) Copia para local e instala em silencio
    $tmp = Join-Path $env:windir 'Temp\AcessoRemoto'
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $local = Join-Path $tmp 'AcessoRemoto-Agente.exe'
    Copy-Item -Path $origem -Destination $local -Force
    $p = Start-Process -FilePath $local -ArgumentList '-fullinstall' -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(180000)) { try { $p.Kill() } catch { }; throw 'Instalador nao terminou em 3 minutos.' }

    Start-Sleep -Seconds 5
    $svc = Get-Service -Name $Servico -ErrorAction SilentlyContinue
    if ($svc) { Registrar "OK: agente instalado (servico '$Servico' = $($svc.Status))." }
    else { Registrar "ERRO: instalador terminou (codigo $($p.ExitCode)) mas o servico '$Servico' nao apareceu."; exit 1 }
    Remove-Item -Path $local -Force -ErrorAction SilentlyContinue
} catch {
    Registrar ('ERRO: ' + $_.Exception.Message)
    exit 1
}
