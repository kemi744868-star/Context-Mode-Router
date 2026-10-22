# Install opencode-context-mode-router into the OpenCode global config.
#
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Uninstall
#
# Copies src/ into ~/.config/opencode/plugins/context-mode-router and registers
# the plugin in ~/.config/opencode/opencode.json.

param(
  [switch]$Uninstall,
  [string]$ConfigDir = "$env:USERPROFILE\.config\opencode"
)

$ErrorActionPreference = "Stop"
$PluginName = "context-mode-router"
$PluginsDir = Join-Path $ConfigDir "plugins"
$TargetDir = Join-Path $PluginsDir $PluginName
$ConfigFile = Join-Path $ConfigDir "opencode.json"
$SourceDir = Join-Path $PSScriptRoot "..\src"
$SourcePkg = Join-Path $PSScriptRoot "..\package.json"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
  if (Test-Path $TargetDir) {
    Write-Step "Removing $TargetDir"
    Remove-Item $TargetDir -Recurse -Force
  }
  if (Test-Path $ConfigFile) {
    $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
    $before = @($cfg.plugin).Count
    $cfg.plugin = @(@($cfg.plugin) | Where-Object { $_ -notlike "*$PluginName*" })
    if ($cfg.plugin.Count -eq 0) { $cfg.plugin = @() }
    if ($before -ne $cfg.plugin.Count) {
      $cfg | ConvertTo-Json -Depth 20 | Set-Content $ConfigFile -Encoding UTF8
      Write-Step "Plugin entry removed from opencode.json"
    }
  }
  Write-Host "Done." -ForegroundColor Green
  exit 0
}

# ------------------------------------------------------------------- install
if (-not (Test-Path $SourceDir)) { throw "Source not found: $SourceDir" }
if (-not (Test-Path $ConfigFile)) { throw "OpenCode config not found: $ConfigFile" }

Write-Step "Copying plugin to $TargetDir"
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
Copy-Item (Join-Path $SourceDir "*") $TargetDir -Recurse -Force

# the plugin dir needs a package.json of its own
$pkg = Get-Content $SourcePkg -Raw | ConvertFrom-Json
@{
  name = $PluginName
  version = $pkg.version
  private = $true
  type = "module"
  exports = @{ "." = "./index.js" }
} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $TargetDir "package.json") -Encoding UTF8

Write-Step "Registering in opencode.json"
$cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
$entry = ($TargetDir -replace "\\", "/")
$existing = @($cfg.plugin)
if ($existing -notcontains $entry) {
  $cfg.plugin = @($existing + $entry)
  $cfg | ConvertTo-Json -Depth 20 | Set-Content $ConfigFile -Encoding UTF8
  Write-Step "Added: $entry"
} else {
  Write-Step "Already registered"
}

Write-Host ""
Write-Host "Installed." -ForegroundColor Green
Write-Host "Restart OpenCode, then check the log for a 'failed to load plugin' line for context-mode-router."
Write-Host ""
Write-Host "Kill switch:  CONTEXT_MODE_ROUTER=off"
Write-Host "Threshold:    CONTEXT_MODE_ROUTER_MAX_BYTES=24576"
