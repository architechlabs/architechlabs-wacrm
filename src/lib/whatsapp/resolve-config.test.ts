import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveWhatsAppConfig } from './resolve-config'

function dbFor(rows: {
  conversation?: { whatsapp_config_id?: string | null } | null
  contact?: { whatsapp_config_id?: string | null } | null
  configs: Record<string, { id: string; phone_number_id: string; access_token: string; is_default?: boolean }>
}): SupabaseClient {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value
          return builder
        },
        maybeSingle: async () => {
          if (table === 'conversations') return { data: rows.conversation ?? null, error: null }
          if (table === 'contacts') return { data: rows.contact ?? null, error: null }
          if (table === 'whatsapp_config') {
            if (filters.id) {
              const match = Object.values(rows.configs).find((row) => row.id === filters.id)
              return { data: match ?? null, error: null }
            }
            const fallback = Object.values(rows.configs).find((row) => row.is_default)
            return { data: fallback ?? null, error: null }
          }
          return { data: null, error: null }
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
}

describe('resolveWhatsAppConfig', () => {
  const configs = {
    line: { id: 'line-1', phone_number_id: 'pn-1', access_token: 'tok', is_default: false },
    fallback: { id: 'line-default', phone_number_id: 'pn-d', access_token: 'tok-d', is_default: true },
  }

  it('uses an explicit config id first', async () => {
    const config = await resolveWhatsAppConfig(dbFor({ configs }), {
      accountId: 'acct',
      configId: 'line-1',
      conversationId: 'cv',
    })
    expect(config?.id).toBe('line-1')
  })

  it('uses the conversation line before the contact or default', async () => {
    const config = await resolveWhatsAppConfig(dbFor({
      configs,
      conversation: { whatsapp_config_id: 'line-1' },
      contact: { whatsapp_config_id: 'line-default' },
    }), { accountId: 'acct', conversationId: 'cv', contactId: 'ct' })
    expect(config?.id).toBe('line-1')
  })

  it('falls back to the default number', async () => {
    const config = await resolveWhatsAppConfig(dbFor({ configs }), { accountId: 'acct' })
    expect(config?.id).toBe('line-default')
  })
})
