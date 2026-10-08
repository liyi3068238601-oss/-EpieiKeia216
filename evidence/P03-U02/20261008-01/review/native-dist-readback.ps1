$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = 'E:\Xiadie\Xiadie'
$experiment = Join-Path $root '.runtime\P03\experiments\u02-native-dist-20261008-01'
$nativeRoot = Join-Path $root '.runtime\P01\desktop-source'
$reportPath = Join-Path $experiment 'result.json'
$runPath = Join-Path $root '.runtime\P03\worktrees\u02\evidence\P03-U02\20261008-01\native-runtime\run-07-runtime-result.json'
$reviewDir = Join-Path $root '.runtime\P03\reviews\u02-20261008'
function Get-Binding([string]$Path) {
  $item = Get-Item -LiteralPath $Path
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  return @{ path = [IO.Path]::GetFullPath($Path); bytes = [int64]$item.Length; sha256 = $hash }
}
function Assert-Binding($Expected, [string]$Label) {
  $actual = Get-Binding ([string]$Expected.path)
  if ($actual.bytes -ne [int64]$Expected.bytes -or $actual.sha256 -ne [string]$Expected.sha256) {
    throw "$Label changed: $($Expected.path)"
  }
  return $actual
}
function Normalize-Path([string]$Path) { return [IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant() }
$record = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
$native = Get-Content -LiteralPath $runPath -Raw | ConvertFrom-Json
if ($record.status -ne 'pass' -or $record.commit -ne '29628c9acdb81b703bbd4080c207a0e7ce5e276e' -or $record.mismatches.Count -ne 0) { throw 'Recompile report identity/status mismatch' }
$nativeHead = (& git -C $nativeRoot rev-parse HEAD | Out-String).Trim()
$nativeStatus = (& git -C $nativeRoot status --porcelain | Out-String).Trim()
if ($nativeHead -ne $record.commit -or $nativeStatus) { throw 'Pinned Native checkout is not exact and clean' }
$inputCount = 0; $outputCount = 0; $packageRows = @(); $outputByPath = @{}
foreach ($package in $record.results) {
  if ([int]$package.command.exitCode -ne 0) { throw "TypeScript compile failed: $($package.package)" }
  foreach ($input in $package.inputs) { [void](Assert-Binding $input "input/$($package.package)"); $inputCount++ }
  foreach ($output in $package.outputs) {
    if (-not $output.match) { throw "Recorded output mismatch: $($package.package)/$($output.relative)" }
    $generated = Assert-Binding $output.generated "generated/$($package.package)"
    $existing = Assert-Binding $output.existing "existing/$($package.package)"
    if ($generated.bytes -ne $existing.bytes -or $generated.sha256 -ne $existing.sha256) { throw "Generated and existing output differ: $($package.package)/$($output.relative)" }
    $outputByPath[(Normalize-Path $output.existing.path)] = $output
    $outputCount++
  }
  $packageRows += @{ package = $package.package; exitCode = [int]$package.command.exitCode; inputCount = $package.inputs.Count; outputCount = $package.outputs.Count }
}
$targets = @(
  'apps\zcode-cli\packages\bootstrap\dist\index.js',
  'apps\zcode-cli\packages\contracts\dist\model\invocation-context.js',
  'apps\zcode-cli\packages\contracts\dist\index.js',
  'apps\zcode-cli\packages\adapters\dist\model\runner.js',
  'apps\zcode-cli\packages\adapters\dist\fs\index.js',
  'apps\zcode-cli\packages\core\dist\memory\project-root.js'
)
$loadedRows = @()
foreach ($relative in $targets) {
  $path = Join-Path $nativeRoot $relative
  $recorded = @($native.sourceHashes | Where-Object { (Normalize-Path $_.path) -eq (Normalize-Path $path) })
  if ($recorded.Count -ne 1) { throw "run-07 does not uniquely bind loaded Native entrypoint: $relative" }
  $actual = Assert-Binding $recorded[0] "run-07-loaded/$relative"
  $key = Normalize-Path $path
  if (-not $outputByPath.ContainsKey($key)) { throw "Recompile report does not cover loaded Native entrypoint: $relative" }
  $distOutput = $outputByPath[$key]
  if ($actual.sha256 -ne [string]$distOutput.generated.sha256 -or $actual.sha256 -ne [string]$distOutput.existing.sha256) { throw "Loaded Native entrypoint differs from recompile: $relative" }
  $loadedRows += @{ relative = $relative.Replace('\','/'); bytes = $actual.bytes; sha256 = $actual.sha256; generatedMatches = $true; run07HashMatches = $true }
}
$preparePath = Join-Path $root '.runtime\P01\desktop-build-evidence\prepare-runtime.result.json'
$prepare = Get-Content -LiteralPath $preparePath -Raw | ConvertFrom-Json
$prepareBinding = Get-Binding $preparePath
if ([int]$prepare.exitCode -ne 0 -or $prepare.sourceSHA -ne $record.commit) { throw 'Historical prepare record is not tied to the pinned commit or did not pass' }
$prepareLogs = @()
foreach ($logPath in @($prepare.stdoutLog, $prepare.stderrLog)) {
  $prepareLogs += Get-Binding ([string]$logPath)
}
$stdoutText = [IO.File]::ReadAllText([string]$prepare.stdoutLog)
foreach ($packageName in @('shared-types','contracts','dynamic-workflow','dynamic-workflow-runtime','core','adapters','i18n','telemetry','bootstrap')) {
  if (-not $stdoutText.Contains("apps\zcode-cli\packages\$packageName")) { throw "Historical prepare log omits CLI workspace $packageName" }
}
$scriptPath = [string]$record.script.path
$scriptBinding = Get-Binding $scriptPath
$out = @{
  schema = 'p03-u02-native-dist-review-readback/v1'
  status = 'pass'
  sourceCommit = $record.commit
  sourceTreeHead = $nativeHead
  sourceTreeClean = $true
  recompileRecord = (Get-Binding $reportPath)
  recompileScript = $scriptBinding
  packageCount = $packageRows.Count
  packages = $packageRows
  inputCount = $inputCount
  comparedJavaScriptOutputCount = $outputCount
  mismatches = @()
  run07LoadedEntrypointsCompared = $loadedRows.Count
  loadedEntrypoints = $loadedRows
  historicalPrepare = @{ record = $prepareBinding; stdout = $prepareLogs[0]; stderr = $prepareLogs[1]; exitCode = [int]$prepare.exitCode; sourceCommit = $prepare.sourceSHA; cliWorkspaces = @('shared-types','contracts','dynamic-workflow','dynamic-workflow-runtime','core','adapters','i18n','telemetry','bootstrap') }
  limitation = 'Byte and SHA-256 identity checked for every listed input and generated/existing JavaScript output; the compile probe disables declaration output and does not claim a full Electron rebuild or dependency reinstall.'
}
$outPath = Join-Path $reviewDir 'native-dist-readback-result.json'
$raw = ($out | ConvertTo-Json -Depth 7) + "`n"
[IO.File]::WriteAllText($outPath, $raw, [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ status = $out.status; sourceCommit = $out.sourceCommit; packageCount = $out.packageCount; inputCount = $out.inputCount; comparedJavaScriptOutputCount = $out.comparedJavaScriptOutputCount; run07LoadedEntrypointsCompared = $out.run07LoadedEntrypointsCompared } | ConvertTo-Json -Compress


