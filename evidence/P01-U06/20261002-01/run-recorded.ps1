param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$configFile = (Resolve-Path -LiteralPath $ConfigPath).Path
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$logsDirectory = (Resolve-Path -LiteralPath $config.logsDirectory).Path
$name = [string]$config.name
$stdoutPath = Join-Path $logsDirectory "$name.stdout.log"
$stderrPath = Join-Path $logsDirectory "$name.stderr.log"
$executionPath = Join-Path $logsDirectory "$name.execution.json"
foreach ($path in @($stdoutPath, $stderrPath, $executionPath)) {
  if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite command evidence: $path" }
}

function Get-ListenerSnapshot {
  try {
    return @(
      Get-NetTCPConnection -State Listen -ErrorAction Stop |
        ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" } |
        Sort-Object -Unique
    )
  } catch {
    return @("unavailable:$($_.Exception.GetType().Name)")
  }
}

function Get-Sha256([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$startedAt = [DateTimeOffset]::UtcNow
$listenersBefore = Get-ListenerSnapshot
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = [string]$config.executable
$startInfo.WorkingDirectory = [string]$config.cwd
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
foreach ($key in @($startInfo.EnvironmentVariables.Keys)) { $startInfo.EnvironmentVariables.Remove($key) }
$passthroughKeys = @("SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PROCESSOR_ARCHITECTURE", "TEMP", "TMP")
foreach ($key in $passthroughKeys) {
  $value = [Environment]::GetEnvironmentVariable($key)
  if ($null -ne $value) { $startInfo.EnvironmentVariables[$key] = $value }
}
$startInfo.Arguments = (($config.argv | ForEach-Object { '"{0}"' -f ([string]$_) }) -join " ")
foreach ($entry in $config.env.PSObject.Properties) {
  $value = [string]$entry.Value
  $value = $value.Replace("%PATH%", $env:PATH)
  $startInfo.EnvironmentVariables[$entry.Name] = $value
}

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
try {
  if (-not $process.Start()) { throw "Process.Start returned false" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $exitCode = $process.ExitCode
  $errorMessage = $null
} catch {
  $stdout = ""
  $stderr = ""
  $exitCode = 127
  $errorMessage = $_.Exception.Message
} finally {
  $process.Dispose()
}
$completedAt = [DateTimeOffset]::UtcNow
$listenersAfter = Get-ListenerSnapshot
[System.IO.File]::WriteAllText($stdoutPath, $stdout, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($stderrPath, $stderr, [System.Text.UTF8Encoding]::new($false))

$scriptHashes = @{}
foreach ($entry in $config.inputs) {
  $inputPath = (Resolve-Path -LiteralPath ([string]$entry)).Path
  $scriptHashes[$inputPath] = Get-Sha256 $inputPath
}
$difference = Compare-Object -ReferenceObject $listenersBefore -DifferenceObject $listenersAfter
$listenerDelta = @($difference | ForEach-Object {
  [ordered]@{ endpoint = $_.InputObject; change = if ($_.SideIndicator -eq "=>") { "opened" } else { "closed" } }
})
$execution = [ordered]@{
  name = $name
  startedAtUtc = $startedAt.ToString("O")
  completedAtUtc = $completedAt.ToString("O")
  cwd = [string]$config.cwd
  executable = [string]$config.executable
  argv = @($config.argv)
  configPath = $configFile
  configSha256 = Get-Sha256 $configFile
  runnerSha256 = Get-Sha256 $PSCommandPath
  scriptSha256 = $scriptHashes
  environmentKeys = @(@($passthroughKeys | Where-Object { $null -ne [Environment]::GetEnvironmentVariable($_) }) + @($config.env.PSObject.Properties.Name) | Sort-Object -Unique)
  exitCode = $exitCode
  stdoutPath = $stdoutPath
  stdoutSha256 = Get-Sha256 $stdoutPath
  stderrPath = $stderrPath
  stderrSha256 = Get-Sha256 $stderrPath
  listenersBefore = $listenersBefore
  listenersAfter = $listenersAfter
  listenerDelta = $listenerDelta
}
if ($errorMessage) { $execution["error"] = $errorMessage }
[System.IO.File]::WriteAllText($executionPath, ($execution | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
Write-Output "name=$name exitCode=$exitCode"
Write-Output "stdout=$stdoutPath"
Write-Output "stderr=$stderrPath"
Write-Output "execution=$executionPath"
exit $exitCode
