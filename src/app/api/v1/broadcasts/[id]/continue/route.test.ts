import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ plan: vi.fn(), enqueue: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: vi.fn().mockResolvedValue({ supabase: {}, accountId: 'account' }) }));
vi.mock('@/lib/whatsapp/broadcast-resume', () => ({ planBroadcastResume: h.plan, RESUME_SCOPES: ['pending', 'failed', 'all'] }));
vi.mock('@/lib/whatsapp/broadcast-queue-runtime', () => ({ enqueueBroadcast: h.enqueue }));
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { POST } from './route';

describe('broadcast continue', () => {
  beforeEach(() => { vi.clearAllMocks(); h.enqueue.mockResolvedValue(undefined); });
  it('returns the pause reason without acknowledgement', async () => {
    h.plan.mockRejectedValue(new BroadcastError('broadcast_paused', 'Broadcast paused: Meta error 131048', 409));
    const response = await POST(new Request('https://example.test', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: 'bc' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'broadcast_paused', message: expect.stringContaining('131048') } });
    expect(h.plan).toHaveBeenCalledWith(expect.anything(), 'account', 'bc', 'pending', false);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('passes the explicit acknowledgement and scope to the planner', async () => {
    h.plan.mockResolvedValue({ plan: { planned: [] }, remaining: 0 });
    const response = await POST(new Request('https://example.test', { method: 'POST', body: JSON.stringify({ scope: 'all', acknowledge_pause: true }) }), { params: Promise.resolve({ id: 'bc' }) });
    expect(response.status).toBe(202);
    expect(h.plan).toHaveBeenCalledWith(expect.anything(), 'account', 'bc', 'all', true);
    expect(h.enqueue).toHaveBeenCalledWith({ account_id: 'account', broadcast_id: 'bc' });
  });
});
