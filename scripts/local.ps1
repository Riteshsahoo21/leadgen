param([ValidateSet('start','stop','status','logs')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (!(Test-Path -LiteralPath '.env')) { throw 'Local .env is missing. Complete the local setup before starting.' }
$composeArgs = @('compose','-f','compose.yml','-f','compose.local.yml')
switch ($Action) {
  'start' {
    & docker info --format '{{.OSType}}' *> $null
    if ($LASTEXITCODE -ne 0) { & docker desktop start }
    & docker @composeArgs up -d
    if ($LASTEXITCODE -ne 0) { throw 'Local services did not start successfully.' }
    Write-Host 'LeadForge: http://localhost:8088 (API_TOKEN is in the private .env file)'
  }
  'stop' { & docker @composeArgs stop }
  'status' { & docker @composeArgs ps }
  'logs' { & docker @composeArgs logs --tail 100 -f api worker }
}
