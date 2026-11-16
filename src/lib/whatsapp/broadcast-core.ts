// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { MetaApiError, sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { shouldPauseBroadcast } from '@/lib/whatsapp/delivery-errors';
import { resolveWhatsAppConfig, WhatsAppConfigLookupError } from '@/lib/whatsapp/resolve-config';
import {
  sanitizePhoneForMeta,
  isValidE164,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import { finishBroadcastMessage, reserveBroadcastMessage } from '@/lib/whatsapp/broadcast-message';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  readonly recipientErrors?: { index: number; phone: string; reason: string }[];
  constructor(code: string, message: string, status: number, recipientErrors?: { index: number; phone: string; reason: string }[]) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
    this.recipientErrors = recipientErrors;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  idempotencyKey?: string | null;
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  /** Line this broadcast sends from. Omitted uses the workspace default. */
  whatsappConfigId?: string | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
  messageParams?: SendTimeParams;
}

export interface BroadcastPlan {
  accountId?: string;
  auditUserId?: string;
  configId?: string;
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
  recipientErrors?: { index: number; phone: string; reason: string }[];
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!params.idempotencyKey?.trim() || params.idempotencyKey.length > 200) {
    throw new BroadcastError('bad_request', 'A valid Idempotency-Key header is required', 400);
  }

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Config (fail fast + provides the audit trail owner already resolved
  // by the caller). Meta send needs phone_number_id + decrypted token.
  let config
  try {
    config = await resolveWhatsAppConfig(db, {
      accountId,
      configId: params.whatsappConfigId,
    })
  } catch (err) {
    if (err instanceof WhatsAppConfigLookupError) {
      throw new BroadcastError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        400
      )
    }
    throw err
  }
  if (!config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
  if (!config.waba_id) {
    throw new BroadcastError('whatsapp_not_configured', 'The selected WhatsApp number has no WABA ID.', 400);
  }
  const accessToken = decrypt(config.access_token);

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage,
    config.waba_id,
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;
  if (!templateRow || templateRow.status !== 'APPROVED' ||
      (params.templateLanguage && templateRow.language?.toLowerCase() !== params.templateLanguage.toLowerCase())) {
    throw new BroadcastError('template_not_found', 'Approved template not found for this WhatsApp number and language. Refresh templates and try again.', 400);
  }

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const deduped: { phone: string; params: string[] }[] = [];
  const recipientErrors: { index: number; phone: string; reason: string }[] = [];
  const seenPhone = new Set<string>();
  for (const [index, r] of recipients.entries()) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      recipientErrors.push({ index, phone: typeof r.to === 'string' ? r.to : '', reason: 'Invalid phone number; include the country code.' });
      continue;
    }
    if (seenPhone.has(sanitized)) {
      recipientErrors.push({ index, phone: r.to, reason: 'Duplicate phone number.' });
      continue;
    }
    seenPhone.add(sanitized);
    deduped.push({
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400,
      recipientErrors,
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_contacts',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_recipients: deduped,
      p_whatsapp_config_id: config.id ?? null,
      p_idempotency_key: params.idempotencyKey.trim(),
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    if (createErr?.code === '23505' && /idx_broadcast_account_idempotency|idempotency_key/.test(`${createErr.message} ${createErr.details ?? ''}`)) {
      throw new BroadcastError('duplicate_launch', 'This idempotency key has already been used', 409);
    }
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byPhone = new Map(deduped.map((r) => [r.phone, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; phone: string }) => {
      const r = byPhone.get(sanitizePhoneForMeta(row.phone))!;
      return { recipientRowId: row.recipient_id, phone: r.phone, params: r.params };
    }
  );

  return {
    accountId,
    auditUserId,
    configId: config.id,
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken,
    templateRow,
    planned,
    rejected: recipientErrors.length,
    recipientErrors,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<void> {
  for (const recipient of plan.planned) {
    const result = await deliverBroadcastRecipient(db, plan, recipient);
    if (shouldPauseBroadcast(result.errorCode)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await finalizeBroadcastStatus(db, plan.broadcastId);
}

export async function deliverBroadcastRecipient(
  db: SupabaseClient,
  plan: BroadcastPlan,
  recipient: PlannedRecipient,
): Promise<{ status: 'sent' | 'failed' | 'skipped_opt_out' | 'unavailable'; messageId?: string; error?: string; errorCode?: number }> {
    if (!plan.accountId) throw new Error('Broadcast account is required');
    const { data: claimed, error: claimError } = await db.rpc('claim_broadcast_recipient', {
      p_account_id: plan.accountId,
      p_broadcast_id: plan.broadcastId,
      p_recipient_id: recipient.recipientRowId,
    });
    if (claimError) throw new Error('Could not claim broadcast recipient');
    if (claimed === 'skipped_opt_out') return { status: 'skipped_opt_out' };
    if (claimed !== 'claimed') return { status: 'unavailable' };
    let sentMessageId: string | null = null;
    let lastError: string | null = null;
    let errorCode: number | undefined;
    let reservation: Awaited<ReturnType<typeof reserveBroadcastMessage>> | null = null;

    if (!plan.auditUserId || !plan.configId) throw new Error('Broadcast sender is required');
    try {
      reservation = await reserveBroadcastMessage(db, {
        accountId: plan.accountId, userId: plan.auditUserId, configId: plan.configId,
        broadcastId: plan.broadcastId, phone: recipient.phone, templateName: plan.templateName,
        template: plan.templateRow, params: recipient.params, messageParams: recipient.messageParams,
      });
    } catch {
      await db.from('broadcast_recipients').update({ status: 'failed', error_message: 'Could not prepare inbox message; nothing was sent.' }).eq('id', recipient.recipientRowId);
      return { status: 'failed', error: 'Could not prepare inbox message; nothing was sent.' };
    }

      try {
        const result = await sendTemplateMessage({
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: recipient.phone,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
          messageParams: recipient.messageParams,
        });
        sentMessageId = result.messageId;
        lastError = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        if (error instanceof MetaApiError) errorCode = error.code;
      }

    if (sentMessageId) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
      if (reservation) {
        try {
          await finishBroadcastMessage(db, reservation, sentMessageId, plan.templateName);
        } catch (error) {
          // Meta has already accepted this message. Never mark it failed or
          // resend it just because the inbox write failed.
          console.error('[broadcast-core] inbox persistence failed:', error instanceof Error ? error.message : 'Unknown error');
          await db.from('broadcast_recipients').update({ error_message: 'Accepted by Meta, but inbox recording failed; reconcile without resending.' })
            .eq('id', recipient.recipientRowId);
        }
      }
    } else {
      if (reservation && errorCode) {
        await db.from('messages').update({ status: 'failed', failure_code: errorCode, failure_reason: lastError }).eq('id', reservation.id);
      }
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
          error_code: errorCode ?? null,
        })
        .eq('id', recipient.recipientRowId);
    }
    if (shouldPauseBroadcast(errorCode)) {
      await db.from('broadcasts').update({ delivery_paused_at: new Date().toISOString(), delivery_pause_reason: `Meta error ${errorCode}` })
        .eq('id', plan.broadcastId).eq('account_id', plan.accountId);
    }
    return sentMessageId
      ? { status: 'sent', messageId: sentMessageId }
      : { status: 'failed', error: lastError ?? 'Unknown error', errorCode };
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}
