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
    if ($result.ContainsKey($key)) {
      throw "Duplicate .env key: $key. Each project must use a unique PROJECT_<ID> prefix."
    }
    $result[$key] = $value
  }
  return $result
}

$extensionRoot = Split-Path $PSScriptRoot -Parent
$env = Read-DotEnv $EnvPath

function Get-ConfiguredProjectRoots($Env) {
  $roots = New-Object System.Collections.Generic.List[string]
  if ($Env["CLIENT_APP_ROOT"]) {
    $roots.Add($Env["CLIENT_APP_ROOT"])
  }

  foreach ($key in $Env.Keys) {
    foreach ($field in @("CLIENT_APP_ROOT", "APP_ROOT", "ROOT")) {
      if ($key.StartsWith("PROJECT_") -and $key.EndsWith("_$field")) {
        $roots.Add($Env[$key])
        break
      }
    }
  }

  if ($Env["GNG_PROJECTS"]) {
    $Env["GNG_PROJECTS"].Split(";") | ForEach-Object {
      $parts = $_.Split("|")
      if ($parts.Length -ge 3) {
        $roots.Add(($parts[2..($parts.Length - 1)] -join "|").Trim())
      }
    }
  }

  return $roots | Where-Object { $_ } | Select-Object -Unique
}

$projectRoots = @(Get-ConfiguredProjectRoots $env)
if (!$projectRoots.Length) {
  throw "No project roots are configured in $EnvPath. Set CLIENT_APP_ROOT or PROJECT_*_CLIENT_APP_ROOT."
}

$projectRoots = @($projectRoots | ForEach-Object { [System.IO.Path]::GetFullPath($_) })
$indexScript = Join-Path $extensionRoot "scripts\build-component-index.js"
foreach ($projectRoot in $projectRoots) {
  if (!(Test-Path -LiteralPath $projectRoot)) {
    throw "Project root not found: $projectRoot"
  }
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
Write-Host "Project roots:"
$projectRoots | ForEach-Object { Write-Host "  $_" }
Write-Host "Extension ID: $extensionId"
