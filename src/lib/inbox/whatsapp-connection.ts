import type { SupabaseClient } from '@supabase/supabase-js';
import { readWithTimeout } from '@/lib/http/read-with-timeout';

/** Reads the account-scoped connection flag without re-resolving auth/profile. */
export async function readWhatsappConnectionStatus(
  supabase: SupabaseClient,
  accountId: string,
  parentSignal?: AbortSignal,
): Promise<boolean> {
  const { data, error } = await readWithTimeout(signal => supabase
    .from('whatsapp_config')
    .select('status')
    .eq('account_id', accountId)
    .abortSignal(signal)
    .maybeSingle(), parentSignal);

  if (error) throw new Error('WhatsApp connection status unavailable');

  return data?.status === 'connected';
}
