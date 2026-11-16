import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ configs: [] as unknown[], rows: [] as Record<string, unknown>[], insertError: null as null | { message: string }, updated: false }));
vi.mock('@/lib/auth/account', () => ({
  UnauthorizedError: class extends Error {}, ForbiddenError: class extends Error {},
  toErrorResponse: () => new Response(null, { status: 403 }),
  requireRole: async () => ({ accountId: 'account', userId: 'admin', supabase: {
    rpc: async (_name: string, args: { p_config_id: string; p_template: Record<string, unknown> }) => { h.configs.push(args.p_config_id); h.rows.push(args.p_template); return { data: h.insertError ? null : [{ was_inserted: !h.updated }], error: h.insertError }; },
  } }),
}));
vi.mock('@/lib/whatsapp/resolve-config', () => ({ resolveWhatsAppConfig: async (_db: unknown, args: { configId: string }) => ({ id: args.configId, waba_id: 'waba-1', access_token: 'encrypted' }) }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'test-token' }));
vi.mock('@/lib/whatsapp/meta-api', () => ({ graphApiBase: () => 'https://graph.facebook.com/v21.0' }));
import { POST } from './route';

describe('template sync', () => {
  beforeEach(() => { h.rows = []; h.configs = []; h.insertError = null; h.updated = false; });
  afterEach(() => vi.unstubAllGlobals());
  it('reads every page and imports approved marketing templates and both languages for the WABA', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: '1', name: 'welcome_greeting', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hello' }] }], paging: { next: 'https://graph.facebook.com/v21.0/waba-1/message_templates?after=next' } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: '2', name: 'welcome_greeting', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi' }] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(new Request('https://crm.test', { method: 'POST', body: JSON.stringify({ whatsapp_config_id: 'line-1' }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, total: 2, inserted: 2 });
    expect(h.rows).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'welcome_greeting', language: 'en', waba_id: 'waba-1', status: 'APPROVED', category: 'Marketing', meta_components: [{ type: 'BODY', text: 'Hello' }] }), expect.objectContaining({ name: 'welcome_greeting', language: 'en_US' })]));
    expect(h.configs).toEqual(['line-1', 'line-1']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('reports legacy rows updated rather than inserted', async () => {
    h.updated = true;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'new-meta-id', name: 'welcome_greeting', language: 'en', status: 'APPROVED', category: 'MARKETING' }] })));
    const response = await POST(new Request('https://crm.test', { method: 'POST', body: JSON.stringify({ whatsapp_config_id: 'line-1' }) }));
    expect(await response.json()).toMatchObject({ success: true, updated: 1, inserted: 0 });
    expect(h.rows[0]).toMatchObject({ name: 'welcome_greeting', meta_template_id: 'new-meta-id' });
  });
  it('returns a visible partial failure when a database insert fails', async () => {
    h.insertError = { message: 'permission denied' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [{ id: '1', name: 'welcome_greeting', language: 'en', status: 'APPROVED', category: 'MARKETING' }] })));
    const response = await POST(new Request('https://crm.test', { method: 'POST', body: '{}' }));
    expect(await response.json()).toMatchObject({ success: false, errors: [{ name: 'welcome_greeting', message: 'permission denied' }] });
  });
});
