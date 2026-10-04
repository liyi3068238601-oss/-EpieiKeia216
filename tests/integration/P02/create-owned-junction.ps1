param(
  [Parameter(Mandatory = $true)][string]$Link,
  [Parameter(Mandatory = $true)][string]$Target
)

$ErrorActionPreference = "Stop"

if (Test-Path -LiteralPath $Link) {
  throw "owned_junction_path_already_exists"
}
$targetItem = Get-Item -LiteralPath $Target -ErrorAction Stop
if (-not $targetItem.PSIsContainer) {
  throw "owned_junction_target_is_not_directory"
}
New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
