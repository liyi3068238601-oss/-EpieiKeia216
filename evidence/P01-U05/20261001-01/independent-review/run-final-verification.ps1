$ErrorActionPreference = 'Stop'
$root = 'E:\Xiadie\Xiadie\.runtime\P01\worktrees\u05'
$review = 'E:\Xiadie\Xiadie\.runtime\P01\u05-review'
$logDir = Join-Path $review 'logs/final'
$expectedCommit = '96457a2ef13e697e1877bcf23deb79578422a08e'
$nodeFolder = 'E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64'
$node = Join-Path $nodeFolder 'node.exe'
$pnpm = 'E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\bin\pnpm.CMD'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:PATH = 'E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\bin;' + $nodeFolder + ';' + $env:PATH

$head = (git -C $root rev-parse HEAD).Trim()
$status = (git -C $root status --porcelain=v1 | Out-String).Trim()
if ($head -ne $expectedCommit -or $status.Length -ne 0) { throw "Frozen tree check failed: HEAD=$head clean=$($status.Length -eq 0)" }

function Invoke-Captured {
  param([string]$Label, [string]$Executable, [string[]]$Arguments)
  $stdoutRel = "logs/final/$Label.stdout.log"
  $stderrRel = "logs/final/$Label.stderr.log"
  $stdoutPath = Join-Path $review $stdoutRel
  $stderrPath = Join-Path $review $stderrRel
  $started = [DateTime]::UtcNow.ToString('o')
  Push-Location $root
  try {
    & $Executable @Arguments 1> $stdoutPath 2> $stderrPath
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  $ended = [DateTime]::UtcNow.ToString('o')
  $execution = [ordered]@{
    label = $Label
    cwd = $root
    command = (@($Executable) + $Arguments) -join ' '
    node = $node
    path_prefix = @('E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\bin', $nodeFolder)
    started_utc = $started
    ended_utc = $ended
    exit_code = $exitCode
    stdout = $stdoutRel.Replace('\','/')
    stderr = $stderrRel.Replace('\','/')
  }
  $execution | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $logDir "$Label.execution.json") -Encoding utf8
  [pscustomobject]$execution
}

$results = @()
$results += Invoke-Captured -Label 'node-version' -Executable $node -Arguments @('--version')
$results += Invoke-Captured -Label 'pnpm-version' -Executable $pnpm -Arguments @('--version')
$results += Invoke-Captured -Label 'typescript-version' -Executable $pnpm -Arguments @('exec','tsc','--version')
$build = Invoke-Captured -Label 'build' -Executable $pnpm -Arguments @('run','build')
$results += $build
if ($build.exit_code -ne 0) { throw 'Pinned TypeScript build failed; selector tests were not started.' }
$results += Invoke-Captured -Label 'check' -Executable $pnpm -Arguments @('run','check')
$results += Invoke-Captured -Label 'unit-u05' -Executable $node -Arguments @('tools/run-tests.mjs','unit','P01-U05')
$results += Invoke-Captured -Label 'contract-u05' -Executable $node -Arguments @('tools/run-tests.mjs','contract','P01-U05')
$results += Invoke-Captured -Label 'integration-u05' -Executable $node -Arguments @('tools/run-tests.mjs','integration','P01-U05')
$postHead = (git -C $root rev-parse HEAD).Trim()
$postStatus = (git -C $root status --porcelain=v1 | Out-String).Trim()
$post = [ordered]@{head=$postHead; expected_commit=$expectedCommit; clean=$postStatus.Length -eq 0; status_lines=$postStatus; pass=($postHead -eq $expectedCommit -and $postStatus.Length -eq 0)}
$post | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $logDir 'post-run-tree.json') -Encoding utf8
$results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $logDir 'commands-summary.json') -Encoding utf8
if (-not $post.pass -or ($results | Where-Object { $_.exit_code -ne 0 })) { exit 1 }
Write-Output ($results | ConvertTo-Json -Depth 6)
Write-Output (Get-Content -LiteralPath (Join-Path $logDir 'post-run-tree.json') -Raw)
