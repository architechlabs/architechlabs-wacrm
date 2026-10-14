param([switch]$Apply)
# Pins reviewed live template definitions only; never rotates credentials or enables sends.
$ErrorActionPreference='Stop'
$policyPath='docs/admin-document-delivery/document-templates.production.json'
$accountId='90e47f37-19d5-4fb8-94f8-8c2df7599f7e'
$policies=Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
$live=& powershell -NoProfile -File scripts/inspect-document-templates.ps1 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or @($policies).Count -ne 3 -or @($live).Count -ne 3) { throw 'Template inspection failed' }
foreach ($policy in $policies) {
  $matches=@($live | Where-Object { $_.name -ceq $policy.name -and $_.language -ceq $policy.language })
  if ($matches.Count -ne 1 -or $matches[0].id -cne $policy.metaTemplateId -or $matches[0].bodyText -cne $policy.bodyText -or
      $matches[0].status -cne 'APPROVED' -or $matches[0].category -cne 'UTILITY' -or $matches[0].headerFormat -cne 'DOCUMENT' -or $matches[0].hasButtons -ne $false) {
    throw 'Live template differs from the reviewed policy; configuration stopped'
  }
}
& node scripts/check-admin-document-config.mjs --account-id $accountId --templates $policyPath
if ($LASTEXITCODE -ne 0) { throw 'Runtime configuration validation failed' }
if (-not $Apply) { Write-Output 'All three policies match Meta exactly; nothing changed. Use -Apply only for an OFF configuration release.'; return }
$configPath=Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'xdg.config/.wrangler/config/default.toml'
$tokenMatch=[regex]::Match([IO.File]::ReadAllText($configPath),'(?m)^oauth_token\s*=\s*"([^"]+)"')
if (-not $tokenMatch.Success) { throw 'Cloudflare authorization unavailable' }
$headers=@{Authorization=('Bearer '+$tokenMatch.Groups[1].Value)}
try {
  $settingsUri='https://api.cloudflare.com/client/v4/accounts/f8fcf42a91f7fbf1cb89022ead312069/workers/scripts/architech-wacrm/settings'
  $before=Invoke-RestMethod -Uri $settingsUri -Headers $headers
  if (-not $before.success) { throw 'Worker inspection failed' }
  foreach ($name in @('ENABLE_ADMIN_DOCUMENT_DELIVERY','ENABLE_ADMIN_DOCUMENT_QUEUE')) {
    $binding=@($before.result.bindings | Where-Object {$_.name -ceq $name -and $_.type -ceq 'plain_text'})
    if ($binding.Count -ne 1 -or $binding[0].text -cne 'false') { throw 'Sending is not OFF; configuration stopped' }
  }
  Get-Content -LiteralPath $policyPath -Raw | npx wrangler secret put ADMIN_DOCUMENT_DELIVERY_TEMPLATES
  if ($LASTEXITCODE -ne 0) { throw 'Template configuration update failed' }
  $after=Invoke-RestMethod -Uri $settingsUri -Headers $headers
  if (-not $after.success) { throw 'Post-configuration Worker inspection failed' }
  foreach ($old in $before.result.bindings) {
    $current=@($after.result.bindings | Where-Object {$_.name -ceq $old.name -and $_.type -ceq $old.type})
    if ($current.Count -ne 1 -or ($old.type -ceq 'plain_text' -and $current[0].text -cne $old.text)) { throw 'Binding preservation failed; review before proceeding' }
  }
  Write-Output 'Configured exact quotation/proforma/tax policies; all send switches and unrelated bindings preserved.'
} finally { $headers.Clear();$tokenMatch=$null }
