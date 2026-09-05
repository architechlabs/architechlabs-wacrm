import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@/lib/whatsapp/encryption';

const state = vi.hoisted(() => ({
  userId: 'owner-user', role: 'owner', readError: false,
  saved: null as Record<string, unknown> | null,
  writes: [] as Record<string, unknown>[],
  configFilters: [] as [string, unknown][],
  verify: vi.fn(async () => ({ id: 'test-phone' })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: state.userId } }, error: null }) },
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          if (table === 'whatsapp_config') state.configFilters.push([column, value]);
          return query;
        },
        maybeSingle: async () => table === 'profiles'
          ? { data: { account_id: 'shared-account', account_role: state.role }, error: null }
          : { data: state.readError ? null : state.saved, error: state.readError ? { message: 'temporary' } : null },
        update: (row: Record<string, unknown>) => { state.writes.push(row); return query; },
        insert: (row: Record<string, unknown>) => { state.writes.push(row); return query; },
        then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
      };
      return query;
    },
  }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: () => {
    const query = { select: () => query, eq: () => query, neq: () => query,
      maybeSingle: async () => ({ data: null, error: null }) };
    return query;
  } }),
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: state.verify,
  registerPhoneNumber: vi.fn(async () => ({ success: true })),
  subscribeWabaToApp: vi.fn(async () => ({ success: true })),
}));
import { GET, POST } from './route';

beforeEach(() => {
  state.userId = 'owner-user'; state.role = 'owner'; state.readError = false;
  state.writes = []; state.configFilters = [];
  state.saved = {
    id: 'test-config', phone_number_id: 'test-phone', registered_at: '2026-01-01T00:00:00Z',
    access_token: encrypt('test-access'), verify_token: encrypt('test-verify'), status: 'connected',
  };
});
function save(extra: Record<string, unknown> = {}) {
  return POST(new Request('https://app.test/api/whatsapp/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone_number_id: 'test-phone', verify_token: '', ...extra }),
  }));
}

describe('shared WhatsApp configuration', () => {
  it('loads the same saved credentials for owner and teammate after refresh without any write', async () => {
    for (const [id, role] of [['owner-user', 'owner'], ['team-user', 'agent']]) {
      state.userId = id; state.role = role;
      for (let refresh = 0; refresh < 2; refresh++) {
        const response = await GET();
        expect((await response.json()).connected).toBe(true);
      }
    }
    expect(state.writes).toEqual([]);
    expect(state.configFilters.every(([column, value]) => column === 'account_id' && value === 'shared-account')).toBe(true);
    expect(state.verify).toHaveBeenCalledWith({ phoneNumberId: 'test-phone', accessToken: 'test-access' });
  });
  it('lets an admin save using both stored secrets unchanged', async () => {
    state.userId = 'team-user'; state.role = 'admin';
    const before = { ...state.saved };
    const response = await save();
    expect(response.status).toBe(200);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].access_token).toBe(before.access_token);
    expect(state.writes[0].verify_token).toBe(before.verify_token);
    expect(state.writes[0].registered_at).toBe(before.registered_at);
    expect(JSON.stringify(await response.json())).not.toContain('test-access');
  });
  it('does not interpret a failed read as permission to create or overwrite credentials', async () => {
    state.readError = true;
    expect((await save()).status).toBe(503);
    expect(state.writes).toEqual([]);
    expect(state.verify).not.toHaveBeenCalled();
  });
  it('blocks agent credential edits before any Meta request', async () => {
    state.role = 'agent';
    expect((await save()).status).toBe(403);
    expect(state.writes).toEqual([]);
    expect(state.verify).not.toHaveBeenCalled();
  });
  it('requires a token only for first-time setup', async () => {
    state.saved = null;
    expect((await save()).status).toBe(400);
    expect(state.writes).toEqual([]);
  });
});
