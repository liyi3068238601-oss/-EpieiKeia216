$ErrorActionPreference = 'Stop'
$worktree = 'E:\Xiadie\Xiadie\.runtime\P02\worktrees\mature-sqlite-spike'
$runRoot = 'E:\Xiadie\Xiadie\.runtime\P02\reviews\mature-sqlite-u02\independent-01'
$node = 'E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64\node.exe'
$script = Join-Path $worktree 'spikes\P02\mature-sqlite\mature-sqlite-spike.mjs'
$dataRoot = Join-Path $runRoot 'data'
$result = Join-Path $runRoot 'spike-result.json'
$nodeV1Db = 'E:\Xiadie\Xiadie\.runtime\P02\experiments\completion-u10\full-01\scenarios\success\profile\plugin-storage\data\xiadie@xiadie-local\event-ledger.sqlite'
$stdoutPath = Join-Path $runRoot 'stdout.jsonl'
$stderrPath = Join-Path $runRoot 'stderr.txt'
$recordPath = Join-Path $runRoot 'command.json'
if (Test-Path -LiteralPath $runRoot) { throw 'independent-01 already exists; refusing to overwrite' }
New-Item -ItemType Directory -Path $runRoot | Out-Null
$started = [DateTimeOffset]::UtcNow
Push-Location $worktree
try {
  & $node $script '--data-root' $dataRoot '--result' $result '--node-v1-db' $nodeV1Db 1> $stdoutPath 2> $stderrPath
  $exitCode = $LASTEXITCODE
} finally { Pop-Location }
$ended = [DateTimeOffset]::UtcNow
$stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -Raw -LiteralPath $stdoutPath } else { '' }
$stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { '' }
$hashBytes = { param($p) (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() }
$record = [ordered]@{
  argv = @($node, $script, '--data-root', $dataRoot, '--result', $result, '--node-v1-db', $nodeV1Db)
  cwd = $worktree
  started_at_utc = $started.ToString('o')
  completed_at_utc = $ended.ToString('o')
  exit_code = $exitCode
  stdout = $stdout
  stderr = $stderr
  result_path = $result
  result_sha256 = if (Test-Path -LiteralPath $result) { & $hashBytes $result } else { $null }
  stdout_sha256 = if (Test-Path -LiteralPath $stdoutPath) { & $hashBytes $stdoutPath } else { $null }
  stderr_sha256 = if (Test-Path -LiteralPath $stderrPath) { & $hashBytes $stderrPath } else { $null }
}
$record | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $recordPath -Encoding utf8
Get-Content -Raw -LiteralPath $recordPath
exit $exitCode
