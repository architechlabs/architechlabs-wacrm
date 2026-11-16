import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), log: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: mocks.auth }));
vi.mock('@/lib/whatsapp/external-message-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/external-message-log')>()),
  logExternalMessage: mocks.log,
}));

describe('POST external message log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ supabase: {}, accountId: 'account' });
    mocks.log.mockResolvedValue({ message_id: 'id', conversation_id: 'c', wamid: 'wamid.1', duplicate: false });
  });
  it('uses message send authorization and performs no outbound HTTP', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await POST(new Request('https://example.test/api/v1/messages/log', { method: 'POST', body: JSON.stringify({ to: '919999999999', type: 'text', text: 'hello', wamid: 'wamid.1' }) }));
    expect(response.status).toBe(201);
    expect(mocks.auth.mock.calls[0][1]).toBe('messages:send');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it('returns one result per batch item', async () => {
    const response = await POST(new Request('https://example.test', { method: 'POST', body: JSON.stringify({ messages: [{}, {}] }) }));
    expect((await response.json()).data.results).toHaveLength(2);
  });
  it('returns 200 for a duplicate', async () => {
    mocks.log.mockResolvedValueOnce({ message_id: 'id', conversation_id: 'c', wamid: 'wamid.1', duplicate: true });
    const response = await POST(new Request('https://example.test', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(200);
  });
});
