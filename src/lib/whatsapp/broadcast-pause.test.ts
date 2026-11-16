import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deliverBroadcast, type BroadcastPlan } from './broadcast-core';
import { MetaApiError, sendTemplateMessage } from './meta-api';

vi.mock('./meta-api', async (original) => ({ ...(await original<typeof import('./meta-api')>()), sendTemplateMessage: vi.fn() }));
vi.mock('./broadcast-message', () => ({ reserveBroadcastMessage: vi.fn().mockResolvedValue({ id: 'msg', conversationId: 'conv' }), finishBroadcastMessage: vi.fn() }));

function fixture() {
  const writes: { table: string; value: Record<string, unknown> }[] = [];
  const db = {
    rpc: () => Promise.resolve({ data: 'claimed', error: null }),
    from(table: string) {
      const chain = {
        update(value: Record<string, unknown>) { writes.push({ table, value }); return chain; },
        select() { return chain; }, eq() { return chain; },
        then(resolve: (result: { error: null; count: number }) => unknown) { return Promise.resolve(resolve({ error: null, count: 0 })); },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  const plan: BroadcastPlan = { accountId: 'account', auditUserId: 'user', configId: 'line', broadcastId: 'broadcast', templateName: 'welcome', templateLanguage: 'en', phoneNumberId: 'line', accessToken: 'token', templateRow: null, rejected: 0,
    planned: [{ recipientRowId: '1', phone: '919999999999', params: [] }, { recipientRowId: '2', phone: '918888888888', params: [] }] };
  return { db, plan, writes };
}

describe('broadcast send-time errors', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([[131049, 2, false], [131048, 1, true], [130429, 1, true]])('handles Meta error %s', async (code, sends, pauses) => {
    const { db, plan, writes } = fixture();
    vi.mocked(sendTemplateMessage).mockRejectedValueOnce(new MetaApiError('Meta error', code)).mockResolvedValue({ messageId: 'wamid.2' } as Awaited<ReturnType<typeof sendTemplateMessage>>);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await deliverBroadcast(db, plan);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(sends);
    expect(writes.some(w => w.table === 'broadcasts' && 'delivery_paused_at' in w.value)).toBe(pauses);
    expect(writes).toContainEqual(expect.objectContaining({ table: 'broadcast_recipients', value: expect.objectContaining({ status: 'failed', error_code: code }) }));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
