param(
  [Parameter(Mandatory=$true)][ValidateSet('get','deny','restore')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Target,
  [string]$SavedDaclBase64
)

$ErrorActionPreference = 'Stop'
$sections = [System.Security.AccessControl.AccessControlSections]::Access

switch ($Action) {
  'get' {
    $acl = Get-Acl -LiteralPath $Target
    $sddl = $acl.GetSecurityDescriptorSddlForm($sections)
    [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($sddl)))
  }
  'deny' {
    $acl = Get-Acl -LiteralPath $Target
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $user,
      [System.Security.AccessControl.FileSystemRights]::ReadData,
      [System.Security.AccessControl.AccessControlType]::Deny
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Target -AclObject $acl
  }
  'restore' {
    $saved = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($SavedDaclBase64))
    $acl = Get-Acl -LiteralPath $Target
    $acl.SetSecurityDescriptorSddlForm($saved, $sections)
    Set-Acl -LiteralPath $Target -AclObject $acl
  }
}
