param([switch]$VerifyConfiguration)
# Operator-only read checks: no send, sync, database write, or flag change.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$keyPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ArchitechLabs/DeploymentKeys/admin-documents/production/secrets.dpapi'
$entropy = [Text.Encoding]::UTF8.GetBytes('ArchitechLabs/admin-document-deployment/f8fcf42a91f7fbf1cb89022ead312069')
$plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($keyPath),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
try {
  $record = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
  if ($record.workerToken -notmatch '^[0-9a-f]{64}$') { throw 'Invalid worker authorization' }
  $headers = @{Authorization=('Bearer '+$record.workerToken)}
  try {
    $method = if ($VerifyConfiguration) { 'Post' } else { 'Get' }
    $result = Invoke-RestMethod -Uri 'https://whatsapp.architechlabs.in/api/internal/admin-document-deliveries/readiness' -Headers $headers -Method $method -TimeoutSec 25
    if ($VerifyConfiguration) {
      $result | Select-Object templatesVerified,privateStorageVerified | ConvertTo-Json -Depth 5
      return
    }
    # The endpoint projects only template definitions, never approval samples or
    # credentials. Print only this fixed safe projection even on an old deployment.
    @($result.templates) | ForEach-Object {
      if ($_.template) { $_.template | Select-Object id,name,language,status,category,headerFormat,bodyText,hasButtons }
      else { $_ | Select-Object name,code }
    } | ConvertTo-Json -Depth 5
  } catch {
    $response=$_.Exception.Response
    if ($response) {
      $reader=New-Object IO.StreamReader($response.GetResponseStream())
      try { $details=$reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      if ($details.code -match '^[a-z0-9_]{1,80}$') { Write-Output ('Readiness blocked: '+$details.code) }
    }
    throw 'Live document template inspection unavailable; sending remains disabled.'
  }
} finally {
  [Array]::Clear($plain,0,$plain.Length)
  if ($headers) { $headers.Clear() }
  $record=$null
}
