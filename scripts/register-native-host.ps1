param(
  [string]$EnvPath = (Join-Path (Split-Path $PSScriptRoot -Parent) ".env")
)

$ErrorActionPreference = "Stop"

function Read-DotEnv([string]$Path) {
  $result = @{}
  if (!(Test-Path -LiteralPath $Path)) {
    throw ".env file not found: $Path"
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (!$line -or $line.StartsWith("#")) { return }
    $index = $line.IndexOf("=")
    if ($index -lt 1) { return }
    $key = $line.Substring(0, $index).Trim()
    $value = $line.Substring($index + 1).Trim().Trim('"').Trim("'")
    $result[$key] = $value
  }
  return $result
}

$extensionRoot = Split-Path $PSScriptRoot -Parent
$env = Read-DotEnv $EnvPath
$clientAppRoot = $env["CLIENT_APP_ROOT"]
if (!$clientAppRoot) {
  throw "CLIENT_APP_ROOT is missing in $EnvPath"
}

$clientAppRoot = [System.IO.Path]::GetFullPath($clientAppRoot)
$indexScript = Join-Path $extensionRoot "scripts\build-component-index.js"
if (!(Test-Path -LiteralPath $clientAppRoot)) {
  throw "ClientApp root not found: $clientAppRoot"
}
if (!(Test-Path -LiteralPath $indexScript)) {
  throw "Index script not found: $indexScript"
}

$hostName = "com.gng.dev_indexer"
$extensionId = if ($env["CHROME_EXTENSION_ID"]) { $env["CHROME_EXTENSION_ID"] } else { "pnimpbggomkfmajomfnmpnfllnancnkk" }
$nativeDir = Join-Path $extensionRoot "native"
$hostCmd = Join-Path $nativeDir "gng-index-host.cmd"
$hostManifest = Join-Path $nativeDir "$hostName.json"

if (!(Test-Path -LiteralPath $hostCmd)) {
  throw "Native host launcher not found: $hostCmd"
}

$manifest = [ordered]@{
  name = $hostName
  description = "GNG Dev component index native host"
  path = $hostCmd
  type = "stdio"
  allowed_origins = @("chrome-extension://$extensionId/")
}

$manifestJson = $manifest | ConvertTo-Json -Depth 5
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($hostManifest, $manifestJson, $utf8NoBom)

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $hostManifest

Write-Host "Registered $hostName"
Write-Host "Manifest: $hostManifest"
Write-Host "ClientApp root: $clientAppRoot"
Write-Host "Extension ID: $extensionId"
