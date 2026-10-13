# Export only. Never restores, applies migrations, changes Auth or enables delivery.
# Run from PowerShell as the Windows user who will own the recovery material.
[CmdletBinding()]
param([switch]$VerifyOnly, [string]$BackupDirectory)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$projectRef = 'nthvtmzvmjiowvjgitmv'
$cliVersion = '2.120.0'
$entropy = [Text.Encoding]::UTF8.GetBytes('ArchitechLabs/database-backup/v1/' + $projectRef)
$backupRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('ArchitechLabs\Backups\supabase\' + $projectRef)

function Get-Digest([byte[]]$Bytes) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function Assert-BackupPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith([IO.Path]::GetFullPath($backupRoot) + '\',[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Backup path must be inside the dedicated local backup directory.'
    }
    return $full
}
function Verify-Backup([string]$Directory) {
    $directoryPath = Assert-BackupPath $Directory
    $manifest = Get-Content -LiteralPath (Join-Path $directoryPath 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.projectRef -ne $projectRef -or $manifest.encryption -ne 'Windows-DPAPI-CurrentUser' -or -not $manifest.exportComplete) {
        throw 'Backup manifest is incomplete or belongs to another project.'
    }
    if ($manifest.files.Count -ne 5) { throw 'Unexpected backup file inventory.' }
    foreach ($file in $manifest.files) {
        if ($file.name -notin @('roles.sql.dpapi','schema.sql.dpapi','data.sql.dpapi','managed-schema.sql.dpapi','managed-data.sql.dpapi')) {
            throw 'Unexpected backup filename.'
        }
        $protected = [IO.File]::ReadAllBytes((Join-Path $directoryPath $file.name))
        if ((Get-Digest $protected) -ne $file.encryptedSha256) { throw 'Encrypted backup checksum mismatch.' }
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        try {
            if ($plain.Length -ne $file.plaintextBytes -or (Get-Digest $plain) -ne $file.plaintextSha256) { throw 'Decrypted backup checksum mismatch.' }
        } finally { [Array]::Clear($plain,0,$plain.Length) }
    }
    Write-Output ('Verified encrypted export: ' + $directoryPath)
    Write-Output 'Checksums and decryption passed. This is NOT a restore test or off-site backup.'
}
function Invoke-BackupCli([string[]]$Arguments) {
    # Capture all CLI output. Do not echo credentials, SQL contents or provider errors.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $captured = & npx.cmd --yes "supabase@$cliVersion" @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -ne 0) { throw 'Supabase export failed; no complete backup is claimed. Check authentication/connectivity privately.' }
    return ($captured -join "`n")
}

try {
    $currentStage = 'preflight'
    if ($VerifyOnly) {
        if (-not $BackupDirectory) { throw 'BackupDirectory is required for verification.' }
        Verify-Backup $BackupDirectory
        exit 0
    }
    if ($BackupDirectory) { throw 'Export always creates a new unique backup directory; it never overwrites an existing export.' }
    $dockerVersion = & docker.exe version --format '{{.Server.Version}}' 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop must be running before exporting.' }
    $currentStage = 'project-inventory'
    $projectOutput = Invoke-BackupCli @('projects','list','--output-format','json')
    $projectJson = [regex]::Match($projectOutput,'(?m)^\{"projects":.*\}\s*$')
    if (-not $projectJson.Success) { throw 'Project inventory did not return the expected JSON.' }
    $projects = $projectJson.Value | ConvertFrom-Json
    $target = @($projects.projects | Where-Object { $_.id -eq $projectRef })
    if ($target.Count -ne 1 -or $target[0].name -ne 'Architechlabs Local' -or $target[0].database.postgres_engine -ne '17') {
        throw 'Project identity or database major version did not match the reviewed target.'
    }
    $currentStage = 'private-directory'
    $directoryPath = Assert-BackupPath (Join-Path $backupRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $directoryPath | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($principal in @($sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directoryPath -AclObject $acl
    $manifest = [ordered]@{
        version=1; projectRef=$projectRef; postgresVersion=$target[0].database.version; cliVersion=$cliVersion
        createdAtUtc=[DateTime]::UtcNow.ToString('o'); encryption='Windows-DPAPI-CurrentUser'
        exportComplete=$false; integrityVerified=$false; restoreTested=$false; offsiteCopyVerified=$false
        storageObjectsIncluded=$false; platformSecretsIncluded=$false
        scope='Logical roles/schema/data plus explicit managed schemas; not a physical snapshot. Preserve existing platform/encryption configuration separately.'
        files=@()
    }
    $manifestPath = Join-Path $directoryPath 'manifest.json'
    $managed = 'auth,storage,supabase_migrations,vault,realtime,extensions,graphql,graphql_public'
    $stages = @(
        @{Name='roles.sql'; Flags=@('--role-only')},
        @{Name='schema.sql'; Flags=@()},
        @{Name='data.sql'; Flags=@('--data-only','--use-copy','--schema','public')},
        @{Name='managed-schema.sql'; Flags=@('--schema',$managed)},
        @{Name='managed-data.sql'; Flags=@('--data-only','--use-copy','--schema',$managed,'--exclude','storage.buckets_vectors,storage.vector_indexes')}
    )
    foreach ($stage in $stages) {
        $currentStage = $stage.Name
        $plainPath = Assert-BackupPath (Join-Path $directoryPath $stage.Name)
        [void](Invoke-BackupCli (@('db','dump','--project-ref',$projectRef,'--file',$plainPath,'--agent','yes') + $stage.Flags))
        $plain = [IO.File]::ReadAllBytes($plainPath)
        try {
            if ($plain.Length -lt 50) { throw 'An export file was unexpectedly empty.' }
            $text = [Text.Encoding]::UTF8.GetString($plain)
            if ($stage.Name -eq 'schema.sql' -and $text -notmatch 'CREATE TABLE (?:IF NOT EXISTS )?"?public"?\."?messages"?\s*\(') { throw 'Application message schema was not included.' }
            if ($stage.Name -eq 'managed-schema.sql' -and $text -notmatch 'CREATE TABLE (?:IF NOT EXISTS )?"?auth"?\."?users"?\s*\(') { throw 'Auth schema was not included.' }
            if ($stage.Name -eq 'managed-data.sql' -and $text -notmatch 'COPY "?auth"?\."?users"?\s*\(') { throw 'Auth data export coverage was not verified.' }
            $text = $null
            $protected = [Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
            $encryptedName = $stage.Name + '.dpapi'
            [IO.File]::WriteAllBytes((Join-Path $directoryPath $encryptedName),$protected)
            $roundTrip = [Security.Cryptography.ProtectedData]::Unprotect($protected,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
            try { if ((Get-Digest $plain) -ne (Get-Digest $roundTrip)) { throw 'Backup encryption verification failed.' } }
            finally { [Array]::Clear($roundTrip,0,$roundTrip.Length) }
            $manifest.files += [ordered]@{name=$encryptedName;plaintextBytes=$plain.Length;plaintextSha256=(Get-Digest $plain);encryptedSha256=(Get-Digest $protected)}
            # Only remove the newly generated plaintext after encrypted recovery verifies.
            Remove-Item -LiteralPath $plainPath
            [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
            Write-Output ('Encrypted and verified: ' + $encryptedName)
        } finally { [Array]::Clear($plain,0,$plain.Length) }
    }
    $manifest.exportComplete=$true
    [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
    Verify-Backup $directoryPath
    $manifest.integrityVerified=$true
    [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
    Write-Output 'Keep the Windows account/profile recovery material: DPAPI files are not portable to an unrelated machine or account.'
} catch {
    # Do not print native error objects: these may contain credentials or SQL.
    # Protect any newly generated partial plaintext too; never claim it is complete.
    if (Get-Variable directoryPath -ErrorAction SilentlyContinue) {
        foreach ($partial in @(Get-ChildItem -LiteralPath $directoryPath -Filter '*.sql' -File -ErrorAction SilentlyContinue)) {
            try {
                $partialPath = Assert-BackupPath $partial.FullName
                $partialBytes = [IO.File]::ReadAllBytes($partialPath)
                $partialProtected = [Security.Cryptography.ProtectedData]::Protect($partialBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
                [IO.File]::WriteAllBytes(($partialPath + '.partial.dpapi'),$partialProtected)
                $partialCheck = [Security.Cryptography.ProtectedData]::Unprotect($partialProtected,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
                if ((Get-Digest $partialBytes) -eq (Get-Digest $partialCheck)) { Remove-Item -LiteralPath $partialPath }
                [Array]::Clear($partialBytes,0,$partialBytes.Length)
                [Array]::Clear($partialCheck,0,$partialCheck.Length)
            } catch { Write-Output 'A partial export remains in the private backup directory; inspect it privately.' }
        }
    }
    Write-Output ('Backup operation did not complete at stage: ' + $currentStage)
    Write-Output 'Production remains unchanged. Do not treat partial files as a recovery-ready backup.'
    exit 1
}
