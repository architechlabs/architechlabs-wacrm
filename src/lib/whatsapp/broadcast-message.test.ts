import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';

const { resolveConversationByPhone } = vi.hoisted(() => ({ resolveConversationByPhone: vi.fn() }));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone }));
import { reserveBroadcastMessage, saveBroadcastMessage } from './broadcast-message';

describe('saveBroadcastMessage', () => {
  beforeEach(() => resolveConversationByPhone.mockResolvedValue({ conversationId: 'conv' }));

  it('saves rendered outbound template in the conversation for the selected number', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const db = { from: (table: string) => table === 'messages' ? { upsert } : { update } } as unknown as SupabaseClient;
    await saveBroadcastMessage(db, {
      accountId: 'account', userId: 'user', configId: 'line', broadcastId: 'broadcast',
      phone: '918796778485', messageId: 'wamid.1', templateName: 'hello',
      template: { body_text: 'Hello {{1}}' } as MessageTemplate, params: ['Asha'],
    });
    expect(resolveConversationByPhone).toHaveBeenCalledWith(db, 'account', '918796778485', null, 'user', null, 'line');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: 'conv', sender_type: 'agent', content_type: 'template',
      content_text: 'Hello Asha', message_id: 'wamid.1', broadcast_id: 'broadcast',
    }), { onConflict: 'conversation_id,message_id', ignoreDuplicates: true });
  });

  it('reports an inbox write error without issuing another Meta send', async () => {
    const db = { from: () => ({ upsert: vi.fn().mockResolvedValue({ error: { message: 'write failed' } }) }) } as unknown as SupabaseClient;
    await expect(saveBroadcastMessage(db, {
      accountId: 'account', userId: 'user', configId: 'line', phone: '918796778485',
      messageId: 'wamid.1', templateName: 'hello', template: null, params: [],
    })).rejects.toThrow('write failed');
  });

  it('reserves the rendered outgoing message on the selected sender line before sending', async () => {
    const insert = vi.fn().mockReturnValue({ select: () => ({ single: async () => ({ data: { id: 'reserved' }, error: null }) }) });
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const db = { from: (table: string) => table === 'messages' ? { insert } : { update } } as unknown as SupabaseClient;
    const reserved = await reserveBroadcastMessage(db, { accountId: 'account', userId: 'user', configId: 'line', broadcastId: 'broadcast', phone: '919999999999', templateName: 'hello', template: { body_text: 'Hi {{1}}' } as MessageTemplate, params: ['Asha'] });
    expect(reserved.id).toBe('reserved');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: 'conv', content_text: 'Hi Asha', sender_type: 'agent', status: 'sending' }));
    expect(resolveConversationByPhone).toHaveBeenCalledWith(db, 'account', '919999999999', null, 'user', null, 'line');
  });
});
