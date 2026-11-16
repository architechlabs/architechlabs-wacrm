import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ create: vi.fn(), enqueue: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: vi.fn().mockResolvedValue({ supabase: {}, accountId: 'account' }) }));
vi.mock('@/lib/api/v1/contacts', () => ({ ContactError: class extends Error {}, resolveAuditUserId: vi.fn().mockResolvedValue('user') }));
vi.mock('@/lib/whatsapp/broadcast-core', () => ({ BroadcastError: class extends Error {}, createBroadcast: h.create }));
vi.mock('@/lib/whatsapp/broadcast-queue-runtime', () => ({ enqueueBroadcast: h.enqueue }));
import { POST } from './route';

describe('public broadcast launch', () => {
  beforeEach(() => { vi.clearAllMocks(); h.enqueue.mockResolvedValue(undefined); h.create.mockResolvedValue({ broadcastId: 'broadcast', planned: [{ recipientRowId: 'r1', phone: '919999999999', params: [] }], rejected: 0, recipientErrors: [] }); });
  it('persists and enqueues without sending', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const request = new Request('https://example.test/api/v1/broadcasts', { method: 'POST', body: JSON.stringify({ template_name: 'welcome_greeting', language: 'en', recipients: [{ to: '919999999999' }] }) });
    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(h.enqueue).toHaveBeenCalledWith({ account_id: 'account', broadcast_id: 'broadcast' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
