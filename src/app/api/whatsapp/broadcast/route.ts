import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveWhatsAppConfig } from '@/lib/whatsapp/resolve-config';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { deliverBroadcastRecipient, finalizeBroadcastStatus, type BroadcastPlan } from '@/lib/whatsapp/broadcast-core';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';

/** Deliver only recipients already persisted on this account's broadcast. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await request.json();
    const broadcastId = typeof body.broadcast_id === 'string' ? body.broadcast_id : '';
    const requested = Array.isArray(body.recipients) ? body.recipients : [];
    if (!broadcastId || requested.length === 0 || requested.length > 10 || requested.some((r: { recipient_id?: unknown }) => typeof r?.recipient_id !== 'string')) {
      return NextResponse.json({ error: 'Provide a broadcast_id and up to 10 persisted recipient IDs.' }, { status: 400 });
    }
    const { data: broadcast, error: broadcastError } = await supabase.from('broadcasts')
      .select('id, template_name, template_language, whatsapp_config_id')
      .eq('id', broadcastId).eq('account_id', accountId).maybeSingle();
    if (broadcastError || !broadcast) return NextResponse.json({ error: 'Broadcast not found.' }, { status: 404 });
    const config = await resolveWhatsAppConfig(supabase, { accountId, configId: broadcast.whatsapp_config_id });
    if (!config) return NextResponse.json({ error: 'WhatsApp number not found.' }, { status: 400 });
    const template = await resolveTemplateRow(supabase, accountId, broadcast.template_name, broadcast.template_language, config.waba_id);
    if (template.malformed) return NextResponse.json({ error: 'Template is malformed.' }, { status: 400 });
    const ids = [...new Set<string>(requested.map((r: { recipient_id: string }) => r.recipient_id))];
    const { data: rows, error: recipientError } = await supabase.from('broadcast_recipients')
      .select('id, template_params, contact:contacts(phone)')
      .eq('broadcast_id', broadcastId).in('id', ids);
    if (recipientError || !rows || rows.length !== ids.length) return NextResponse.json({ error: 'Recipient not found on broadcast.' }, { status: 400 });
    const plan: BroadcastPlan = { accountId, auditUserId: userId, configId: config.id, broadcastId,
      templateName: broadcast.template_name, templateLanguage: template.language,
      phoneNumberId: config.phone_number_id, accessToken: decrypt(config.access_token),
      templateRow: template.row, planned: [], rejected: 0 };
    const admin = supabaseAdmin();
    const results = [];
    let stopped = false;
    for (const row of rows) {
      const contact = Array.isArray(row.contact) ? row.contact[0] : row.contact;
      const phone = contact?.phone ?? '';
      const requestedRow = requested.find((r: { recipient_id: string }) => r.recipient_id === row.id);
      const result = await deliverBroadcastRecipient(admin, plan, {
        recipientRowId: row.id, phone: sanitizePhoneForMeta(phone),
        params: Array.isArray(row.template_params) ? row.template_params : [],
        messageParams: requestedRow?.messageParams as SendTimeParams | undefined,
      });
      results.push({ phone, status: result.status, whatsapp_message_id: result.messageId, error: result.error, error_code: result.errorCode });
      if (result.errorCode && [131048, 131056, 130429, 131049].includes(result.errorCode)) { stopped = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await finalizeBroadcastStatus(admin, broadcastId);
    return NextResponse.json({ success: true, stopped, results });
  } catch (error) {
    return toErrorResponse(error);
  }
}
