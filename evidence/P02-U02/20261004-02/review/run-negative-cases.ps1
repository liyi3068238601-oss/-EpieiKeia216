$ErrorActionPreference='Stop'
$node='E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64\node.exe'
$root='E:\Xiadie\Xiadie\.runtime\P02\reviews\mature-sqlite-u02'
$script=Join-Path $root 'reviewer-negative-cases.mjs'
$stdoutPath=Join-Path $root 'negative-stdout.jsonl'
$stderrPath=Join-Path $root 'negative-stderr.txt'
$recordPath=Join-Path $root 'negative-command.json'
if (Test-Path -LiteralPath $recordPath) { throw 'negative command record already exists' }
$started=[DateTimeOffset]::UtcNow
Push-Location $root
try {
  & $node $script 1> $stdoutPath 2> $stderrPath
  $exitCode=$LASTEXITCODE
} finally { Pop-Location }
$ended=[DateTimeOffset]::UtcNow
$sha = { param($p) (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() }
$record=[ordered]@{
  argv=@($node,$script)
  cwd=$root
  started_at_utc=$started.ToString('o')
  completed_at_utc=$ended.ToString('o')
  exit_code=$exitCode
  stdout_sha256=& $sha $stdoutPath
  stderr_sha256=& $sha $stderrPath
  result_path=(Join-Path $root 'negative-result.json')
  result_sha256=& $sha (Join-Path $root 'negative-result.json')
  addon_path='E:\Xiadie\Xiadie\.runtime\P02\experiments\mature-sqlite-spike\install\node_modules\.pnpm\better-sqlite3@13.0.3\node_modules\better-sqlite3\prebuilds\win32-x64.node'
  addon_sha256=& $sha 'E:\Xiadie\Xiadie\.runtime\P02\experiments\mature-sqlite-spike\install\node_modules\.pnpm\better-sqlite3@13.0.3\node_modules\better-sqlite3\prebuilds\win32-x64.node'
}
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $recordPath -Encoding utf8
Get-Content -Raw -LiteralPath $recordPath
exit $exitCode
