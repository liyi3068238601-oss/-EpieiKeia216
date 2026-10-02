$ErrorActionPreference = "Stop"
$worktree = "E:\Xiadie\Xiadie\.runtime\P01\worktrees\u07"
$evidence = Join-Path $worktree "evidence\P01-U07\20261002-01"
$logs = Join-Path $evidence "logs"
$commands = Join-Path $evidence "commands"
$nodeDir = "E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64"
$node = Join-Path $nodeDir "node.exe"
$corepack = Join-Path $nodeDir "node_modules\corepack\dist\corepack.js"
$testRunner = Join-Path $worktree "tools\run-tests.mjs"
$sourceRoot = "E:\Xiadie\Xiadie\.runtime\P00\zcode\source"
New-Item -ItemType Directory -Force -Path $logs, $commands | Out-Null
$env:PATH = "E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\bin;$nodeDir;$env:PATH"
$env:P01_U07_ZCODE_SOURCE = $sourceRoot

$specs = @(
  @{ name = "build"; argv = @($corepack, "pnpm@10.33.2", "run", "build") },
  @{ name = "check"; argv = @($corepack, "pnpm@10.33.2", "run", "check") },
  @{ name = "unit"; argv = @($testRunner, "unit", "P01-U07") },
  @{ name = "integration"; argv = @($testRunner, "integration", "P01-U07") }
)

foreach ($spec in $specs) {
  $prior = Get-ChildItem -LiteralPath $logs -Filter "$($spec.name)-*.execution.json" -File -ErrorAction SilentlyContinue |
    ForEach-Object { if ($_.Name -match "^$([regex]::Escape($spec.name))-(\d+)\.execution\.json$") { [int]$Matches[1] } } |
    Measure-Object -Maximum
  $number = 1
  if ($null -ne $prior.Maximum) { $number = [int]$prior.Maximum + 1 }
  $runName = "$($spec.name)-$($number.ToString('D2'))"
  $stdout = Join-Path $logs "$runName.stdout.log"
  $stderr = Join-Path $logs "$runName.stderr.log"
  $executionPath = Join-Path $logs "$runName.execution.json"
  $commandPath = Join-Path $commands "$runName.json"
  $command = [ordered]@{
    name = $runName
    cwd = $worktree
    executable = $node
    argv = $spec.argv
    environment_overrides = [ordered]@{
      PATH_prefix = "E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\bin;$nodeDir"
      P01_U07_ZCODE_SOURCE = $sourceRoot
    }
    reference_roots = @(
      @{ path = "E:\Xiadie\Xiadie\references\zcode-29628c9"; commit = "29628c9acdb81b703bbd4080c207a0e7ce5e276e" },
      @{ path = $sourceRoot; commit = "29628c9acdb81b703bbd4080c207a0e7ce5e276e" }
    )
    raw_stdout = "evidence/P01-U07/20261002-01/logs/$runName.stdout.log"
    raw_stderr = "evidence/P01-U07/20261002-01/logs/$runName.stderr.log"
  }
  $command | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $commandPath -Encoding utf8
  $started = [DateTime]::UtcNow
  $argumentLine = ($spec.argv | ForEach-Object { if ($_ -match "\s") { '"' + $_.Replace('"', '\"') + '"' } else { $_ } }) -join " "
  if ($spec.argv[0] -eq $testRunner) {
    $actualArguments = '"' + $spec.argv[0] + '" ' + (($spec.argv | Select-Object -Skip 1) -join " ")
  } else {
    $actualArguments = $argumentLine
  }
  $process = Start-Process -FilePath $node -ArgumentList $actualArguments -WorkingDirectory $worktree -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $finished = [DateTime]::UtcNow
  $stdoutHash = (Get-FileHash -LiteralPath $stdout -Algorithm SHA256).Hash.ToLowerInvariant()
  $stderrHash = (Get-FileHash -LiteralPath $stderr -Algorithm SHA256).Hash.ToLowerInvariant()
  [ordered]@{
    name = $runName
    started_at_utc = $started.ToString("o")
    finished_at_utc = $finished.ToString("o")
    duration_ms = [math]::Round(($finished - $started).TotalMilliseconds)
    cwd = $worktree
    executable = $node
    argv = $spec.argv
    exit_code = $process.ExitCode
    stdout_path = "evidence/P01-U07/20261002-01/logs/$runName.stdout.log"
    stdout_bytes = (Get-Item -LiteralPath $stdout).Length
    stdout_sha256 = $stdoutHash
    stderr_path = "evidence/P01-U07/20261002-01/logs/$runName.stderr.log"
    stderr_bytes = (Get-Item -LiteralPath $stderr).Length
    stderr_sha256 = $stderrHash
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $executionPath -Encoding utf8
  Write-Output "$runName exit=$($process.ExitCode) stdout=$stdout stderr=$stderr"
  if ($process.ExitCode -ne 0) { exit $process.ExitCode }
}
