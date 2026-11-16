// ============================================================
// POST /api/v1/broadcasts — launch a template broadcast
// (scope: broadcasts:send).
//
// Body:
//   {
//     "name": "July promo",                 // optional label
//     "template_name": "promo_july",        // required, approved template
//     "template_language": "en_US",         // optional (default en_US)
//     "recipients": [                        // required, 1..1000
//       { "to": "+14155550123", "params": ["Jane"] },
//       { "to": "+14155550124" }
//     ]
//   }
//
// The broadcast + its recipient rows are persisted synchronously, then
// a queue message schedules delivery. Poll
// `GET /api/v1/broadcasts/{id}` for progress.
//
// Response (202):
//   { "data": { "broadcast_id", "status": "sending",
//               "total_recipients", "accepted", "rejected" } }
// ============================================================

import { NextResponse } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';

import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import {
  createBroadcast,
  BroadcastError,
} from '@/lib/whatsapp/broadcast-core';
import { enqueueBroadcast } from '@/lib/whatsapp/broadcast-queue-runtime';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const templateName =
      typeof body.template_name === 'string' ? body.template_name : '';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const plan = await createBroadcast(ctx.supabase, ctx.accountId, auditUserId, {
      name: typeof body.name === 'string' ? body.name : null,
      idempotencyKey: request.headers.get('Idempotency-Key') || crypto.randomUUID(),
      templateName,
      templateLanguage:
        typeof body.template_language === 'string'
          ? body.template_language
          : typeof body.language === 'string' ? body.language
          : null,
      whatsappConfigId: typeof body.whatsapp_config_id === 'string' ? body.whatsapp_config_id : null,
      recipients: recipients.map((r) => ({
        to: typeof r?.to === 'string' ? r.to : '',
        params: Array.isArray(r?.params) ? r.params : undefined,
      })),
    });

    // Queue only account and broadcast IDs; no caller credential is forwarded.
    await enqueueBroadcast({ account_id: ctx.accountId, broadcast_id: plan.broadcastId });

    return ok(
      {
        broadcast_id: plan.broadcastId,
        status: 'sending',
        total_recipients: plan.planned.length,
        accepted: plan.planned.length,
        rejected: plan.rejected,
        recipient_errors: plan.recipientErrors ?? [],
      },
      202
    );
  } catch (err) {
    if (err instanceof BroadcastError) {
      if (err.recipientErrors) return NextResponse.json({ error: { code: err.code, message: err.message, recipient_errors: err.recipientErrors } }, { status: err.status });
      return fail(err.code, err.message, err.status);
    }
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
