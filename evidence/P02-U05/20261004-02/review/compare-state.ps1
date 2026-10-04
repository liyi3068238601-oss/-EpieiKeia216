$ErrorActionPreference = 'Stop'
$base = 'E:\Xiadie\Xiadie\.runtime\P02\reviews\mature-sqlite-store-u05'
$root = 'E:\Xiadie\Xiadie'
$started = [DateTimeOffset]::UtcNow.ToString('o')
$pre = Get-Content "$base\state-before.json" -Raw | ConvertFrom-Json
$built = Get-Content "$base\state-postbuild.json" -Raw | ConvertFrom-Json
$post = Get-Content "$base\state-after.json" -Raw | ConvertFrom-Json
function table($items) {
  $result = @{}
  foreach ($item in $items) { $result[$item.path] = "$($item.bytes)|$($item.sha256)|$($item.missing)" }
  return $result
}
$diffs = @()
foreach ($field in @('authorInputs', 'baselineInputs', 'installMetadata')) {
  $left = table $pre.$field
  $right = table $post.$field
  foreach ($key in $left.Keys) { if (-not $right.ContainsKey($key) -or $left[$key] -ne $right[$key]) { $diffs += "$($field):$key" } }
  foreach ($key in $right.Keys) { if (-not $left.ContainsKey($key)) { $diffs += "$($field):$key (new)" } }
}
$treesStable = ($pre.packageTrees.betterSqlite3.sha256 -eq $post.packageTrees.betterSqlite3.sha256) -and
               ($pre.packageTrees.betterSqlite3Types.sha256 -eq $post.packageTrees.betterSqlite3Types.sha256) -and
               ($pre.packageTrees.nodeAddonApi.sha256 -eq $post.packageTrees.nodeAddonApi.sha256)
$addonStable = ($pre.runtime.loadedAddons[0].sha256 -eq $post.runtime.loadedAddons[0].sha256) -and
               ($pre.runtime.loadedAddons[0].bytes -eq $post.runtime.loadedAddons[0].bytes)
$nodeStable = ($pre.runtime.executableFile.sha256 -eq $post.runtime.executableFile.sha256) -and
              ($pre.runtime.executableFile.bytes -eq $post.runtime.executableFile.bytes) -and
              ($pre.runtime.processVersions.node -eq $post.runtime.processVersions.node)
$compiledPreBuildSame = ($pre.compiledTree.sha256 -eq $built.compiledTree.sha256) -and
                        ($pre.compiledTree.bytes -eq $built.compiledTree.bytes)
$compiledBuildTestSame = ($built.compiledTree.sha256 -eq $post.compiledTree.sha256) -and
                         ($built.compiledTree.bytes -eq $post.compiledTree.bytes) -and
                         ($built.compiledTree.files -eq $post.compiledTree.files)
$result = [ordered]@{
  schema = 'p02-u05-review-snapshot-comparison/v1'
  command = @{ argv = @('powershell', '-File', "$base\compare-state.ps1"); cwd = $root }
  started_at = $started
  completed_at = [DateTimeOffset]::UtcNow.ToString('o')
  authorHeadPrePost = @($pre.authorGit.head.stdout, $post.authorGit.head.stdout)
  rootHeadPrePost = @($pre.baselineGit.head.stdout, $post.baselineGit.head.stdout)
  authorCleanPrePost = @([string]::IsNullOrWhiteSpace($pre.authorGit.status.stdout), [string]::IsNullOrWhiteSpace($post.authorGit.status.stdout))
  rootCleanPrePost = @([string]::IsNullOrWhiteSpace($pre.baselineGit.status.stdout), [string]::IsNullOrWhiteSpace($post.baselineGit.status.stdout))
  sourceAndInputMismatches = @($diffs)
  installedPackageTreesStable = $treesStable
  loadedAddonStable = $addonStable
  fixedNodeStable = $nodeStable
  compiledTreePreBuildToPostBuildStable = $compiledPreBuildSame
  compiledTreePostBuildToPostTestStable = $compiledBuildTestSame
  runtime = @{
    node = $post.runtime.processVersions.node
    betterSqliteVersion = $post.runtime.nativeProbe.packageVersion
    sqliteVersion = $post.runtime.nativeProbe.sqliteVersion
    fixedNodeSha256 = $post.runtime.executableFile.sha256
    addonSha256 = $post.runtime.loadedAddons[0].sha256
    addonBytes = $post.runtime.loadedAddons[0].bytes
  }
  dist = @{
    before = @{ files = $pre.compiledTree.files; bytes = $pre.compiledTree.bytes; sha256 = $pre.compiledTree.sha256 }
    postbuild = @{ files = $built.compiledTree.files; bytes = $built.compiledTree.bytes; sha256 = $built.compiledTree.sha256 }
    aftertests = @{ files = $post.compiledTree.files; bytes = $post.compiledTree.bytes; sha256 = $post.compiledTree.sha256 }
  }
  result = if ($diffs.Count -eq 0 -and $treesStable -and $addonStable -and $nodeStable -and
               $compiledPreBuildSame -and $compiledBuildTestSame -and
               $pre.authorGit.head.stdout -eq $post.authorGit.head.stdout -and
               $pre.baselineGit.head.stdout -eq $post.baselineGit.head.stdout -and
               [string]::IsNullOrWhiteSpace($post.authorGit.status.stdout) -and
               [string]::IsNullOrWhiteSpace($post.baselineGit.status.stdout)) { 'pass' } else { 'fail' }
}
$json = $result | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText("$base\state-comparison.json", $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Output $json
