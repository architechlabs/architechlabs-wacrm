import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ send: vi.fn(), save: vi.fn(), reserve: vi.fn().mockResolvedValue({ id: 'm', conversationId: 'c', text: 'hello' }) }));
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTemplateMessage: mocks.send, MetaApiError: class extends Error {} }));
vi.mock('@/lib/whatsapp/broadcast-message', () => ({ reserveBroadcastMessage: mocks.reserve, finishBroadcastMessage: mocks.save }));
import { deliverBroadcastRecipient, type BroadcastPlan } from './broadcast-core';

const plan: BroadcastPlan = { accountId: 'a', auditUserId: 'u', configId: 'line', broadcastId: 'b', templateName: 'hello', templateLanguage: 'en', phoneNumberId: 'meta-line', accessToken: 'test', templateRow: null, planned: [], rejected: 0 };
const recipient = { recipientRowId: 'r', phone: '919999999999', params: [] };

describe('recipient claim', () => {
  it('never sends for a claimed recipient or an opt-out', async () => {
    mocks.send.mockClear();
    for (const state of ['unavailable', 'skipped_opt_out']) {
      const db = { rpc: vi.fn().mockResolvedValue({ data: state, error: null }) } as unknown as SupabaseClient;
      expect((await deliverBroadcastRecipient(db, plan, recipient)).status).toBe(state);
    }
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('sends on the chosen number only after a successful claim', async () => {
    mocks.send.mockReset().mockResolvedValue({ messageId: 'wamid.1' });
    mocks.save.mockReset().mockResolvedValue(undefined);
    const db = { rpc: vi.fn().mockResolvedValue({ data: 'claimed', error: null }), from: () => ({ update: () => ({ eq: vi.fn().mockResolvedValue({ error: null }) }) }) } as unknown as SupabaseClient;
    expect((await deliverBroadcastRecipient(db, plan, recipient)).status).toBe('sent');
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'meta-line' }));
    expect(mocks.save).toHaveBeenCalledOnce();
  });
  it('does not call Meta when the inbox message cannot be prepared', async () => {
    mocks.send.mockReset();
    mocks.reserve.mockRejectedValueOnce(new Error('database unavailable'));
    const db = { rpc: vi.fn().mockResolvedValue({ data: 'claimed', error: null }), from: () => ({ update: () => ({ eq: vi.fn().mockResolvedValue({ error: null }) }) }) } as unknown as SupabaseClient;
    expect((await deliverBroadcastRecipient(db, plan, recipient)).status).toBe('failed');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
