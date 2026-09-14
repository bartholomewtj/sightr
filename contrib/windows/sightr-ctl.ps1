[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Command,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CommandArgs,
  [string]$TaskConfigDir,
  [string]$TaskSocketPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Community-maintained. This script lives in contrib/windows/, two levels below the plugin root.
$script:PluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:PluginId = "herdr.sightr"
$script:TaskName = if ($env:SIGHTR_TASK_NAME) { $env:SIGHTR_TASK_NAME } else { "herdr.sightr" }

function Resolve-SightrConfigDir {
  if ($env:HERDR_PLUGIN_CONFIG_DIR) {
    return $env:HERDR_PLUGIN_CONFIG_DIR
  }

  $herdr = Get-Command herdr.exe -ErrorAction SilentlyContinue
  if ($herdr) {
    try {
      $resolved = (& $herdr.Source plugin config-dir $script:PluginId 2>$null | Select-Object -First 1).Trim()
      if ($resolved) { return $resolved }
    } catch {
      # Herdr may not be running during login. Fall through to its conventional Windows path.
    }
  }

  $roaming = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\Roaming" }
  return Join-Path $roaming "herdr\plugins\config\$($script:PluginId)"
}

$script:ConfigDir = if ($TaskConfigDir) { $TaskConfigDir } else { Resolve-SightrConfigDir }
$script:EnvFile = Join-Path $script:ConfigDir ".env"

# NTFS analogue of chmod 600/700: strip inherited ACEs and grant only the current user Full
# Control. chmod through MSYS is a no-op on NTFS, so the bash side's POSIX hardening never took
# effect here. Failure warns rather than throws — start must not brick over an ACL it can't set.
#
# Directories must grant (OI)(CI) so children inherit. A grant of (F) on the directory object
# alone plus /inheritance:r leaves later files (exec-bridge.vbs) with no ACEs.
function Protect-SightrSecret([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $user = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
  $grant = if (Test-Path -LiteralPath $Path -PathType Container) {
    "${user}:(OI)(CI)(F)"
  } else {
    "${user}:(F)"
  }
  & icacls.exe $Path /inheritance:r /grant:r $grant *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "could not restrict ACL on $Path (icacls exit $LASTEXITCODE)"
  }
}

# Retained for remaining wrapper verbs.
function Import-SightrEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Protect-SightrSecret $Path

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $match = [regex]::Match($trimmed, '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
    if (-not $match.Success) {
      throw "invalid .env line: $line"
    }
    $name = $match.Groups[1].Value
    $value = $match.Groups[2].Value.Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

Import-SightrEnv $script:EnvFile

# Retained for remaining wrapper verbs.
function Get-SightrPort {
  $port = 8787
  if ($env:SIGHTR_PORT) {
    $parsed = 0
    if (-not [int]::TryParse($env:SIGHTR_PORT, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
      Write-Warning "SIGHTR_PORT=$($env:SIGHTR_PORT) is invalid - using 8787"
    } else {
      $port = $parsed
    }
  }
  return $port
}

$script:Port = Get-SightrPort
$script:RoamingDir = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\Roaming" }
$script:SocketPath = if ($TaskSocketPath) {
  $TaskSocketPath
} elseif ($env:HERDR_SOCKET_PATH) {
  $env:HERDR_SOCKET_PATH
} else {
  Join-Path $script:RoamingDir "herdr\herdr.sock"
}

# Retained for remaining wrapper verbs.
function Resolve-Bun {
  $command = Get-Command bun.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    (Join-Path $env:USERPROFILE ".bun\bin\bun.exe"),
    (Join-Path $env:ProgramData "chocolatey\bin\bun.exe"),
    (Join-Path $env:LOCALAPPDATA "bun\bin\bun.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw "bun not found - install Bun and make bun.exe available on PATH"
}

function Invoke-SightrCtl([string[]]$Arguments, [switch]$NoExit) {
  $bun = Resolve-Bun
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  & $bun (Join-Path $script:PluginRoot "scripts\ctl.ts") @Arguments
  if ($NoExit) { return $LASTEXITCODE }
  exit $LASTEXITCODE
}

# Retained for remaining wrapper verbs.
function Write-SightrActionLauncher {
  $launcherDir = Join-Path $script:PluginRoot "build"
  $launcher = Join-Path $launcherDir "sightr-action-v1.exe"
  if (Test-Path -LiteralPath $launcher) {
    $stream = [IO.File]::OpenRead($launcher)
    try { $isExecutable = $stream.ReadByte() -eq 77 -and $stream.ReadByte() -eq 90 } finally { $stream.Dispose() }
    if (-not $isExecutable) {
      throw "action launcher was built for POSIX; delete '$launcher' and rebuild"
    }
    return
  }
  New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  Add-Type -Path (Join-Path $PSScriptRoot "sightr-action.cs") -OutputAssembly $launcher -OutputType ConsoleApplication
}

if ($MyInvocation.InvocationName -eq ".") { return }

switch ($Command) {
  "start" { Invoke-SightrCtl @("start") }
  "stop" { Invoke-SightrCtl @("stop") }
  "restart" { Invoke-SightrCtl @("restart") }
  "uninstall" { Invoke-SightrCtl @("uninstall") }
  "serve" { Invoke-SightrCtl @("serve") }
  "unserve" { Invoke-SightrCtl @("unserve") }
  "update" { Invoke-SightrCtl ((@("update")) + @($CommandArgs)) }
  "_apply-update" { Invoke-SightrCtl @("_apply-update") }
  "logs" { Invoke-SightrCtl ((@("logs")) + @($CommandArgs)) }
  "hooks" { Invoke-SightrCtl ((@("hooks")) + @($CommandArgs)) }
  "url" { Invoke-SightrCtl @("url") }
  "version" { Invoke-SightrCtl @("version") }
  "qr" { Invoke-SightrCtl @("qr") }
  "push-test" { Invoke-SightrCtl ((@("push-test")) + @($CommandArgs)) }
  "status" { Invoke-SightrCtl @("status") }
  "env-check" { Invoke-SightrCtl @("env-check") }
  "keys" { Invoke-SightrCtl ((@("keys")) + @($CommandArgs)) }
  "push-keys" { Invoke-SightrCtl ((@("keys")) + @($CommandArgs)) }
  "build" { Write-SightrActionLauncher; Invoke-SightrCtl @("build") }
  "_exec-bridge" {
    $env:HERDR_PLUGIN_CONFIG_DIR = $script:ConfigDir
    $env:HERDR_SOCKET_PATH = $script:SocketPath
    $env:SIGHTR_PORT = [string]$script:Port
    Invoke-SightrCtl ((@("_exec-bridge", "--config-dir", $script:ConfigDir, "--socket", $script:SocketPath)) + @($CommandArgs))
  }
  default { Write-Error "usage: sightr-ctl.ps1 {start|stop|restart|uninstall|serve|unserve|update|version|build|status|env-check|keys|push-keys|url|logs|hooks|qr|push-test}" }
}
