param(
  [switch]$Json
)

$ErrorActionPreference = "Stop"

function Get-ExtensionId([string]$ManifestPath) {
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if (!$manifest.key) { throw "Manifest key is missing: $ManifestPath" }
  $publicKey = [Convert]::FromBase64String($manifest.key)
  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($publicKey)
  $characters = New-Object Text.StringBuilder
  foreach ($value in $hash[0..15]) {
    [void]$characters.Append([char]([int][char]'a' + (($value -shr 4) -band 15)))
    [void]$characters.Append([char]([int][char]'a' + ($value -band 15)))
  }
  return $characters.ToString()
}

function Read-JsonFile([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-DynamicProperty($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-PolicySnapshot([string]$Hive, [string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  $values = Get-ItemProperty -LiteralPath $Path
  $names = @(
    "BlockExternalExtensions",
    "DeveloperToolsAvailability",
    "ExtensionInstallAllowlist",
    "ExtensionInstallBlocklist",
    "ExtensionInstallForcelist",
    "ExtensionSettings"
  )
  $result = [ordered]@{ hive = $Hive }
  $found = $false
  foreach ($name in $names) {
    $value = Get-DynamicProperty $values $name
    if ($null -ne $value) {
      $result[$name] = $value
      $found = $true
    }
  }
  if (!$found) { return $null }
  return [pscustomobject]$result
}

$extensionRoot = Split-Path $PSScriptRoot -Parent
$manifestPath = Join-Path $extensionRoot "manifest.json"
$extensionManifest = Read-JsonFile $manifestPath
$extensionId = Get-ExtensionId $manifestPath
$chromeUserData = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
$localState = Read-JsonFile (Join-Path $chromeUserData "Local State")
$activeProfile = $localState.profile.last_used
$profileReports = New-Object System.Collections.Generic.List[object]

if (Test-Path -LiteralPath $chromeUserData) {
  Get-ChildItem -LiteralPath $chromeUserData -Directory | Where-Object {
    $_.Name -eq "Default" -or $_.Name -like "Profile *"
  } | ForEach-Object {
    $securePreferences = Read-JsonFile (Join-Path $_.FullName "Secure Preferences")
    $preferences = Read-JsonFile (Join-Path $_.FullName "Preferences")
    $secureEntry = Get-DynamicProperty $securePreferences.extensions.settings $extensionId
    $regularEntry = Get-DynamicProperty $preferences.extensions.settings $extensionId
    $entry = if ($null -ne $secureEntry) { $secureEntry } else { $regularEntry }
    $rawDisableReasons = if ($null -ne $entry) { $entry.disable_reasons } else { $null }
    $disableReasons = New-Object System.Collections.Generic.List[object]
    if ($null -ne $rawDisableReasons -and !($rawDisableReasons -is [pscustomobject] -and $rawDisableReasons.PSObject.Properties.Count -eq 0)) {
      foreach ($reason in @($rawDisableReasons)) { $disableReasons.Add($reason) }
    }
    $profileReports.Add([pscustomobject][ordered]@{
      profile = $_.Name
      active = $_.Name -eq $activeProfile
      registered = $null -ne $entry
      state = if ($null -ne $entry) { $entry.state } else { $null }
      location = if ($null -ne $entry) { $entry.location } else { $null }
      sourcePath = if ($null -ne $entry) { $entry.path } else { $null }
      disableReasons = $disableReasons.ToArray()
    })
  }
}

$hostName = "com.gng.dev_indexer"
$nativeRegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$nativeManifestPath = if (Test-Path -LiteralPath $nativeRegistryPath) {
  (Get-Item -LiteralPath $nativeRegistryPath).GetValue("")
} else { $null }
$nativeManifest = if ($nativeManifestPath) { Read-JsonFile $nativeManifestPath } else { $null }
$allowedOrigin = "chrome-extension://$extensionId/"
$nativeAllowed = $null -ne $nativeManifest -and @($nativeManifest.allowed_origins) -contains $allowedOrigin

$policies = @(@(
  Get-PolicySnapshot "HKCU" "HKCU:\Software\Policies\Google\Chrome"
  Get-PolicySnapshot "HKLM" "HKLM:\Software\Policies\Google\Chrome"
) | Where-Object { $null -ne $_ })

$registeredProfiles = @($profileReports | Where-Object { $_.registered })
$activeRegistration = @($profileReports | Where-Object { $_.active -and $_.registered })
$report = [pscustomobject][ordered]@{
  extension = [pscustomobject][ordered]@{
    id = $extensionId
    name = $extensionManifest.name
    version = $extensionManifest.version
    sourcePath = $extensionRoot
    sourceManifestExists = (Test-Path -LiteralPath $manifestPath)
  }
  chrome = [pscustomobject][ordered]@{
    userDataPath = $chromeUserData
    activeProfile = $activeProfile
    registeredProfileCount = $registeredProfiles.Count
    activeProfileHasExtension = $activeRegistration.Count -gt 0
    profiles = $profileReports.ToArray()
  }
  nativeHost = [pscustomobject][ordered]@{
    name = $hostName
    registered = (Test-Path -LiteralPath $nativeRegistryPath)
    manifestPath = $nativeManifestPath
    manifestExists = $nativeManifestPath -and (Test-Path -LiteralPath $nativeManifestPath)
    executablePath = if ($null -ne $nativeManifest) { $nativeManifest.path } else { $null }
    allowedOriginMatches = $nativeAllowed
  }
  policies = $policies
  findings = @(
    if ($registeredProfiles.Count -eq 0) { "Extension is not registered in any discovered Chrome profile." }
    if ($registeredProfiles.Count -gt 0 -and $activeRegistration.Count -eq 0) { "Extension exists in another Chrome profile, but not in the active profile." }
    if ($registeredProfiles | Where-Object { $_.disableReasons.Count -gt 0 }) { "Chrome recorded one or more disable reasons; inspect the profiles section." }
    if (!(Test-Path -LiteralPath $nativeRegistryPath)) { "Native messaging host is not registered." }
    elseif (!$nativeAllowed) { "Native host allowed_origins does not match this extension ID." }
    if ($policies.Count -gt 0) { "Chrome extension policies are configured; inspect the policies section." }
    if ($registeredProfiles.Count -gt 0 -and $activeRegistration.Count -gt 0 -and $nativeAllowed) { "Install registration and native-host linkage look healthy." }
  )
}

if ($Json) {
  $report | ConvertTo-Json -Depth 10
  return
}

Write-Host "GIG Component Inspector doctor"
Write-Host "Extension: $($report.extension.id) v$($report.extension.version)"
Write-Host "Source:    $($report.extension.sourcePath)"
Write-Host "Profile:   $($report.chrome.activeProfile) (registered here: $($report.chrome.activeProfileHasExtension))"
Write-Host "Profiles with extension: $($report.chrome.registeredProfileCount)"
Write-Host "Native host: registered=$($report.nativeHost.registered), origin matches=$($report.nativeHost.allowedOriginMatches)"
foreach ($finding in $report.findings) { Write-Host "- $finding" }
