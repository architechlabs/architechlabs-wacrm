# Database backup receipt - 2026-10-13

Status: encrypted local logical export created and verified. **NOT uploaded to
Drive; NOT restore-tested; NOT approval to migrate or enable production.**

## Verified target and export

- Project: `nthvtmzvmjiowvjgitmv` / Architechlabs Local, Seoul, PostgreSQL 17.6.
- Authenticated CLI 2.120.0 and Supabase project tools are now available. The
  earlier access blocker is resolved; no credentials were displayed/copied.
- Supabase's backup inventory reported no retained physical backups, PITR OFF.
- Docker Desktop was started to run the read-only CLI export containers. An
  existing local Supabase container resumed with Docker; it was not modified.
- Roles, application schema, public data, explicit managed schemas and managed
  data were exported. Managed schemas include Auth, Storage metadata, migration
  history, Vault, Realtime and extension/GraphQL schemas. Export files are not
  customer-row results printed into the chat.
- Each local SQL file was encrypted with Windows DPAPI CurrentUser. Decryption,
  plaintext length/SHA-256 and encrypted SHA-256 were verified. Newly generated
  plaintext files were removed only after encryption/recovery verification.
- A second portable AES-256-GCM package was generated with randomized nonces and
  authenticated project/filename identities. All five files were decrypted and
  hash/length checked again; the key is in a separate private directory.
- Backup/key directories grant access only to the current Windows user and SYSTEM.
  The repository contains only backup tooling/notes, not database contents/keys.

Local DPAPI export:

`C:\Users\amitk\AppData\Local\ArchitechLabs\Backups\supabase\nthvtmzvmjiowvjgitmv\20261013T055924Z-482c6ae8383f4e97a0029de2ec638340`

Portable package to upload to the requested Drive account `amit@architechlabs.in`:

`C:\Users\amitk\AppData\Local\ArchitechLabs\Backups\supabase\nthvtmzvmjiowvjgitmv\20261013T055924Z-482c6ae8383f4e97a0029de2ec638340\portable-drive-ac6dc150893d4f84a24c2afd9b435484`

Separate recovery key (SECRET; never paste in chat, commit, or upload with backup):

`C:\Users\amitk\AppData\Local\ArchitechLabs\BackupKeys\supabase\nthvtmzvmjiowvjgitmv\ac6dc150893d4f84a24c2afd9b435484\recovery-key.json`

The portable package contains only five `.sql.enc` files and `manifest.json`.
The manifest still records `uploadVerified=false`, `restoreTested=false` and
`keyRecoveryOffDeviceVerified=false`. These must not be changed merely because
the export or local cryptographic verification succeeded.

## Required next steps

1. Install/connect Google Drive using `amit@architechlabs.in`; that connection
   is not confirmed available in this session. Verify the actual account before
   uploading. Use a private backup folder, not a public/shared-link destination.
2. Upload **only the portable package**, not its parent directory or BackupKeys.
   Verify uploaded object sizes/hashes by downloading and checking the encrypted
   files. Do not upload or email plaintext SQL or the recovery key.
3. Store the recovery key separately in an approved password manager or separately
   protected recovery location. Confirm it can be recovered without this Windows
   profile. DPAPI alone is user/machine-bound, not an independent disaster-recovery
   solution; the portable package also requires its separate key.
4. Restore-test in an isolated, explicitly approved Supabase-compatible environment.
   Never point a test restore at production or the existing local user database.
   Review schema dependencies, managed-schema customizations, roles, triggers,
   RLS/grants, FKs and Realtime publications. The exports were separate CLI
   invocations, not a shared exported PostgreSQL snapshot across all five files;
   strict cross-file transactional consistency has not been certified.
5. Only after recovery is verified, stage the reviewed same-Inbox document changes.
   Do not apply obsolete 045, blindly push migrations, drop guards/keys or enable
   any document/queue/API/frontend switch based on this backup receipt alone.

## Scope limitations and retained partial attempts

- This is a logical database export, not a full platform/physical disaster-recovery
  image. Storage object binaries, Edge Function/runtime secrets/configuration,
  custom role passwords and platform encryption root keys require separate
  protected recovery. Vault/column ciphertext may be unusable without its original
  keys. Existing Desk application encryption configuration must also be preserved.
- Do not blindly run both schema/data pairs against a live database. Supabase
  managed schemas and their customizations require a reviewed restore sequence.
- Two earlier incomplete export attempts are retained in the private backup root,
  with incomplete manifests/`.partial.dpapi` files. They are not complete backups.
  One failed before exporting; another rejected valid CLI `CREATE TABLE IF NOT
  EXISTS` syntax during the coverage check. The check was fixed and the complete
  export above was recreated. No production schema fix or relaxed backup check
  was used to obtain the successful export.

Official references: [Supabase CLI backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
and [backup scope/Free-plan guidance](https://supabase.com/docs/guides/platform/backups).

## Development and read-only production findings

Live catalog checks found existing messages/RLS/service access present; all new
document fields, guards/index/shape constraint and TRUNCATE restriction are absent.
Migration history ends with the existing `auth_access_context` change after 044;
neither 045 nor the same-Inbox draft 046 was applied. The membership helper binds
to `auth.uid()` but is callable by anon; application roles cannot CREATE in public.
No access-control grants were changed. Further hardening requires separate review.

Local development aligned Meta media ID validation with the reviewed 40-digit
database limit and rejects invalid send/download IDs before provider access.
Focused transport/queue/PostgreSQL regression tests: 63 passed. The full Node 20
suite subsequently passed **1,103 tests in 111 files**. Typecheck, focused lint and
diff whitespace checks passed. Two backup envelope tests under Node 20 cover
round-trip/randomization, tampering, wrong keys and file substitution. Both
PowerShell helpers passed syntax parsing, and actual export/package verification
passed without printing SQL contents, recovery keys or provider credentials.
No real document was sent and no application production feature was enabled.
