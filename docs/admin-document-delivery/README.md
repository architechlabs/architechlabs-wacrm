# Admin quotation delivery configuration - NOT activated

## Latest status - 2026-10-14

Work resumed after Meta approval. The live quotation, proforma and tax templates
were independently verified as APPROVED / UTILITY / DOCUMENT in the configured
WABA, with exact IDs, bodies and variable maps. The Desk and isolated consumer
have the edge-runtime redirect fix deployed, and the three policies are configured.
Live private readiness passes for all three templates and private PDF storage.
Sending remains OFF; the matching admin API/UI changes are local, not released.
See [the current release receipt](resume-2026-10-14.md). It supersedes conflicting
historical rollout statements below; do not rerun migrations 045/046 or the index.

## Current local revision: reuse the existing Inbox

Document sending now reserves **one row in the existing `messages` table** under
the existing conversation. The same Inbox, message rendering, webhook status
updates and private PDF link are reused. There is no second inbox or outbox table.
`deliveryId` and `messageId` are both that inbox row's UUID; Meta's wamid remains
in the existing `messages.message_id` column. API response fields stay compatible.

The full account-scoped document key, fingerprint, recipient, consent timestamp,
PDF hash and approval identity are protected nullable message fields. Ordinary
messages retain NULL fields and their existing RLS/send/edit/delete behavior.
Do not reuse `client_request_id` for documents: the ordinary composer can retry
failed attempts; an uncertain financial-document attempt must not be retried.

**This revision is local only, not deployed, migrated or activated.** No customer
message or PDF has been sent. Production retains the previously deployed OFF
foundation below. Do not apply migration 045 or use a blanket `supabase db push`.
The user's six false outbox checks mean that obsolete table is absent, not that
existing inbox permissions are broken.

`quotation-templates.example.json` records the quotation body supplied by the
user on 2026-10-12 and the positional mapping confirmed in Meta's Edit screen.
It contains no customer samples, PDF bytes, company confidential information or
credentials. Nothing imports this file into the application automatically.

The template name is `quotation_pdf`, language `en_US`, with a Document header.
Its exact Meta approval, category, body and owning WABA still need live verification.
The template ID placeholder is deliberately invalid: do not replace it with a
guess or a template sample/media ID. The runtime rejects the placeholder if
someone accidentally tries to enable this example unchanged.

## Ordered body parameters

1. `customerName`
2. `documentNumber`
3. `documentDate`
4. `project`
5. `amount` (formatted with `INR` by the admin API)
6. `validUntil`

The server reads these from the saved quotation and renders its PDF. The sample
values used for Meta approval are not customer data and are never sent as defaults.

## Safe connection sequence

1. Review and deploy the WhatsApp Desk changes **with
   `ENABLE_ADMIN_DOCUMENT_DELIVERY` absent/false**. This is a separate production
   release requiring approval; no message is sent by deployment. Preserve the
   active production baseline: live-worker inspection on 2026-10-12 confirmed the
   hardened Razorpay webhook from commits `94aa798` and `f78e5c2` is already live,
   despite GitHub main still pointing at `ea50b96`. Include those unchanged commits
   in the release so this update does not remove that existing production feature.
2. Only after that release, sign in as an owner/admin to the intended company
   account and open **Settings > API keys > New API key**. Name the key
   `Admin dashboard - document delivery`; grant **only `documents:send`**. This
   new scope will not appear in the old production release. If absent, stop - do
   not substitute a broad key or `messages:send`.
3. Store the one-time plaintext key directly in AWS Secrets Manager under
   `/architechlabs/admin/whatsapp/desk-api-key` in `ap-south-1`, as a plain secret
   string, not a JSON wrapper. Do not send the key in chat or screenshots, place
   it in frontend settings, or copy the existing Meta access token into Lambda.
4. Identify the correct Desk account UUID and read its existing WhatsApp
   configuration; retain its existing phone number, WABA and encrypted token.
   Verify the live quotation template in that WABA. Replace only the example's
   template ID with the verified Meta template ID and compare the exact body.
5. Set server-only `ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID` and
   `ADMIN_DOCUMENT_DELIVERY_TEMPLATES` (the reviewed JSON array). Keep the service
   switch **off**. Do not add tax/proforma policies until their own text/maps and
   live approval have been verified.
6. Follow the staging-first message-schema procedure below. Migration 045 is
   superseded and must NOT be applied for this revision. No production database
   schema change has been made by this work.
7. Finish narrowly scoped Lambda secret IAM and the timeout/async delivery review.
   The current 15-second Lambda timeout is insufficient for the synchronous
   worst-case upload/send budget. Do not enable the admin API or frontend first.
8. Test end-to-end with an explicitly approved internal recipient in staging,
   including template membership, duplicate protection, private PDF access,
   status webhooks and uncertain-provider outcomes. Activate the three switches
   only after those release gates pass.

No new MongoDB role/user is required. This integration reuses the WhatsApp Desk's
Meta connection and keeps its durable send reservation in Supabase.

## Remaining templates

The supplied tax template claims payment was received; this integration does not
prove payment and will reject that wording. Use a separately approved neutral
tax-invoice template. Proforma requires its own approved Utility/Document template
that explicitly says it is not a tax invoice. Neither is configured by this example.

## Disabled production release - 2026-10-12

- Target: `https://whatsapp.architechlabs.in` (Worker `architech-wacrm`).
- Built source: `c2db4309df82c0b67bf0245fc00e302617e61f2b`.
- Active Worker version: `328c76b7-3c52-4e92-8424-b5648dbe4326`, 100% traffic.
- Rollback version: `6a62f093-a192-4142-aa8c-fc08df10c1ba`.
- Explicit runtime switch: `ENABLE_ADMIN_DOCUMENT_DELIVERY=false`.
- Existing secret binding names/types and plain-text variable values were preserved;
  their values were compared in memory and never printed or committed.
- Lint: zero errors (34 existing warnings); typecheck passed; 999 tests passed in
  102 files. Next/OpenNext production build and Wrangler dry run passed. Local
  Worker smoke checks passed; artifact scan found no embedded server secrets.
- GitHub Actions did not run for this fork PR; these are local release checks,
  not a claim of successful GitHub CI or production migration verification.
- Live smoke: login 200; root/inbox redirect behavior unchanged; Razorpay GET
  remains 405; document capabilities GET 200 with disabled/empty policies and
  no-store; document POST 404 with `document_delivery_disabled`.
- The live settings bundle matches the built artifact and includes `documents:send`.
- No production Supabase migration, database permission change, AWS update,
  dedicated API-key creation, real document upload or message send was performed.

The user subsequently reported creating the dedicated key and the narrowly scoped
Lambda inline policy. Their Lambda screenshot confirms the Desk secret ARN setting
and `ENABLE_ADMIN_WHATSAPP_DELIVERY=false`. Secret contents, key scope, effective IAM
access and the production alias configuration have not been independently verified.
This deployment alone does not enable admin-dashboard WhatsApp sending.

## Offline preparation checks - 2026-10-12

`scripts/check-admin-document-config.mjs` reuses the runtime template validator.
It does not load dotenv files, call Meta/Desk/AWS/Supabase, retrieve a secret, write
configuration, or enable a feature. It prints only validation status and document
kinds. A syntactically valid configuration is **not** proof of live approval,
account membership, migration status or readiness to activate.

Run with the repository's installed TypeScript compiler and Node 20+ (no
experimental flags). Only the fixed runtime validator source is transformed in
memory; the supplied JSON is parsed as data, never executed:

```powershell
node scripts/check-admin-document-config.mjs --account-id <verified-desk-account-uuid> --templates <private-reviewed-json-file>
```

The quotation example intentionally fails until its placeholder ID is replaced
in a private reviewed copy with an independently verified template ID. The tool
also accepts the two `ADMIN_DOCUMENT_DELIVERY_*` configuration variables already
in the current shell. It never reads API key or Meta token variables. Do not paste
keys into command arguments or include them in the configuration JSON.

`invoice-template-drafts.json` supplies **unsubmitted drafts** for separate tax and
proforma templates, with explicit variable maps. It is deliberately not a runtime
policy array and is not imported by the application. Do not edit an existing live
template automatically. After independent Meta approval, copy the exact approved
body, ID, name and language into the runtime policy; approval is not implied here.

`verify-outbox-read-only.sql` is now a historical diagnostic only. The user ran it
and supplied six false results, including absence of the obsolete outbox. Do not
create that table to turn those results green. The replacement diagnostic is
`verify-inbox-document-schema-read-only.sql`; it reads catalogs in a read-only
transaction, returns no customer rows, and applies no migration.

Local preparation verification: 1,004 tests passed across 103 files; `tsc --noEmit`
and lint of the new checker/test files passed. The offline CLI rejected missing
configuration without printing inputs. A read-only live capability GET returned
HTTP 200, `enabled=false` and zero policies. No deployment, secret retrieval,
production database query/migration, template submission or real send was performed
for this preparation update.

### Timing and infrastructure release hold

The admin send handler currently queries Desk capabilities before sending. Each
Desk HTTP request can take 27 seconds, and secret retrieval, quotation/database
reads and PDF validation/rendering add time. Meta verification/upload/send alone
can total 25 seconds, and database writes add more. Merely changing Lambda from
15 to 30 seconds therefore does **not** establish a safe end-to-end budget.

Keep all switches off. The recommended next implementation is durable queued
delivery with a quick acknowledgement, a persisted job identity and explicit
status reconciliation for uncertain results. Do not use untracked in-process
background work, automatically retry sends, or replace `accepted` with `delivered`.
Queue location/worker permissions, schema changes and staging acceptance need a
reviewed release before production activation; none were created by these checks.

The admin backend now has LOCAL, OFF-only SAM preparation for the dedicated
secret ARN/inline policy and a main-workflow guard that checks selected metadata
from both the production alias and `$LATEST` before any change set. Existing
scopes refuse manually added WhatsApp settings that have not been adopted into
the stack; they do not silently adopt or erase them. Nothing has been applied to
AWS. A separately reviewed OFF-adoption scope is still required, preserving the
exact ARN, disabled flag, policy, stack parameters, alias/version and all unrelated
environment variables. Do not bypass the guard or use another legacy workflow.

## Staging-first schema/release procedure

Migration 046, the separate concurrent index and constraint validation were
applied to production on 2026-10-13 after an isolated public-schema/data restore
smoke test. All ten read-only catalog checks passed; sending remains OFF. The
steps below are retained as the reviewed procedure, **not instructions to rerun
the migration or index**. See `backup-and-recovery.md` for the scoped receipt.

1. Confirm the exact project and inspect existing migrations 017/040, message
   columns, RLS, realtime settings and triggers. Obtain a database backup/export
   and recovery plan first; the supplied dashboard currently says "No backups".
2. Review **only** `046_admin_document_messages.sql`. It adds seven nullable fields,
   a NOT VALID shape constraint, and two narrowly scoped protection triggers.
   It also revokes table-wide TRUNCATE from application roles, because TRUNCATE
   bypasses row DELETE guards/RLS; existing application CRUD does not use it.
   It does not create tables or rewrite ordinary message rows/RLS. DDL fails
   rather than waiting longer than 1 second for a lock; a statement is limited
   to 5 seconds. If it fails, ROLLBACK and investigate; never remove timeouts to
   force a production change. NOT VALID avoids scanning history under the DDL
   lock while enforcing the constraint on new/updated rows immediately.
3. Separately run `create-document-message-index.sql` as its **single standalone
   statement outside any transaction**. It builds a unique partial index
   CONCURRENTLY. Do not run it in a transaction-wrapped batch/editor. If interrupted,
   inspect index validity before a reviewed repair. Document inserts fail closed
   until the expected unique index is valid and ready; ordinary chat still works.
   See [PostgreSQL's CREATE INDEX documentation](https://www.postgresql.org/docs/current/sql-createindex.html).
4. Separately validate the constraint off peak with reviewed lock/statement limits:
   `ALTER TABLE public.messages VALIDATE CONSTRAINT messages_admin_document_shape;`.
   Run `verify-inbox-document-schema-read-only.sql`; expect all ten checks true
   after validation. This is a prerequisite, not a complete authorization audit.
5. In staging, verify real Supabase role/RLS/realtime behavior. Local PGlite tests
   execute the SQL in an in-memory PostgreSQL engine using synthetic roles and an
   account-scoped fixture policy, not a copy of production RLS. They cannot certify
   effective production permissions. See [PGlite's documentation](https://pglite.dev/docs/).
6. Review and deploy the OFF revision only after backup/schema review. Keep all
   three switches OFF until the template, timeout/async, infrastructure-drift and
   internal-recipient acceptance gates above are resolved.

Retention consequence to approve before activation: document messages cannot be
edited/deleted/reassigned through ordinary client or generic service operations;
deleting their containing conversation/contact/account will also be refused by
the retention guards/FKs. Ordinary conversations/messages are unaffected. A future
purge/privacy workflow requires a separately reviewed retention policy, not disabling
the guard or clearing the duplicate key. No document rows currently exist from this
work, so this restriction has not changed production behavior.

Rollback: leave switches OFF and roll back application code, **retain** the nullable
columns, index, triggers and any document records for duplicate protection. Do not
drop data or replay 045. Old deployments may not understand protected document
records; resolve/reconcile them before any further activation. No automatic retry
is made after an uncertain response; reconcile with Desk/Meta manually.

Still unresolved: an early webhook arriving before wamid persistence may not match
the inbox row. Existing webhook logic is unchanged. Reconciliation and a bounded
durable asynchronous workflow remain activation gates, not claims of this revision.
Local queue integration is documented in `queue-preparation-review.md`. The public
sender and admin API/UI now use the queued protocol behind OFF switches, with no
synchronous fallback. This is not deployed and does not satisfy live schema,
runtime, webhook-reconciliation or end-to-end activation gates yet.

## Verification of the same-inbox revision - 2026-10-12

- Full local suite: **1,038 tests passed in 106 files** under Node 20.20.2,
  matching the CI major version. Command:
  `npm exec --yes --package=node@20 -- node node_modules/vitest/vitest.mjs run --maxWorkers=1 --testTimeout=15000`.
  Serial execution and a 15-second per-test cap were used on this Windows machine.
  Earlier concurrent build/test runs hit resource-related timeouts, including an
  unchanged filesystem-scanning test; those failed runs are not counted as passes.
- The offline validator is compatible with Node 20 without experimental TS flags;
  it lazily transforms only the fixed trusted runtime module with the existing
  TypeScript dependency. Sensitive inputs and exception details are never echoed.
- `tsc --noEmit` passed. Full lint: zero errors, 34 existing warnings. Focused
  lint passed for all changed code/tests/helper files; `git diff --check` passed.
- Next 16.2.12 production build passed with the repository CI-style **synthetic**
  public Supabase/crypto placeholders and the document feature OFF. No real account
  credential was loaded. The first build without public build settings failed
  prerendering the existing forgot-password page; it was rerun with placeholders,
  not with production secrets. Existing middleware deprecation warning remains.
- PostgreSQL SQL tests use PGlite 0.5.9 (new, development-only dependency) and
  synthetic fixture accounts/roles. They execute the migration, standalone index,
  constraint validation and catalog diagnostic without contacting Supabase.
  Tests cover ordinary CRUD, account RLS isolation, account-wide uniqueness,
  missing-index refusal, immutable metadata/acknowledgements, deletion/TRUNCATE
  protection, uncertain sends and existing webhook status writes.
- `npm audit` still reports 29 findings in existing dependencies; none are reported
  for the added PGlite package. No broad dependency upgrade/automatic audit fix was
  attempted. Those findings require separate review before a production release.
- No production code deployment, schema apply, environment/IAM/key modification,
  template submission, secret read, customer upload or real WhatsApp send occurred.
  No live role/RLS, Cloudflare-runtime or end-to-end acceptance claim is made.
