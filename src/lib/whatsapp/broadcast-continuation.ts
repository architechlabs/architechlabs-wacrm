import type { SupabaseClient } from '@supabase/supabase-js';

/** Continue a persisted campaign in another short invocation, without asking the bot to poll. */
export async function continueBroadcastAutomatically(
  db: SupabaseClient, accountId: string, broadcastId: string, requestUrl: string, authorization: string | null,
): Promise<void> {
  if (!authorization) return;
  let origin: string;
  try { origin = new URL(requestUrl).origin; } catch { return; }
  // Never forward the caller's credential to an untrusted host.
  if (origin !== 'https://whatsapp.architechlabs.in') return;
  const { data: campaign, error } = await db.from('broadcasts').select('delivery_paused_at')
    .eq('account_id', accountId).eq('id', broadcastId).maybeSingle();
  if (error || !campaign || campaign.delivery_paused_at) return;
  const { count, error: countError } = await db.from('broadcast_recipients')
    .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId)
    .eq('status', 'pending').is('send_started_at', null).is('whatsapp_message_id', null);
  if (countError || !count) return;
  try {
    const response = await fetch(`${origin}/api/v1/broadcasts/${encodeURIComponent(broadcastId)}/continue`, {
      method: 'POST', headers: { Authorization: authorization },
    });
    if (!response.ok) console.error('[broadcast] Automatic continuation could not be started:', response.status);
  } catch {
    // Pending rows remain in the database for an explicit continuation.
    console.error('[broadcast] Automatic continuation could not be reached');
  }
}
