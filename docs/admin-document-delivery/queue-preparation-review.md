# Queued document delivery release

Latest verified state: [2026-10-14 resume receipt](resume-2026-10-14.md).
The private Supabase bucket, existing Inbox schema and three approved PDF policies
are verified; the Desk/consumer runtime fix is deployed with switches OFF.
Older preparation-only and migration-pending statements below are historical.

## Current rollout — 2026-10-13

The user authorized production deployment and deferred backup upload and the
proforma template. R2 is not enabled on the Cloudflare account (API error 10042).
The sender now also supports the existing Supabase project's private storage:
`ADMIN_DOCUMENT_PAYLOAD_STORAGE=supabase`. The `admin-document-payloads` bucket
was created private with a 4,054,000-byte limit and only application/octet-stream.
Its flat listing API was verified. Existing public media buckets and their
policies are unchanged. Payloads remain encrypted, create-only, and server-only.
An authenticated private cleanup endpoint removes files older than 24 hours;
the isolated consumer schedules it hourly, including after sending is disabled.

Queues `architech-admin-documents` (one-hour retention) and
`architech-admin-documents-dlq` (one-day retention) were created. The DLQ has no
consumer. Deployment manifests keep sending disabled until integration acceptance.
The focused storage/queue tests passed; the actual Next/OpenNext build completed.
No production database migration or real message send has occurred at this point.
The historical notes below describe earlier preparation and are superseded where
they say storage must use R2, resources do not exist, or authentication is unavailable.

2026-10-13 follow-up: authenticated Supabase CLI/MCP access is now available.
A local encrypted database export and portable encrypted Drive package were
created and cryptographically verified. Drive upload, off-device recovery-key
storage and isolated restore acceptance are still pending; see
`backup-and-recovery.md`. The database schema/feature flags were not activated.

The user subsequently requested testing and production launch. This supersedes the
earlier local-preparation-only request, but does not waive the release gates below.
No queues, bucket, Worker, secrets, database migration, production settings or real
messages have been created/changed by this preparation. Production remains OFF.

## Prepared components

- `src/lib/document-delivery/queue.ts`: reserve one existing Inbox `messages` row,
  persist encrypted PDF/template input, publish a small identifier-only job and
  return `queued` (not `accepted`, `delivered` or `read`). Duplicate or uncertain
  submissions never automatically republish.
- `queue-payloads.ts`: AES-256-GCM payload encryption using a new dedicated key,
  random IVs, authenticated job identity/timestamps, bounded reads and conditional
  write-once private R2 objects. No customer data or PDF bytes enter the queue.
- `queue-claims.ts`: an account/id/fingerprint-scoped atomic permanent claim on
  the existing message. No new outbox/inbox table is introduced.
- `queue-worker.ts`: an isolated queue consumer with a fixed private Desk service
  binding. It carries no Supabase credentials, Meta token or document API key and
  has no public HTTP functionality. Independent worker authorization is checked
  again in the Desk's default-OFF internal processing route.
- `src/app/api/internal/admin-document-deliveries/process/route.ts`: rechecks
  account, originating API-key validity/scope, policy snapshot, PDF/fingerprint,
  live Meta template, current recipient/template restrictions and permanent claim
  before the existing upload/send path.
  It returns empty sanitized responses, not provider/credential details.
- `infra/admin-document-queue.worker.example.jsonc`: review-only isolated consumer
  configuration, OFF by default, batch/concurrency one, zero configured retries
  and a separate dead-letter queue (DLQ).
- `infra/admin-document-producer.bindings.example.jsonc`: nondeployable binding
  snippet, not a replacement for the existing Desk Wrangler configuration.

Cloudflare Queues provides [at-least-once delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
not exactly-once delivery. The database claim is the send boundary; zero configured
retries alone is insufficient. After a claim, a worker crash, timeout, DB failure
or ambiguous Meta result is held for operator reconciliation. A claim has no lease
expiry and must not be cleared/reused to authorize a second send. Failed processing
goes to the DLQ for review; **do not attach a consumer or automatically replay it**.
This trades automatic recovery for avoiding duplicate financial documents. It is
not a guarantee that every queued document is sent.

Job expiry is one hour; expired jobs are held before provider access. Queue retention
and one-day R2 lifecycle deletion require separate review and explicit provisioning.
`customMetadata.expiresAt` does **not** cause R2 deletion. Accepted objects are deleted
best effort; a lifecycle rule is required for orphaned/uncertain objects. Lifecycle
deletion is not an exact one-hour erasure guarantee. Review DLQ retention separately.
See [Queue configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)
and [R2 object lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

The existing **unapplied** migration 046 draft now includes a seventh nullable
`admin_document_claim_id` field with a server-only, one-time claim guard. Existing
ordinary message CRUD/RLS is unchanged in synthetic PostgreSQL tests. If any other
environment has already applied an earlier 046, do not rerun/edit migration history:
prepare a separately numbered, reviewed incremental migration. Obtain backup and
recovery capability before any production DDL. Do not apply obsolete migration 045.

## Local connection update - 2026-10-12

The public POST now calls the producer only when BOTH document and queue switches
are ON. There is no synchronous fallback. It validates private bindings before
reserving an Inbox message; it no longer loads Meta credentials in the request.
Capabilities advertise `mode: queued` only with both flags and valid bindings.
The admin bridge refuses an older synchronous capability response and accepts
only a new `queued` result or an already-accepted duplicate. The dashboard shows
queued/pending, accepted and held outcomes separately; refreshing never resends.

Admin sends share a ten-second bridge deadline beginning in the mutation hook,
with each external request capped at six seconds including key lookup. Standalone
capability lookup has a four-second budget. This prevents the previous 27-second
per-call allowance; it does not prove cold-start/DB/rendering/gateway performance
inside the fifteen-second Lambda. Live timing acceptance is still required.

Root Wrangler configuration, production deploy scripts, AWS runtime and frontend
release flags remain unchanged. Turning on a flag is still not sufficient/safe.
Cloudflare OAuth access was verified read-only. AWS/Supabase CLI authentication
and browser sessions are unavailable in this session. A Supabase integration was
found and offered, but is not confirmed connected. No secret value was retrieved.
The approved internal test recipient was provided by the user; no test was sent.

Remaining implementation/release review:

1. Agree exact staging resources, Cloudflare account, data-location requirements,
   hosting charges, private bucket access (no r2.dev/custom domain/CORS exposure),
   lifecycle/queue/DLQ retention, and least-privilege operator access. No credentials
   should be sent in chat. Use independent payload and worker-auth keys in secret
   bindings; do not reuse the Meta encryption key or browser-expose either secret.
   Review key rotation before accepting jobs: replacing a payload key while jobs
   remain pending makes those objects unreadable and holds their claimed attempts.
2. Review/stage the locally wired queued producer and matching API/UI protocol.
   Test the real service bindings and status transitions. A protected Inbox row initially has `sending` status; it
   is not proof of Meta acceptance. Do not enable synchronous and queued paths
   together or allow the generic composer to retry these protected messages.
3. Load-test the shared bridge deadline: current 15-second Lambda deadline still
   includes cold starts, authentication, secret retrieval, capability lookup,
   PDF/database work and queue POST. Test large
   allowed PDFs, cold starts and ambiguous enqueue acknowledgements.
4. Stage backup + 046/index/constraint review, effective RLS/realtime/claims testing,
   and existing Inbox/webhook regression checks. Resolve early status webhooks that
   arrive before wamid persistence; current webhook handling is unchanged.
5. Verify live approved templates with exact WABA/ID/body/maps. Quotation has an
   example only. The supplied payment-received tax text is blocked without payment
   proof; proforma requires its own approved neutral Utility/Document template.
6. Review the AWS OFF-adoption/drift guard and all deployment manifests. Provision
   only after prerequisites/resource review, with switches OFF. Then test service bindings,
   Node crypto/R2 behavior in the real Cloudflare runtime, duplicate deliveries,
   worker termination at each external boundary, DLQ handling, cleanup and an
   explicitly approved internal recipient. Unit tests are not production acceptance.
7. Review retention/privacy effects and manual reconciliation procedure before
   activation. Rollback disables producers/consumer and retains protected rows;
   do not clear claims/keys or replay jobs. Existing accepted PDF access should
   remain authenticated and available according to the reviewed retention policy.

This is a local implementation package for review, not a claim that WhatsApp
document delivery is functional in production.

## Local verification - 2026-10-12

Latest queued-connection checks (review completed 2026-10-13): Desk **1,102 tests /
111 files** passed under Node 20; typecheck and Next production build passed with
synthetic settings and both switches OFF. Full lint: zero errors, 34 existing
warnings. Backend **322 passed, 1 skipped**, plus **7 deployment-guard
tests passed**, under Node 24; typecheck/lint/build and handler-load passed.
Dashboard **157 tests / 21 files**, default-OFF and gated-ON production builds passed.
Earlier verification below describes the previous preparation revision; final
live edge acceptance remains pending. These are local/synthetic checks, not a
live send or proof of the effective production schema/permissions.

Read-only production check still returned `enabled: false` and zero policies.
Latest deployment inventory showed `a1dffc79-4c43-468f-9b69-68424f82b0a3` at 100%,
after the earlier disabled foundation deployment. Do not assume the earlier
foundation version is still current or overwrite intervening console changes.

- Full Node 20 suite: **1,099 tests passed in 111 files** using
  `npm exec --yes --package=node@20 -- node node_modules/vitest/vitest.mjs run --maxWorkers=1 --testTimeout=15000`.
  Includes new producer/consumer, encryption/tamper/size, default-OFF/auth/scoping,
  expired/revoked key, changed restriction, concurrent/permanent claim, uncertain
  result, cleanup-failure and PostgreSQL claim/ordinary-CRUD regression tests.
- `npm run typecheck` passed; full lint has zero errors and 34 existing warnings.
  The first lint run accidentally included generated dry-run bundle output under
  `infra/.wrangler`; only that generated output was moved into the existing ignored
  root `.wrangler` directory and lint was rerun successfully. No lint rules were
  weakened or source files removed to obtain the pass.
- Final Next 16.2.12 production build passed under Node 20 with synthetic public
  Supabase/crypto settings and both document/queue switches OFF. No real account
  settings were loaded. The existing middleware deprecation warning remains.
  OpenNext/live Cloudflare runtime acceptance for this revision is still pending.
- Isolated Wrangler **dry run** passed with the review-only example config:
  `wrangler deploy --dry-run --no-autoconfig --config infra/admin-document-queue.worker.example.jsonc --outdir <absolute-ignored-local-output-directory>`.
  It exited without upload/provisioning. The metadata-only consumer bundle is
  2.75 KiB (gzip 1.23 KiB); its PDF-processing dependencies stay inside Desk.
  This validates bundling/config syntax, not remote resource existence or live
  queue/service-binding/R2 behavior. No production config was substituted.
- The existing production deployment/settings and Supabase schema were not changed;
  no real credentials were retrieved, and no customer upload/send was performed.
  Known existing dependency audit findings and early-webhook reconciliation remain
  release gates documented in the main readiness notes.
