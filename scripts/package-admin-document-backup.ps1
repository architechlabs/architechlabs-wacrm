# Converts a verified local DPAPI export to a portable AES-256-GCM Drive package.
# Does not upload, restore, contact Supabase or change any production settings.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BackupDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$projectRef='nthvtmzvmjiowvjgitmv'
$localData=[Environment]::GetFolderPath('LocalApplicationData')
$root=Join-Path $localData ('ArchitechLabs\Backups\supabase\'+$projectRef)
$source=[IO.Path]::GetFullPath($BackupDirectory)
if (-not $source.StartsWith([IO.Path]::GetFullPath($root)+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected backup source.' }
$entropy=[Text.Encoding]::UTF8.GetBytes('ArchitechLabs/database-backup/v1/'+$projectRef)
$allowed=@('roles.sql','schema.sql','data.sql','managed-schema.sql','managed-data.sql')
try {
    $sourceManifest=Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw | ConvertFrom-Json
    if ($sourceManifest.projectRef -ne $projectRef -or $sourceManifest.encryption -ne 'Windows-DPAPI-CurrentUser' -or
        -not $sourceManifest.exportComplete -or -not $sourceManifest.integrityVerified -or $sourceManifest.files.Count -ne 5) {
        throw 'Source export is not verified/complete.'
    }
    $id=[guid]::NewGuid().ToString('N')
    $package=Join-Path $source ('portable-drive-'+$id)
    $keyDirectory=Join-Path $localData ('ArchitechLabs\BackupKeys\supabase\'+$projectRef+'\'+$id)
    New-Item -ItemType Directory -Path $package | Out-Null
    New-Item -ItemType Directory -Path $keyDirectory | Out-Null
    # A separate private directory prevents accidentally uploading the key with
    # the encrypted package. Do not upload the BackupKeys directory to Drive.
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
    foreach ($principal in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    }
    Set-Acl -LiteralPath $keyDirectory -AclObject $acl
    $keyFile=Join-Path $keyDirectory 'recovery-key.json'
    & node.exe (Join-Path $PSScriptRoot 'backup-envelope.mjs') init-key $keyFile
    if ($LASTEXITCODE -ne 0) { throw 'Recovery key creation failed.' }
    $manifest=[ordered]@{
        version=1;projectRef=$projectRef;encryption='AES-256-GCM';createdAtUtc=[DateTime]::UtcNow.ToString('o')
        requestedDriveAccount='amit@architechlabs.in';uploadVerified=$false;restoreTested=$false
        keyRecoveryOffDeviceVerified=$false;storageObjectsIncluded=$false;platformSecretsIncluded=$false
        scope=$sourceManifest.scope;files=@()
    }
    $seen=@{}
    foreach ($file in $sourceManifest.files) {
        $name=$file.name -replace '\.dpapi$',''
        if ($name -notin $allowed -or $file.name -ne $name+'.dpapi' -or $seen.ContainsKey($name)) { throw 'Unexpected source file inventory.' }
        $seen[$name]=$true
        $protected=[IO.File]::ReadAllBytes((Join-Path $source $file.name))
        $sha=[Security.Cryptography.SHA256]::Create()
        try { $encryptedHash=([BitConverter]::ToString($sha.ComputeHash($protected))).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if ($encryptedHash -ne $file.encryptedSha256) { throw 'Source checksum mismatch.' }
        $plain=[Security.Cryptography.ProtectedData]::Unprotect($protected,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $plainPath=Join-Path $package $name
        try {
            [IO.File]::WriteAllBytes($plainPath,$plain)
            $result=& node.exe (Join-Path $PSScriptRoot 'backup-envelope.mjs') seal $plainPath ($plainPath+'.enc') $keyFile
            if ($LASTEXITCODE -ne 0) { throw 'Portable encryption failed.' }
            $entry=$result | ConvertFrom-Json
            if ($entry.plaintextSha256 -ne $file.plaintextSha256 -or $entry.plaintextBytes -ne $file.plaintextBytes) { throw 'Source plaintext verification failed.' }
            $manifest.files += $entry
            # Exact newly generated plaintext only, after authenticated round-trip.
            Remove-Item -LiteralPath $plainPath
        } finally { [Array]::Clear($plain,0,$plain.Length) }
    }
    $manifestPath=Join-Path $package 'manifest.json'
    [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
    & node.exe (Join-Path $PSScriptRoot 'backup-envelope.mjs') verify $package $keyFile $manifestPath
    if ($LASTEXITCODE -ne 0) { throw 'Portable package verification failed.' }
    Write-Output ('Portable encrypted package: '+$package)
    Write-Output ('Separate PRIVATE recovery key: '+$keyFile)
    Write-Output 'Upload only the portable package. Keep its recovery key separately; do not paste it in chat or upload it alongside the backup.'
    Write-Output 'No Drive upload or restore test has been performed.'
} catch {
    Write-Output 'Portable packaging did not complete. Private partial files are retained; do not upload them or claim recovery readiness.'
    exit 1
}
