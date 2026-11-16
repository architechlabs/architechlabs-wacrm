import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ExternalLogError, logExternalMessage } from './external-message-log';

const mocks = vi.hoisted(() => ({ config: vi.fn(), template: vi.fn(), conversation: vi.fn() }));
vi.mock('@/lib/whatsapp/resolve-config', () => ({ resolveWhatsAppConfig: mocks.config }));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: mocks.conversation }));
vi.mock('@/lib/whatsapp/template-body', async (original) => ({ ...(await original<typeof import('@/lib/whatsapp/template-body')>()), resolveTemplateRow: mocks.template }));

function database(existing: unknown[] = []) {
  const calls = { rpc: vi.fn().mockResolvedValue({ data: [{ message_id: 'db-id', conversation_id: 'conversation', duplicate: false }], error: null }) };
  const chain = { select: () => chain, eq: () => chain, limit: () => Promise.resolve({ data: existing, error: null }) };
  return { calls, db: { from: () => chain, rpc: calls.rpc } as unknown as SupabaseClient };
}

describe('external log service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.mockResolvedValue({ id: 'line', waba_id: 'waba' });
    mocks.conversation.mockResolvedValue({ conversationId: 'conversation', contactId: 'contact' });
    mocks.template.mockResolvedValue({ row: { language: 'en', body_text: 'old text', meta_components: [{ type: 'BODY', text: 'Hello {{1}}' }] }, malformed: false });
  });
  it('renders the synced body and passes all data to the atomic logger', async () => {
    const { db, calls } = database();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await logExternalMessage(db, 'account', { to: '919999999999', wamid: 'wamid.test', type: 'template', template_name: 'welcome_greeting', language: 'en', template_params: { body: ['Alice'] } });
    expect(calls.rpc).toHaveBeenCalledWith('log_external_message', expect.objectContaining({ p_content_text: 'Hello Alice', p_wamid: 'wamid.test', p_status: 'sent' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it('returns an existing message without resolving or writing anything', async () => {
    const { db, calls } = database([{ id: 'existing', conversation_id: 'original' }]);
    expect(await logExternalMessage(db, 'account', { to: '919999999999', wamid: 'wamid.test', type: 'text', text: 'Hello' })).toEqual({ message_id: 'existing', conversation_id: 'original', wamid: 'wamid.test', duplicate: true });
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(calls.rpc).not.toHaveBeenCalled();
  });
  it('rejects missing templates before creating a conversation', async () => {
    mocks.template.mockResolvedValue({ row: null, malformed: false });
    const { db } = database();
    await expect(logExternalMessage(db, 'account', { to: '919999999999', wamid: 'wamid.test', type: 'template', template_name: 'missing', language: 'en' })).rejects.toMatchObject({ status: 422 });
    expect(mocks.conversation).not.toHaveBeenCalled();
  });
  it('validates invalid input before touching the database', async () => {
    await expect(logExternalMessage({} as SupabaseClient, 'account', { to: 'bad' })).rejects.toBeInstanceOf(ExternalLogError);
  });
});
