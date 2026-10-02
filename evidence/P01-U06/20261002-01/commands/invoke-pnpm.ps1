param(
  [Parameter(Mandatory = $true)]
  [string]$ScriptName,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Selectors = @()
)

$ErrorActionPreference = "Stop"
$pnpm = $env:P01_U06_PNPM_CMD
if ([string]::IsNullOrWhiteSpace($pnpm) -or -not (Test-Path -LiteralPath $pnpm -PathType Leaf)) {
  throw "P01_U06_PNPM_CMD must point to the pinned local pnpm.cmd"
}
$commandText = @("pnpm", $ScriptName) + $Selectors
Write-Output ("command=" + ($commandText -join " "))
& $pnpm $ScriptName @Selectors
$exitCode = $LASTEXITCODE
Write-Output "pnpmExitCode=$exitCode"
exit $exitCode
