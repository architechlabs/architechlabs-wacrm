import { beforeEach, describe, expect, it, vi } from 'vitest'

const steps = vi.hoisted(() => [] as string[])

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: {
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: null, error: null }),
          insert: async () => ({ error: null }),
          update: () => query,
        }
        return query
      },
    },
    accountId: 'acct',
    userId: 'user',
  }),
  toErrorResponse: () => new Response(),
  UnauthorizedError: class UnauthorizedError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (value: string) => `enc:${value}`,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
      }
      return query
    },
  }),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  exchangeEmbeddedSignupCode: async () => {
    steps.push('exchange_code')
    return 'business-token'
  },
  subscribeWabaToApp: async () => {
    steps.push('subscribe_waba')
  },
  listWabaPhoneNumbers: async () => {
    steps.push('list_phones')
    return [{ id: 'pn-1', display_phone_number: '+1 555', is_on_biz_app: true }]
  },
  requestSmbAppData: async ({ syncType }: { syncType: string }) => {
    steps.push(syncType)
  },
}))

import { POST } from './route'

beforeEach(() => {
  steps.length = 0
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service')
})

describe('POST /api/whatsapp/onboarding', () => {
  it('exchanges the code, subscribes, lists phones, then syncs a coexistence number', async () => {
    const response = await POST(new Request('https://app.test/api/whatsapp/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code', waba_id: 'waba-1' }),
    }))
    expect(response.status).toBe(200)
    expect(steps).toEqual([
      'exchange_code',
      'subscribe_waba',
      'list_phones',
      'smb_app_state_sync',
      'history',
    ])
    expect(JSON.stringify(await response.json())).not.toContain('business-token')
  })
})
