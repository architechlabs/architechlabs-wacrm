import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { BroadcastError, finalizeBroadcastStatus } from './broadcast-core';
import { claimBroadcastDelivery, heartbeatBroadcastDelivery, planBroadcastResume, releaseBroadcastDelivery } from './broadcast-resume';
import { runBroadcastSlice, type QueueRecipient } from './broadcast-queue-slice';
import { MetaApiError, sendTemplateMessage } from './meta-api';
import { templateBodyParams, templateContentText } from './template-body';

export interface BroadcastJob { account_id: string; broadcast_id: string }
export interface BroadcastQueue { send(job: BroadcastJob, options?: { delaySeconds: number }): Promise<void> }
export interface BroadcastQueueEnv { NEXT_PUBLIC_SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; BROADCAST_QUEUE: BroadcastQueue }
export interface BroadcastQueueMessage { body: unknown; ack(): void; retry(options?: { delaySeconds: number }): void }

function parseJob(value: unknown): BroadcastJob | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return typeof v.account_id === 'string' && id.test(v.account_id) && typeof v.broadcast_id === 'string' && id.test(v.broadcast_id)
    ? { account_id: v.account_id, broadcast_id: v.broadcast_id } : null;
}

export async function processBroadcastJob(db: SupabaseClient, queue: BroadcastQueue, job: BroadcastJob) {
  const started = Date.now();
  let token = await claimBroadcastDelivery(db, job.account_id, job.broadcast_id);
  if (!token) throw new Error('Broadcast lease unavailable');
  let requeue = false;
  try {
    let planned;
    try { planned = await planBroadcastResume(db, job.account_id, job.broadcast_id, 'pending'); }
    catch (e) {
      if (e instanceof BroadcastError && e.code === 'broadcast_paused') return;
      if (e instanceof BroadcastError && e.code === 'nothing_to_resume') { await finalizeBroadcastStatus(db, job.broadcast_id); return; }
      throw e;
    }
    const { plan } = planned;
    const recipients = plan.planned.map((row) => ({ id: row.recipientRowId }));
    const byId = new Map(plan.planned.map((row) => [row.recipientRowId, row]));
    const reservations = new Map<string, string>();
    const result = await runBroadcastSlice({
      now: () => Date.now(),
      reserve: async (recipient: QueueRecipient) => {
        const row = byId.get(recipient.id)!;
        const text = templateContentText(plan.templateRow, templateBodyParams(row.params, row.messageParams));
        const { data, error } = await db.rpc('broadcast_claim_and_reserve', { p_account_id: job.account_id, p_broadcast_id: job.broadcast_id, p_recipient_id: recipient.id, p_content_text: text });
        if (error || !Array.isArray(data) || !data[0]) throw new Error('Could not reserve recipient');
        if (data[0].outcome === 'claimed') reservations.set(recipient.id, data[0].message_id);
        return data[0].outcome;
      },
      send: async (recipient, timeoutMs) => {
        const row = byId.get(recipient.id)!;
        try {
          const sent = await sendTemplateMessage({ phoneNumberId: plan.phoneNumberId, accessToken: plan.accessToken, to: row.phone,
            templateName: plan.templateName, language: plan.templateLanguage, template: plan.templateRow ?? undefined,
            params: row.params, messageParams: row.messageParams, signal: AbortSignal.timeout(timeoutMs) });
          return { wamid: sent.messageId };
        } catch (error) {
          // An unknown network/provider outcome must retain its claim forever.
          if (!(error instanceof MetaApiError) || error.code == null) throw new Error('Delivery outcome unknown');
          return { errorCode: error.code, error: error.message };
        }
      },
      finish: async (recipient, result) => {
        const { error } = await db.rpc('broadcast_finish_recipient', { p_account_id: job.account_id, p_broadcast_id: job.broadcast_id,
          p_recipient_id: recipient.id, p_message_id: reservations.get(recipient.id), p_wamid: 'wamid' in result ? result.wamid : null,
          p_error_code: 'errorCode' in result ? result.errorCode : null, p_error_message: 'error' in result ? result.error : null });
        if (error) throw new Error('Could not finish recipient');
      },
      heartbeat: async () => {
        const next = await heartbeatBroadcastDelivery(db, job.account_id, job.broadcast_id, token!);
        if (!next) return false;
        token = next;
        return true;
      },
    }, recipients, started);
    requeue = !result.paused && (planned.remaining > 0 || result.visited < recipients.length);
    if (!requeue && !result.paused) await finalizeBroadcastStatus(db, job.broadcast_id);
  } finally {
    // A failed release must not prevent the next queue message being created.
    try { await releaseBroadcastDelivery(db, job.broadcast_id, token); } finally {
      if (requeue) await queue.send(job, { delaySeconds: 1 });
    }
  }
}

export async function processBroadcastQueue(batch: { messages: BroadcastQueueMessage[] }, env: BroadcastQueueEnv) {
  // Batch size is one. Bound all Supabase I/O by a shared invocation deadline;
  // if a claim times out it is treated as unknown and never sent again.
  const deadline = Date.now() + 19_000;
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    global: { fetch: (input, init) => {
      const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      return fetch(input, { ...init, signal, redirect: 'error' });
    } },
  });
  for (const message of batch.messages) {
    const job = parseJob(message.body);
    if (!job) { message.ack(); continue; }
    try { await processBroadcastJob(db, env.BROADCAST_QUEUE, job); message.ack(); }
    catch { message.retry({ delaySeconds: 5 }); }
  }
}

export async function sweepBroadcastQueue(env: BroadcastQueueEnv) {
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await db.rpc('sweep_broadcast_queue');
  if (error) throw new Error('Broadcast sweep failed');
  for (const row of data ?? []) {
    const job = parseJob(row);
    if (job) await env.BROADCAST_QUEUE.send(job, { delaySeconds: 1 });
  }
}
