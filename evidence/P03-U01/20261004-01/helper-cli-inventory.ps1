$ErrorActionPreference = 'Stop'
$coord = 'E:\Xiadie\Xiadie\.runtime\P03\coord'
$scripts = @('baseline-unit.py','run-command.py','freeze-unit.py','diff-unit.py','verify-author.py')
foreach ($script in $scripts) {
  $path = Join-Path $coord $script
  Write-Output "argv=py -3 $path --help"
  & py -3 $path --help 2>&1
  $code = $LASTEXITCODE
  Write-Output "exit_code=$code"
  if ($code -ne 0) { exit $code }
}
