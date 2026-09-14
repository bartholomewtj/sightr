$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$body = Get-Content -LiteralPath (Join-Path $PSScriptRoot "sightr-ctl.ps1") -Raw
foreach ($verb in @("start","stop","restart","uninstall","serve","unserve","update","_apply-update","logs","url","version","qr","push-test","status","env-check","keys","push-keys","build")) {
  if (-not $body.Contains("Invoke-SightrCtl") -or -not $body.Contains("`"$verb`"")) { throw "sightr-ctl.ps1 does not forward $verb" }
}
if (-not ($body.Contains("_exec-bridge") -and $body.Contains("--config-dir") -and $body.Contains("--socket"))) { throw "_exec-bridge forwarding contract missing" }
foreach ($deleted in @("Get-SightrUrl","Get-SightrVersion","Update-SightrCheckout","Get-SightrRemoteReleaseTags")) { if ($body.Contains($deleted)) { throw "deleted implementation remains: $deleted" } }
if (-not $body.Contains('if ($MyInvocation.InvocationName -eq ".")')) { throw "sourced guard missing" }
foreach ($verb in @("start","restart","build")) { if (-not $body.Contains("`"$verb`" { Write-SightrActionLauncher;")) { throw "$verb does not compile the Herdr action launcher" } }
Write-Output "Windows ctl forwarding tests: passed"
