import type { SupabaseClient } from '@supabase/supabase-js';

/** Reads the account-scoped connection flag without re-resolving auth/profile. */
export async function readWhatsappConnectionStatus(
  supabase: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('whatsapp_config')
    .select('status')
    .eq('account_id', accountId)
    .maybeSingle();

  return data?.status === 'connected';
}
