import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyContext } from '@/lib/auth/api-context';
import { prepareDocument, type DocumentPolicy } from './contracts';
import { SupabaseDocumentDeliveryStore } from './store';
import { deliverDocument } from './service';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), restriction: vi.fn() }));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone: mocks.resolve }));
vi.mock('@/lib/whatsapp/send-message', () => ({ enforceTemplateDeliveryRestriction: mocks.restriction }));
const accountId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const policy: DocumentPolicy = { kind: 'quotation', name: 'quotation_pdf', language: 'en_US', metaTemplateId: '123', bodyText: 'Dear {{1}}, quotation {{2}}.', fields: ['customerName', 'documentNumber'] };
const doc = prepareDocument({ kind: 'quotation', revision: 1, documentNumber: 'Q/1', to: '+919876543210', consentConfirmed: true, fields: { customerName: 'Example', documentNumber: 'Q/1' }, pdfBase64: Buffer.from('%PDF-fixture').toString('base64') }, policy);
function query(data: unknown, error: unknown = null) {
  return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(),
    single: vi.fn(async () => ({ data, error })), maybeSingle: vi.fn(async () => ({ data, error })) };
}
function setup(...responses: ReturnType<typeof query>[]) {
  const from = vi.fn(); for (const response of responses) from.mockReturnValueOnce(response);
  const store = new SupabaseDocumentDeliveryStore({ accountId, keyId: id, supabase: { from } } as unknown as ApiKeyContext);
  return { store, from };
}
describe('document reservations in messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue({ contactId: 'contact', conversationId: 'conversation' });
    mocks.restriction.mockResolvedValue(undefined);
  });
  it('persists exactly one inbox row with immutable identity, recipient, consent and PDF hash', async () => {
    const lookup = query(null), contact = query({ phone: '919876543210' });
    const reservation = query({ id, admin_document_fingerprint: doc.fingerprint, admin_document_state: 'reserved', message_id: null });
    const { store, from } = setup(lookup, contact, reservation);
    expect(await store.reserve(doc, policy)).toMatchObject({ id, state: 'reserved', messageId: null });
    expect(from.mock.calls.map(call => call[0])).toEqual(['messages', 'contacts', 'messages']);
    const payload = reservation.insert.mock.calls[0][0];
    expect(payload).toMatchObject({ admin_document_account_id: accountId, admin_document_key: doc.key, admin_document_fingerprint: doc.fingerprint, status: 'sending', template_name: policy.name,
      admin_document_metadata: { recipient: doc.to, pdfSha256: doc.pdfSha256, apiKeyId: id } });
    expect(payload.media_url).toBe(`/api/document-deliveries/${payload.id}/pdf`);
    expect(payload).not.toHaveProperty('client_request_id');
    expect(JSON.stringify(payload)).not.toContain(doc.pdfBase64);
    expect(lookup.eq).toHaveBeenCalledWith('admin_document_account_id', accountId);
    expect(contact.eq).toHaveBeenCalledWith('account_id', accountId);
  });
  it('blocks fuzzy/changed recipients before reservation or provider work', async () => {
    const { store, from } = setup(query(null), query({ phone: '919876543211' }));
    await expect(store.reserve(doc, policy)).rejects.toMatchObject({ code: 'recipient_not_exact' });
    expect(from).toHaveBeenCalledTimes(2); expect(mocks.restriction).not.toHaveBeenCalled();
  });
  it('lets the database unique index arbitrate concurrent inserts', async () => {
    const { store } = setup(query(null), query({ phone: '919876543210' }), query(null, { code: '23505' }));
    expect(await store.reserve(doc, policy)).toBeNull();
  });
  it('fails closed when migration/index/storage is unavailable before any Meta call', async () => {
    const { store } = setup(query(null, { code: '42703', message: 'PRIVATE DETAIL' }));
    const transport = { verifyTemplate: vi.fn(), upload: vi.fn(), send: vi.fn() };
    await expect(deliverDocument(store, transport, policy, doc)).rejects.toMatchObject({ code: 'document_storage_unavailable' });
    expect(transport.verifyTemplate).not.toHaveBeenCalled(); expect(transport.send).not.toHaveBeenCalled();
  });
  it('returns acknowledged duplicates without resolving contacts or calling Meta again', async () => {
    const acknowledged = { id, admin_document_fingerprint: doc.fingerprint, admin_document_state: 'accepted', message_id: 'wamid.example' };
    const { store } = setup(query(acknowledged), query(acknowledged));
    const transport = { verifyTemplate: vi.fn(), upload: vi.fn(), send: vi.fn() };
    expect(await deliverDocument(store, transport, policy, doc)).toEqual({ deliveryId: id, messageId: id, status: 'accepted', alreadySent: true });
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(transport.send).not.toHaveBeenCalled();
  });
  it('never reuses an uncertain reservation, even if its inbox status is failed', async () => {
    const uncertain = { id, admin_document_fingerprint: doc.fingerprint, admin_document_state: 'unknown', message_id: null, status: 'failed' };
    const { store } = setup(query(uncertain), query(uncertain));
    const transport = { verifyTemplate: vi.fn(), upload: vi.fn(), send: vi.fn() };
    await expect(deliverDocument(store, transport, policy, doc)).rejects.toMatchObject({ code: 'document_delivery_unconfirmed' });
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(transport.send).not.toHaveBeenCalled();
  });
  it('uses the reserved row rather than inserting a second message', async () => {
    const message = query({ id }); const { store, from } = setup(message);
    expect(await store.prepareMessage({ id, fingerprint: doc.fingerprint, state: 'reserved', messageId: null }, doc, policy)).toBe(id);
    expect(from).toHaveBeenCalledExactlyOnceWith('messages'); expect(message.insert).not.toHaveBeenCalled();
    expect(message.eq).toHaveBeenCalledWith('admin_document_fingerprint', doc.fingerprint);
  });
  it('records acceptance atomically and updates status only if still sending', async () => {
    const accepted = query({ id, conversation_id: 'conversation', content_text: doc.renderedBody });
    const status = query(null), preview = query(null); const { store } = setup(accepted, status, preview);
    await store.accept(id, id, 'wamid.example');
    expect(accepted.update).toHaveBeenCalledExactlyOnceWith({ message_id: 'wamid.example', admin_document_state: 'accepted' });
    expect(accepted.eq).toHaveBeenCalledWith('admin_document_state', 'reserved');
    expect(status.eq).toHaveBeenCalledWith('status', 'sending');
    expect(status.eq).toHaveBeenCalledWith('admin_document_account_id', accountId);
  });
  it('persists unknown without a made-up provider error code or automatic retry', async () => {
    const message = query({ id }); const { store } = setup(message);
    await store.unknown(id);
    expect(message.update).toHaveBeenCalledWith(expect.objectContaining({ admin_document_state: 'unknown', status: 'failed', failure_code: null }));
    expect(message.eq).toHaveBeenCalledWith('admin_document_state', 'reserved');
  });
});
