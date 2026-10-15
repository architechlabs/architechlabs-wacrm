# Document delivery activation — 14 October 2026

The existing Inbox-backed quotation, proforma, and tax-invoice PDF path is
deployed. This did **not** create another outbox, add R2, or apply database DDL.
Private temporary PDFs use the existing Supabase Storage bucket.

## Production release evidence

- Admin API managed `production` alias advanced from version 28 to 29 with
  `ENABLE_ADMIN_WHATSAPP_DELIVERY=true`. The guarded change set changed only
  the document gate and published version; code SHA, IAM, network settings,
  other environment values and CloudFormation parameters were preserved.
  Deployment: GitHub Actions run 38561488631, backend PR 74.
- Existing document queue consumer advanced from version
  `3af089cf-692c-46de-b9b3-a65d02b3b59f` to
  `3d79dc29-2a97-4167-bf82-45c63bfb5fc1`, consumer gate ON.
- Existing Desk Worker advanced from version
  `027a5e3c-b515-4ed5-b66a-07b4fce7ced5` to
  `766404e9-4e49-48c5-94c4-67655199eaa8`, producer and document gates ON.
- Both Worker deployments preserved all prior binding names/types, secret
  bindings and unrelated plain-text values. Login, root, Inbox redirect and
  Razorpay GET status matched their pre-deployment baseline. Unauthenticated
  document capability now returns 401, rather than a disabled capability.
- Live Desk readiness verified the exact approved quotation, proforma and tax
  PDF templates and private storage. The live dashboard JavaScript contains
  the WhatsApp action and calls the authenticated capability endpoint.
- Synthetic isolated Worker runtime passed queue, private PDF, Meta acceptance,
  cleanup and redirect checks without sending a real message.

## Internal acceptance

Browser automation had no available signed-in session, so the operator sent a
fresh internal quotation from the authenticated dashboard to the previously
approved `+91 8054985500` test number. The first attempt used a quotation
already expired on 10 October; the API rejected it before any Inbox reservation
or WhatsApp send. It must not be retried as an uncertain delivery.

The new quotation `AL-QTN-2026-66241AE3` produced exactly one protected Inbox
record. Read-only Supabase checks confirmed the recipient was the approved test
number, consent time was recorded, the PDF upload ID and Meta message ID are
present, and the attachment route is private. The state advanced through
`reserved/sending` to `accepted/read` after Meta's webhook. The private
temporary-payload bucket remained non-public and held zero pending document
objects after processing. Public smoke checks still returned Admin API health
200, dashboard quotation 200, Desk login 200, unauthenticated Inbox redirect,
Razorpay GET 405 and document API 401.

The recipient's own visual confirmation that the PDF opens with expected content
is still pending. Do not clear permanent delivery claims or automatically resend
uncertain jobs.

## Rollback

Turn off the admin API managed gate through the guarded GitHub workflow with
expected production version 29. Revert the two Desk Worker flags and the queue
consumer flag to `false`, then deploy only after comparing current production
versions and secret bindings. Preserve protected Inbox rows and private payload
records; do not delete the schema, drop claims, or roll back unrelated services.

The saved-invoice ledger remains separately disabled and is not implied by this
WhatsApp document-send release.
