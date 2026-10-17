import type { SupabaseClient } from '@supabase/supabase-js';
import type { WhatsAppConfig } from '@/types';
import { readWithTimeout } from '@/lib/http/read-with-timeout';

// The browser needs metadata, not encrypted credentials or the verify token.
export const CONFIG_COLUMNS = 'id, account_id, phone_number_id, waba_id, display_phone_number, verified_name, is_on_biz_app, is_default, source, status, registered_at, subscribed_apps_at, last_registration_error, mirror_inbound_media' as const;
export type SavedWhatsAppConfig = Pick<WhatsAppConfig,
  'id' | 'phone_number_id' | 'waba_id' | 'display_phone_number' | 'verified_name' |
  'is_on_biz_app' | 'is_default' | 'source' | 'status' | 'registered_at' |
  'subscribed_apps_at' | 'last_registration_error' | 'mirror_inbound_media'>;

export async function readWhatsAppConfig(
  supabase: SupabaseClient,
  accountId: string,
  signal: AbortSignal,
): Promise<SavedWhatsAppConfig | null> {
  const { data, error } = await readWithTimeout(abortSignal => supabase
    .from('whatsapp_config')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .eq('is_default', true)
    .abortSignal(abortSignal)
    .maybeSingle(), signal);
  // A failed read is NOT evidence that the stored config is missing.
  if (error) throw new Error('Could not load saved WhatsApp settings. Please retry.');
  return data;
}

export async function readWhatsAppNumbers(
  supabase: SupabaseClient,
  accountId: string,
  signal: AbortSignal,
): Promise<SavedWhatsAppConfig[]> {
  const { data, error } = await readWithTimeout(abortSignal => supabase
    .from('whatsapp_config')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .order('is_default', { ascending: false })
    .abortSignal(abortSignal), signal);
  if (error) throw new Error('Could not load saved WhatsApp settings. Please retry.');
  return (data ?? []) as SavedWhatsAppConfig[];
}
