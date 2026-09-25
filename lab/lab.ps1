param(
  [ValidateSet('build', 'up', 'stop', 'down', 'status', 'logs', 'check', 'smoke', 'mobile-smoke', 'voip-smoke')]
  [string]$Action = 'status'
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$labRoot = Split-Path $PSScriptRoot -Parent
if ($Action -in @('build', 'up')) {
  $labBranch = (& git -C $labRoot branch --show-current).Trim()
  if ($labBranch -ne 'mobile-primary') { throw 'Inicie o laboratório somente na branch mobile-primary.' }
}
$labEnv = Join-Path $env:LOCALAPPDATA 'ViperConnect/mobile-primary.env'
if (!(Test-Path -LiteralPath $labEnv)) {
  # MSIX redirects AppData writes made by Codex; ordinary PowerShell needs the physical path.
  $labPackages = @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue)
  foreach ($labPackage in $labPackages) {
    $labCandidate = Join-Path $env:LOCALAPPDATA "Packages/$($labPackage.PackageFamilyName)/LocalCache/Local/ViperConnect/mobile-primary.env"
    if (Test-Path -LiteralPath $labCandidate) { $labEnv = $labCandidate; break }
  }
}
if (!(Test-Path -LiteralPath $labEnv)) { throw "Configure primeiro o ambiente local em $labEnv. Consulte docs/mobile-primary-local-lab.md." }
$labContext = (& docker context show).Trim()
if ($labContext -ne 'desktop-linux') { throw 'Este laboratório exige o contexto local desktop-linux. Não será usado um daemon remoto.' }
$labArgs = @('--context', 'desktop-linux', 'compose', '--project-name', 'viperconnect-mobile-lab', '--env-file', $labEnv, '-f', (Join-Path $labRoot 'compose.lab.yml'))
$labVoipEnv = Join-Path (Split-Path $labEnv -Parent) 'mobile-primary-voip.env'
if (Test-Path -LiteralPath $labVoipEnv) {
  $labArgs += @('--env-file', $labVoipEnv, '-f', (Join-Path $labRoot 'compose.lab.voip.yml'))
}
switch ($Action) {
  'build' { & docker @labArgs build compiler docs }
  'up' { & docker @labArgs up -d --no-build }
  'stop' { & docker @labArgs stop }
  'down' { & docker @labArgs down } # Deliberately preserves every data volume.
  'status' { & docker @labArgs ps }
  'logs' { & docker @labArgs logs --tail 80 }
  'check' { & docker @labArgs config --quiet }
  'smoke' { Get-Content -LiteralPath (Join-Path $PSScriptRoot 'smoke.mjs') -Raw -Encoding UTF8 | & docker @labArgs exec -T web node --input-type=module }
  'mobile-smoke' { Get-Content -LiteralPath (Join-Path $PSScriptRoot 'mobile-smoke.mjs') -Raw -Encoding UTF8 | & docker @labArgs exec -T web node --input-type=module }
  'voip-smoke' {
    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'relay-smoke.cjs') -Raw -Encoding UTF8 | & docker @labArgs exec -T worker-zapo node
    if ($LASTEXITCODE -ne 0) { throw 'O relay de áudio do worker falhou na verificação.' }
    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'voip-smoke.cjs') -Raw -Encoding UTF8 | & docker @labArgs exec -T voip node
  }
}
if ($LASTEXITCODE -ne 0) { throw "Docker terminou com código $LASTEXITCODE." }
