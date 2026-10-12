# Razorpay settlement notifications

Endpoint: `POST https://whatsapp.architechlabs.in/api/razorpay/webhook`.
Subscribe only to `settlement.processed`. Set the Razorpay Dashboard webhook
secret to the deployed `RAZORPAY_WEBHOOK_SECRET` value. Do not put secrets in
source control or logs.

The Worker requires `RAZORPAY_WEBHOOK_SECRET`, `WHATSAPP_DESK_API_KEY`,
`RAZORPAY_SETTLEMENT_RECIPIENT_PHONE` (international E.164 with `+`), and
`RAZORPAY_SETTLEMENT_RECIPIENT_NAME`, plus the existing Supabase service-role
configuration and HTTPS `NEXT_PUBLIC_SITE_URL`. The API key needs `messages:send`
in the account that owns the approved `settlement_processed` / `en_US` template.
The approved template must also be synced into that account's template catalog.

The endpoint signs the original request bytes with HMAC SHA-256 before parsing
JSON. Unrelated authenticated events return 200 without database or messaging
work. Settlement messages use positional body parameters: recipient name,
settlement ID, INR amount, date, UTR. The date uses the event's `created_at`,
falling back to the settlement entity's `created_at`, displayed in Asia/Kolkata.
See [Razorpay's settlement event example](https://razorpay.com/docs/webhooks/route/).

Migration `044_razorpay_webhook_events.sql` follows 043 and creates a service-role
only table with a primary key on `x-razorpay-event-id`. Committing it does not
apply it: verify the linked database with `supabase migration list --linked`
and apply pending migrations with `supabase db push --linked` before enabling
delivery. Never run a migration against an unverified project.

Completed duplicate events return 200. In-progress duplicates return 503 so
Razorpay can retry. Missing event IDs are rejected. Failed sends release their
claim and return 502; configuration failures return 500. Logs contain fixed
diagnostics and HTTP status codes, never payloads, headers, or exception text.

The external send and database update cannot be atomic. A crash can leave a
`processing` row; investigate the corresponding outgoing WhatsApp message
before marking it processed or deleting the claim to permit a retry. Never
automatically expire these rows: that can resend an already delivered message.
A network timeout or API error after Meta accepted the send can still duplicate
a message on retry because `/api/v1/messages` does not expose an idempotency
contract. Monitor pending claims and 5xx responses; this is not exactly-once
delivery. Do not log API error bodies while investigating.
