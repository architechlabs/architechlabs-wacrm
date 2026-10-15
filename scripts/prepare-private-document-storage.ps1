$ErrorActionPreference = 'Stop'
$projectRef = 'nthvtmzvmjiowvjgitmv'
$baseUrl = 'https://nthvtmzvmjiowvjgitmv.supabase.co/storage/v1'
$bucketName = 'admin-document-payloads'
# Keep API credentials in this process only. Never print/save the CLI response.
$keyRows = & npx --yes supabase@2.120.0 projects api-keys --project-ref $projectRef --reveal --output json 2>$null | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Supabase authentication failed' }
$serviceKey = ($keyRows | Where-Object { $_.name -eq 'service_role' } | Select-Object -First 1).api_key
if ([string]::IsNullOrWhiteSpace($serviceKey)) { throw 'Service credential unavailable' }
$requestHeaders = @{ apikey = $serviceKey; Authorization = "Bearer $serviceKey" }
try {
  $buckets = Invoke-RestMethod -Uri "$baseUrl/bucket" -Headers $requestHeaders -Method Get
  $existing = @($buckets | Where-Object { $_.id -eq $bucketName })
  # Matches MAX_REQUEST_BYTES (4,030,000) plus the encrypted payload allowance.
  $sizeLimit = 4054000
  if ($existing.Count -eq 0) {
    $body = @{ id=$bucketName; name=$bucketName; public=$false; file_size_limit=$sizeLimit; allowed_mime_types=@('application/octet-stream') } | ConvertTo-Json
    $null = Invoke-RestMethod -Uri "$baseUrl/bucket" -Headers $requestHeaders -Method Post -ContentType 'application/json' -Body $body
    Write-Output 'Created dedicated private document payload bucket.'
  }
  $details = Invoke-RestMethod -Uri "$baseUrl/bucket/$bucketName" -Headers $requestHeaders -Method Get
  if ($details.public -ne $false -or [long]$details.file_size_limit -ne $sizeLimit -or @($details.allowed_mime_types).Count -ne 1 -or $details.allowed_mime_types[0] -ne 'application/octet-stream') {
    throw 'Existing document bucket does not match private storage requirements'
  }
  $listing = Invoke-RestMethod -Uri "$baseUrl/object/list-v2/$bucketName" -Headers $requestHeaders -Method Post -ContentType 'application/json' -Body '{"prefix":"admin-document-jobs/v1/","limit":1,"with_delimiter":false,"sortBy":{"column":"created_at","order":"asc"}}'
  if ($null -eq $listing.objects) { throw 'Storage cleanup API is unavailable' }
  Write-Output 'Private bucket configuration and cleanup API verified.'
} catch {
  throw 'Private document storage preparation failed; production sender remains disabled.'
} finally {
  $requestHeaders.Clear()
  $serviceKey = $null
  $keyRows = $null
}
