$ErrorActionPreference = "Stop"
$root = "E:\Xiadie\Xiadie"
$worktree = Join-Path $root ".runtime\P01\worktrees\u07-review"
$evidence = Join-Path $root ".runtime\P01\u07-review"
$logs = Join-Path $evidence "logs"
$commands = Join-Path $evidence "commands"
$nodeDir = Join-Path $root ".runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64"
$node = Join-Path $nodeDir "node.exe"
$corepack = Join-Path $nodeDir "node_modules\corepack\dist\corepack.js"
$store = Join-Path $root ".runtime\P01\pnpm-store-u04"
$source = Join-Path $root ".runtime\P00\zcode\source"
$independentTest = Join-Path $evidence "cases\native-turn-projection.review.test.mjs"
New-Item -ItemType Directory -Force -Path $logs, $commands | Out-Null
$env:COREPACK_HOME = Join-Path $root ".runtime\P01\desktop-build-evidence\corepack"
$env:COREPACK_ENABLE_NETWORK = "0"
$env:COREPACK_DEFAULT_TO_LATEST = "0"
$env:P01_U07_ZCODE_SOURCE = $source
$bin = Join-Path $root ".runtime\P01\desktop-build-evidence\bin"
$env:PATH = "$bin;$nodeDir;$env:PATH"

$specs = @(
  @{ name = "build"; executable = $node; argv = @($corepack, "pnpm@10.33.2", "run", "build") },
  @{ name = "check"; executable = $node; argv = @($corepack, "pnpm@10.33.2", "run", "check") },
  @{ name = "unit-u07"; executable = $node; argv = @("tools/run-tests.mjs", "unit", "P01-U07") },
  @{ name = "native-integration-u07"; executable = $node; argv = @("tools/run-tests.mjs", "integration", "P01-U07") },
  @{ name = "independent-counterexamples"; executable = $node; argv = @("--test", $independentTest) }
)

foreach ($spec in $specs) {
  $stdout = Join-Path $logs "$($spec.name).stdout.log"
  $stderr = Join-Path $logs "$($spec.name).stderr.log"
  $resultPath = Join-Path $commands "$($spec.name).json"
  $started = [DateTime]::UtcNow
  $argumentLine = ($spec.argv | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ }
  }) -join " "
  $process = Start-Process -FilePath $spec.executable -ArgumentList $argumentLine -WorkingDirectory $worktree -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $finished = [DateTime]::UtcNow
  $result = [ordered]@{
    name = $spec.name
    started_at_utc = $started.ToString("o")
    finished_at_utc = $finished.ToString("o")
    duration_ms = [math]::Round(($finished - $started).TotalMilliseconds)
    cwd = $worktree
    executable = $spec.executable
    argv = $spec.argv
    environment_overrides = [ordered]@{
      COREPACK_HOME = $env:COREPACK_HOME
      COREPACK_ENABLE_NETWORK = $env:COREPACK_ENABLE_NETWORK
      COREPACK_DEFAULT_TO_LATEST = $env:COREPACK_DEFAULT_TO_LATEST
      P01_U07_ZCODE_SOURCE = $source
      PATH_prefix = "$bin;$nodeDir"
    }
    exit_code = $process.ExitCode
    stdout_path = "logs/$($spec.name).stdout.log"
    stdout_bytes = (Get-Item -LiteralPath $stdout).Length
    stdout_sha256 = (Get-FileHash -LiteralPath $stdout -Algorithm SHA256).Hash.ToLowerInvariant()
    stderr_path = "logs/$($spec.name).stderr.log"
    stderr_bytes = (Get-Item -LiteralPath $stderr).Length
    stderr_sha256 = (Get-FileHash -LiteralPath $stderr -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding utf8
  Write-Output "$($spec.name) exit=$($process.ExitCode) stdout=$stdout stderr=$stderr"
}


