import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { continueBroadcastAutomatically } from './broadcast-continuation';

function database(paused: boolean): SupabaseClient {
  return { from: (table: string) => {
    const builder = { select: () => builder, eq: () => builder, is: () => builder,
      maybeSingle: async () => ({ data: { delivery_paused_at: paused ? 'now' : null }, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ count: table === 'broadcast_recipients' ? 20 : 0, error: null }) };
    return builder;
  } } as unknown as SupabaseClient;
}
afterEach(() => vi.unstubAllGlobals());
describe('automatic broadcast continuation', () => {
  it('starts the next batch on the trusted CRM host', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetchMock);
    await continueBroadcastAutomatically(database(false), 'account', 'broadcast', 'https://whatsapp.architechlabs.in/api/v1/broadcasts', 'Bearer test');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://whatsapp.architechlabs.in/api/v1/broadcasts/broadcast/continue');
  });
  it('never forwards credentials to another host or continues a paused campaign', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await continueBroadcastAutomatically(database(false), 'account', 'b', 'https://example.com', 'Bearer test');
    await continueBroadcastAutomatically(database(true), 'account', 'b', 'https://whatsapp.architechlabs.in', 'Bearer test');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
