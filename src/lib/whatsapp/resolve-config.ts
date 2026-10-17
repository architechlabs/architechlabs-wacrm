import type { SupabaseClient } from '@supabase/supabase-js'

/** Row shape used by send paths. Extra columns are ignored by callers. */
export interface WhatsAppConfigRow {
  id: string
  account_id?: string
  user_id?: string
  phone_number_id: string
  waba_id?: string | null
  access_token: string
  verify_token?: string | null
  status?: string
  is_default?: boolean
  is_on_biz_app?: boolean
  display_phone_number?: string | null
  verified_name?: string | null
  source?: string
  registered_at?: string | null
  subscribed_apps_at?: string | null
  last_registration_error?: string | null
  mirror_inbound_media?: boolean
}

export class WhatsAppConfigLookupError extends Error {
  constructor(message = 'Saved WhatsApp settings could not be loaded.') {
    super(message)
    this.name = 'WhatsAppConfigLookupError'
  }
}

export interface ResolveWhatsAppConfigArgs {
  accountId: string
  configId?: string | null
  conversationId?: string | null
  contactId?: string | null
}

type QueryResult = { data: WhatsAppConfigRow | null; error: { message?: string } | null }

interface FilterBuilder {
  eq: (column: string, value: unknown) => FilterBuilder
  maybeSingle?: () => PromiseLike<QueryResult>
  single?: () => PromiseLike<QueryResult>
}

async function finish(query: FilterBuilder): Promise<WhatsAppConfigRow | null> {
  if (typeof query.maybeSingle === 'function') {
    const { data, error } = await query.maybeSingle()
    if (error) throw new WhatsAppConfigLookupError()
    return data
  }
  if (typeof query.single === 'function') {
    const { data, error } = await query.single()
    if (error || !data) return null
    return data
  }
  throw new WhatsAppConfigLookupError()
}

async function loadById(
  db: SupabaseClient,
  accountId: string,
  configId: string,
): Promise<WhatsAppConfigRow | null> {
  const query = db
    .from('whatsapp_config')
    .select('*')
    .eq('id', configId)
    .eq('account_id', accountId) as unknown as FilterBuilder
  return finish(query)
}

async function loadDefault(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppConfigRow | null> {
  const scoped = db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId) as unknown as FilterBuilder
  const query = typeof scoped.eq === 'function' ? scoped.eq('is_default', true) : scoped
  return finish(query)
}

async function foreignConfigId(
  db: SupabaseClient,
  table: 'conversations' | 'contacts',
  id: string,
  accountId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from(table)
    .select('whatsapp_config_id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new WhatsAppConfigLookupError()
  const value = (data as { whatsapp_config_id?: string | null } | null)?.whatsapp_config_id
  return value ?? null
}

/**
 * Resolve the WhatsApp number a send should use.
 * Explicit id, then the conversation's line, then the contact's line,
 * then the workspace default. One-number workspaces only have the default.
 */
export async function resolveWhatsAppConfig(
  db: SupabaseClient,
  args: ResolveWhatsAppConfigArgs,
): Promise<WhatsAppConfigRow | null> {
  const explicit = args.configId?.trim()
  if (explicit) return loadById(db, args.accountId, explicit)

  if (args.conversationId) {
    const id = await foreignConfigId(db, 'conversations', args.conversationId, args.accountId)
    if (id) return loadById(db, args.accountId, id)
  }

  if (args.contactId) {
    const id = await foreignConfigId(db, 'contacts', args.contactId, args.accountId)
    if (id) return loadById(db, args.accountId, id)
  }

  return loadDefault(db, args.accountId)
}
