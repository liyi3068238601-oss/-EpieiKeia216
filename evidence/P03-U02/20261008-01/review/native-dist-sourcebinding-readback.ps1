$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = 'E:\Xiadie\Xiadie'
$probe = Join-Path $root '.runtime\P03\worktrees\u02-source-probe'
$source = Join-Path $root '.runtime\P01\desktop-source'
$evidence = Join-Path $probe 'evidence\P03-U02\20261008-01\topology-service'
$bindingPath = Join-Path $evidence 'native-dist-source-bindings-02.json'
$compilePath = Join-Path $evidence 'native-dist-compile-result.json'
$experimentCompilePath = Join-Path $root '.runtime\P03\experiments\u02-native-dist-20261008-01\result.json'
$nativeRunPath = Join-Path $root '.runtime\P03\worktrees\u02\evidence\P03-U02\20261008-01\native-runtime\run-07-runtime-result.json'
$review = Join-Path $root '.runtime\P03\reviews\u02-20261008'
function Get-Binding([string]$Path) {
  $item = Get-Item -LiteralPath $Path
  return @{ path = [IO.Path]::GetFullPath($Path); bytes = [int64]$item.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
}
function Get-GitBlobSha([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $prefix = [Text.Encoding]::UTF8.GetBytes("blob $($bytes.Length)`0")
  $stream = [IO.MemoryStream]::new()
  $stream.Write($prefix, 0, $prefix.Length)
  $stream.Write($bytes, 0, $bytes.Length)
  $sha = [Security.Cryptography.SHA1]::Create()
  return [BitConverter]::ToString($sha.ComputeHash($stream.ToArray())).Replace('-', '').ToLowerInvariant()
}
function Normalize-Path([string]$Path) { return [IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant() }
$commit = (& git -C $probe rev-parse HEAD | Out-String).Trim()
$status = (& git -C $probe status --porcelain | Out-String).Trim()
if ($commit -ne 'fd87e1050a5202218f8c5b2411e1d01c0bbc1a07' -or $status) { throw 'Source-probe commit/tree is not the reviewed exact clean state' }
$paths = @(& git -C $probe diff-tree --no-commit-id --name-only -r $commit)
$unexpected = @($paths | Where-Object { -not ($_ -like 'spikes/P03/*' -or $_ -like 'evidence/P03-U02/20261008-01/topology-service/*') })
if ($paths.Count -ne 8 -or $unexpected.Count -ne 0) { throw 'Source-probe commit scope differs from the expected eight allowed files' }
$binding = Get-Content -LiteralPath $bindingPath -Raw | ConvertFrom-Json
$compile = Get-Content -LiteralPath $compilePath -Raw | ConvertFrom-Json
$experimentCompile = Get-Content -LiteralPath $experimentCompilePath -Raw | ConvertFrom-Json
$nativeRun = Get-Content -LiteralPath $nativeRunPath -Raw | ConvertFrom-Json
if ($binding.status -ne 'pass' -or $binding.commit -ne '29628c9acdb81b703bbd4080c207a0e7ce5e276e' -or $binding.trackedInputs -ne 1180 -or $binding.generatedInputs.Count -ne 1 -or $binding.byteIdenticalJavaScriptOutputs -ne 1163) { throw 'Source-binding manifest summary mismatch' }
if ((Get-Binding $experimentCompilePath).sha256 -ne [string]$binding.compilationReport.sha256 -or (Get-Binding $compilePath).sha256 -ne [string]$binding.compilationReport.sha256) { throw 'Committed copy and experiment compilation report differ' }
if ($compile.status -ne 'pass' -or $compile.commit -ne $binding.commit -or $compile.mismatches.Count -ne 0 -or $compile.results.Count -ne 9) { throw 'Compile report identity/status mismatch' }
if ((Get-Binding $compile.script.path).sha256 -ne [string]$compile.script.sha256) { throw 'Compile script hash differs from report' }
$treeLines = @(& git -C $source ls-tree -r --full-tree HEAD)
$tree = @{}
foreach ($line in $treeLines) {
  $tab = $line.IndexOf("`t")
  if ($tab -lt 0) { throw 'Could not parse source-probe Git tree' }
  $meta = $line.Substring(0, $tab).Split(' ', [StringSplitOptions]::RemoveEmptyEntries)
  if ($meta.Count -ge 3 -and $meta[1] -eq 'blob') { $tree[$line.Substring($tab + 1)] = $meta[2] }
}
$inputCount = 0; $trackedCount = 0; $generatedCount = 0
foreach ($row in $binding.inputs) {
  $path = Join-Path $source ($row.path -replace '/', '\')
  $actual = Get-Binding $path
  if ($actual.sha256 -ne [string]$row.sha256) { throw "Source input SHA differs: $($row.path)" }
  if ($row.origin -eq 'tracked-native-source') {
    $trackedCount++
    if (-not $tree.ContainsKey([string]$row.path) -or $tree[[string]$row.path] -ne [string]$row.gitBlob) { throw "Input Git blob is not in exact reviewed commit: $($row.path)" }
    if ((Get-GitBlobSha $path) -ne [string]$row.gitBlob) { throw "Input bytes differ from Git blob: $($row.path)" }
  } else {
    $generatedCount++
    if ($row.path -ne 'apps/zcode-cli/packages/dynamic-workflow/src/compiler/libs.generated.ts') { throw "Unexpected ignored generated input: $($row.path)" }
    $generatedPath = Join-Path (Split-Path $experimentCompilePath -Parent) 'generated-lib-readback\src\compiler\libs.generated.ts'
    $generatedBinding = Get-Binding $generatedPath
    if ($generatedBinding.sha256 -ne [string]$row.sha256 -or $generatedBinding.sha256 -ne [string]$binding.generatedReadback.generatedSha256) { throw 'Regenerated libs.generated.ts hash mismatch' }
  }
  $inputCount++
}
if ($inputCount -ne 1181 -or $trackedCount -ne 1180 -or $generatedCount -ne 1) { throw 'Input counts differ from source-binding manifest' }
$generatorRelative = [string]$binding.generatedReadback.generator.path
$generatorPath = Join-Path $source ($generatorRelative -replace '/', '\')
$generatorBinding = Get-Binding $generatorPath
if ($generatorBinding.sha256 -ne [string]$binding.generatedReadback.generator.sha256 -or $tree[$generatorRelative] -ne [string]$binding.generatedReadback.generator.gitBlob -or (Get-GitBlobSha $generatorPath) -ne [string]$binding.generatedReadback.generator.gitBlob) { throw 'Tracked generated-source generator binding mismatch' }
$tsPackagePath = [string]$compile.typescript.package.path
$tsRoot = Split-Path $tsPackagePath -Parent
if ($binding.generatedReadback.libInputs.Count -ne 57) { throw 'Expected exactly 57 TypeScript standard library inputs' }
$generatedText = [IO.File]::ReadAllText((Join-Path (Split-Path $experimentCompilePath -Parent) 'generated-lib-readback\src\compiler\libs.generated.ts'))
$marker = 'export const TS_LIBS: Record<string, string> = '
$index = $generatedText.IndexOf($marker, [StringComparison]::Ordinal)
if ($index -lt 0) { throw 'Generated TS library map declaration missing' }
$mapJson = $generatedText.Substring($index + $marker.Length).Trim()
$mapJson = $mapJson -replace ';\s*$', ''
$mapJson = $mapJson -replace ',\s*}$', '}'
$libMap = ConvertFrom-Json -InputObject $mapJson
foreach ($lib in $binding.generatedReadback.libInputs) {
  $libPath = Join-Path (Join-Path $tsRoot 'lib') ([string]$lib.name)
  $libBinding = Get-Binding $libPath
  if ($libBinding.bytes -ne [int64]$lib.bytes -or $libBinding.sha256 -ne [string]$lib.sha256) { throw "TypeScript lib input mismatch: $($lib.name)" }
  $property = $libMap.PSObject.Properties[[string]$lib.name]
  if ($null -eq $property -or $property.Value -cne [IO.File]::ReadAllText($libPath)) { throw "Generated library text differs from installed TypeScript lib: $($lib.name)" }
}
$commandCompile = Get-Content -LiteralPath (Join-Path $evidence 'native-dist-compile-01-command.json') -Raw | ConvertFrom-Json
$commandBind = Get-Content -LiteralPath (Join-Path $evidence 'native-dist-bind-02-command.json') -Raw | ConvertFrom-Json
if ([int]$commandCompile.exit_code -ne 0 -or [int]$commandBind.exit_code -ne 0 -or $commandCompile.stderr -or $commandBind.stderr) { throw 'Compile or source-binding command record failed' }
if ($nativeRun.sourcePin.commit -ne $binding.commit -or -not $nativeRun.sourcePin.clean) { throw 'Native run does not use the pinned clean source' }
$compileOutputMap = @{}
foreach ($package in $experimentCompile.results) { foreach ($output in $package.outputs) { $compileOutputMap[(Normalize-Path $output.existing.path)] = $output } }
$entrypoints = @('apps\zcode-cli\packages\bootstrap\dist\index.js','apps\zcode-cli\packages\contracts\dist\model\invocation-context.js','apps\zcode-cli\packages\contracts\dist\index.js','apps\zcode-cli\packages\adapters\dist\model\runner.js','apps\zcode-cli\packages\adapters\dist\fs\index.js','apps\zcode-cli\packages\core\dist\memory\project-root.js')
$entryRows = @()
foreach ($relative in $entrypoints) {
  $path = Join-Path $source $relative
  $row = @($nativeRun.sourceHashes | Where-Object { (Normalize-Path $_.path) -eq (Normalize-Path $path) })
  if ($row.Count -ne 1) { throw "Run-07 hash row missing/ambiguous: $relative" }
  $output = $compileOutputMap[(Normalize-Path $path)]
  if ($null -eq $output -or $row[0].sha256 -ne $output.generated.sha256 -or $row[0].sha256 -ne $output.existing.sha256 -or -not $output.match) { throw "Run-07 loaded entrypoint differs from compiled/existing output: $relative" }
  $actual = Get-Binding $path
  if ($actual.sha256 -ne [string]$row[0].sha256) { throw "Run-07 entrypoint changed after execution: $relative" }
  $entryRows += @{ path = $relative.Replace('\','/'); sha256 = $actual.sha256; bytes = $actual.bytes; compiledMatch = $true; run07Match = $true }
}
$ownReadbackPath = Join-Path $review 'native-dist-readback-result.json'
$ownReadback = Get-Content -LiteralPath $ownReadbackPath -Raw | ConvertFrom-Json
if ($ownReadback.status -ne 'pass' -or $ownReadback.comparedJavaScriptOutputCount -ne 1163 -or $ownReadback.run07LoadedEntrypointsCompared -ne 6) { throw 'Independent SHA readback report is not passing' }
$out = [ordered]@{
  schema = 'p03-u02-native-sourcebinding-review-readback/v1'
  status = 'pass'
  probeCommit = $commit
  probeTreeClean = $true
  probeChangedPaths = $paths.Count
  nativeSourceCommit = $binding.commit
  compileReport = Get-Binding $compilePath
  sourceBindings = Get-Binding $bindingPath
  compileCommand = Get-Binding (Join-Path $evidence 'native-dist-compile-01-command.json')
  bindingCommand = Get-Binding (Join-Path $evidence 'native-dist-bind-02-command.json')
  bindingScript = Get-Binding (Join-Path $probe 'spikes\P03\bind-native-dist-source.mjs')
  compileScript = Get-Binding (Join-Path $probe 'spikes\P03\verify-native-dist.mjs')
  packageCount = $experimentCompile.results.Count
  inputCount = $inputCount
  trackedSourceInputsMatchedToCommitBlobs = $trackedCount
  generatedInputsRegeneratedAndChecked = $generatedCount
  TypeScriptStandardLibrariesChecked = $binding.generatedReadback.libInputs.Count
  compiledJavaScriptOutputsMatched = [int]$binding.byteIdenticalJavaScriptOutputs
  loadedRuntimeEntrypointsMatched = $entryRows.Count
  loadedRuntimeEntrypoints = $entryRows
  independentPriorReadback = Get-Binding $ownReadbackPath
  mismatches = @()
  limitation = 'Source and generated JS provenance is byte-bound; TypeScript dependency installation provenance is bound by tool hashes/version, not reinstalled. No Electron rebuild is claimed.'
}
$outPath = Join-Path $review 'native-dist-sourcebinding-readback-result.json'
[IO.File]::WriteAllText($outPath, (($out | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ status = $out.status; probeCommit = $out.probeCommit; nativeSourceCommit = $out.nativeSourceCommit; packageCount = $out.packageCount; inputCount = $out.inputCount; trackedSourceInputsMatchedToCommitBlobs = $out.trackedSourceInputsMatchedToCommitBlobs; generatedInputsRegeneratedAndChecked = $out.generatedInputsRegeneratedAndChecked; TypeScriptStandardLibrariesChecked = $out.TypeScriptStandardLibrariesChecked; compiledJavaScriptOutputsMatched = $out.compiledJavaScriptOutputsMatched; loadedRuntimeEntrypointsMatched = $out.loadedRuntimeEntrypointsMatched } | ConvertTo-Json -Compress


