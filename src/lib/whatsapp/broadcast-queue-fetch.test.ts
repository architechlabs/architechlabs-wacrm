import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: h.createClient }));
import { processBroadcastQueue } from './broadcast-queue-worker';

describe('broadcast queue Supabase fetch', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('uses manual redirects and rejects 3xx without following the location', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://untrusted.example/' } }));
    vi.stubGlobal('fetch', fetcher);
    h.createClient.mockReturnValue({});
    await processBroadcastQueue({ messages: [] }, { NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key', BROADCAST_QUEUE: { send: vi.fn() } });
    const queueFetch: typeof fetch = h.createClient.mock.calls[0][2].global.fetch;
    const controller = new AbortController();
    await expect(queueFetch('https://example.supabase.co/rest/v1/broadcasts', { signal: controller.signal })).rejects.toThrow('Supabase redirect rejected');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
  });

  it('rejects opaque redirects and passes successful responses through', async () => {
    const opaque = { status: 0, type: 'opaqueredirect', body: null } as Response;
    const fetcher = vi.fn().mockResolvedValueOnce(opaque).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    h.createClient.mockReturnValue({});
    await processBroadcastQueue({ messages: [] }, { NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key', BROADCAST_QUEUE: { send: vi.fn() } });
    const queueFetch: typeof fetch = h.createClient.mock.calls[0][2].global.fetch;
    await expect(queueFetch('https://example.supabase.co/')).rejects.toThrow('Supabase redirect rejected');
    expect((await queueFetch('https://example.supabase.co/')).status).toBe(200);
  });
});
