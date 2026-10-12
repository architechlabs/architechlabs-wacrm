# Admin quotation delivery configuration - NOT activated

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
6. Separately review/apply migration `045_admin_document_deliveries.sql` to the
   intended Supabase project and verify its table, unique constraint and RLS.
   This migration has **not** been applied locally or to production by this work.
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
