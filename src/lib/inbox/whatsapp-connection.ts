import type { SupabaseClient } from '@supabase/supabase-js';
import { readWithTimeout } from '@/lib/http/read-with-timeout';

/** Reads the account-scoped connection flag without re-resolving auth/profile. */
export async function readWhatsappConnectionStatus(
  supabase: SupabaseClient,
  accountId: string,
  parentSignal?: AbortSignal,
  configId?: string | null,
): Promise<boolean> {
  const { data, error } = await readWithTimeout(signal => {
    let query = supabase
      .from('whatsapp_config')
      .select('status')
      .eq('account_id', accountId)
    query = configId ? query.eq('id', configId) : query.eq('is_default', true)
    return query.abortSignal(signal).maybeSingle()
  }, parentSignal);

  if (error) throw new Error('WhatsApp connection status unavailable');

  return data?.status === 'connected';
}
