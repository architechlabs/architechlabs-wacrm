import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ create: vi.fn(), deliver: vi.fn(), after: vi.fn(), claim: vi.fn(), release: vi.fn() }));
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: h.after }));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: vi.fn().mockResolvedValue({ supabase: {}, accountId: 'account' }) }));
vi.mock('@/lib/api/v1/contacts', () => ({ ContactError: class extends Error {}, resolveAuditUserId: vi.fn().mockResolvedValue('user') }));
vi.mock('@/lib/whatsapp/broadcast-core', () => ({ BroadcastError: class extends Error {}, createBroadcast: h.create, deliverBroadcast: h.deliver }));
vi.mock('@/lib/whatsapp/broadcast-resume', () => ({ claimBroadcastDelivery: h.claim, releaseBroadcastDelivery: h.release }));
vi.mock('@/lib/whatsapp/broadcast-continuation', () => ({ continueBroadcastAutomatically: vi.fn() }));
import { POST } from './route';

describe('public broadcast launch', () => {
  beforeEach(() => { vi.clearAllMocks(); h.claim.mockResolvedValue('lock-token'); h.release.mockResolvedValue(undefined); h.create.mockResolvedValue({ broadcastId: 'broadcast', planned: [{ recipientRowId: 'r1', phone: '919999999999', params: [] }], rejected: 1, recipientErrors: [{ index: 1, phone: 'bad', reason: 'Invalid phone number' }] }); });
  it('accepts the bot language field and returns recipient results without sending in the request', async () => {
    const request = new Request('https://whatsapp.architechlabs.in/api/v1/broadcasts', { method: 'POST', body: JSON.stringify({ template_name: 'welcome_greeting', language: 'en', recipients: [{ to: '919999999999' }, { to: 'bad' }] }) });
    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ data: { broadcast_id: 'broadcast', accepted: 1, rejected: 1, recipient_errors: [{ index: 1 }] } });
    expect(h.create).toHaveBeenCalledWith(expect.anything(), 'account', 'user', expect.objectContaining({ templateName: 'welcome_greeting', templateLanguage: 'en' }));
    expect(h.after).toHaveBeenCalledOnce();
    expect(h.deliver).not.toHaveBeenCalled();
  });
  it('releases the owned lock when scheduling fails', async () => {
    h.after.mockImplementationOnce(() => { throw new Error('scheduling failed'); });
    const request = new Request('https://whatsapp.architechlabs.in/api/v1/broadcasts', { method: 'POST', body: JSON.stringify({ template_name: 'welcome_greeting', recipients: [] }) });
    expect((await POST(request)).status).toBe(500);
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'broadcast', 'lock-token');
  });
  it('releases the owned lock when delivery throws', async () => {
    h.deliver.mockRejectedValueOnce(new Error('delivery failed'));
    const request = new Request('https://whatsapp.architechlabs.in/api/v1/broadcasts', { method: 'POST', body: JSON.stringify({ template_name: 'welcome_greeting', recipients: [] }) });
    await POST(request);
    await expect(h.after.mock.calls[0][0]()).rejects.toThrow('delivery failed');
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'broadcast', 'lock-token');
  });
});
