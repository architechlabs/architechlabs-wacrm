import type { SupabaseClient } from '@supabase/supabase-js'

export interface DisconnectResult {
  removed: boolean
  disconnected: boolean
}

/**
 * Remove a number when it has no chats or contacts. Otherwise keep the
 * row (history stays on that line) and mark it disconnected.
 */
export async function disconnectWhatsAppNumber(
  db: SupabaseClient,
  accountId: string,
  configId: string,
): Promise<DisconnectResult | null> {
  const { data: row, error } = await db
    .from('whatsapp_config')
    .select('id, is_default')
    .eq('id', configId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error('Could not load the WhatsApp number')
  if (!row) return null

  const conversations = await db
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('whatsapp_config_id', configId)
  const contacts = await db
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('whatsapp_config_id', configId)
  if (conversations.error || contacts.error) {
    throw new Error('Could not check whether this number has chats')
  }

  const inUse = (conversations.count ?? 0) > 0 || (contacts.count ?? 0) > 0
  if (inUse) {
    const { error: updateError } = await db
      .from('whatsapp_config')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('id', configId)
      .eq('account_id', accountId)
    if (updateError) throw new Error('Could not disconnect the WhatsApp number')
    return { removed: false, disconnected: true }
  }

  const { error: deleteError } = await db
    .from('whatsapp_config')
    .delete()
    .eq('id', configId)
    .eq('account_id', accountId)
  if (deleteError) throw new Error('Could not remove the WhatsApp number')

  if (row.is_default) {
    const { data: next } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .limit(1)
      .maybeSingle()
    if (next?.id) {
      await db
        .from('whatsapp_config')
        .update({ is_default: true })
        .eq('id', next.id)
        .eq('account_id', accountId)
    }
  }

  return { removed: true, disconnected: false }
}
