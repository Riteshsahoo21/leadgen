param(
  [Parameter(Mandatory = $true)]
  [string]$Source,
  [string]$Destination = "secrets/gmaps-proxies.txt"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  throw "Proxy source file not found: $Source"
}

$normalized = foreach ($line in Get-Content -LiteralPath $Source) {
  $value = $line.Trim()
  if (-not $value -or $value.StartsWith('#')) { continue }

  if ($value -match '^(https?|socks5h?)://') {
    $value
    continue
  }

  if ($value -match '^(?<host>[^:\s]+):(?<port>\d+):(?<user>[^:\s]+):(?<password>.+)$') {
    $user = [Uri]::EscapeDataString($Matches.user)
    $password = [Uri]::EscapeDataString($Matches.password)
    "http://${user}:${password}@$($Matches.host):$($Matches.port)"
    continue
  }

  throw "Unrecognized proxy format. Expected URL or host:port:user:password."
}

if ($normalized.Count -eq 0) { throw "No proxies found in source file." }

$destinationPath = [IO.Path]::GetFullPath((Join-Path (Get-Location) $Destination))
$destinationDirectory = Split-Path -Parent $destinationPath
[IO.Directory]::CreateDirectory($destinationDirectory) | Out-Null
[IO.File]::WriteAllLines($destinationPath, $normalized, [Text.UTF8Encoding]::new($false))

Write-Host "Imported $($normalized.Count) proxies into $destinationPath (credentials hidden)."
