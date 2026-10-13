import { randomUUID } from 'node:crypto';
import type { ApiKeyContext } from '@/lib/auth/api-context';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { enforceTemplateDeliveryRestriction } from '@/lib/whatsapp/send-message';
import { DocumentDeliveryError, type DocumentPolicy, type PreparedDocument } from './contracts';
import type { DeliveryRecord, DocumentDeliveryStore } from './service';

const recordColumns = 'id,admin_document_fingerprint,admin_document_state,message_id';
interface MessageRecord {
  id: string;
  admin_document_fingerprint: string;
  admin_document_state: DeliveryRecord['state'];
  message_id: string | null;
}
function deliveryRecord(row: MessageRecord): DeliveryRecord {
  return {
    id: row.id, fingerprint: row.admin_document_fingerprint, state: row.admin_document_state,
    // Public API messageId is the inbox UUID, NOT Meta's wamid.
    messageId: row.message_id ? row.id : null,
  };
}

/** One durable inbox row per logical document send; no separate outbox. */
export class SupabaseDocumentDeliveryStore implements DocumentDeliveryStore {
  constructor(private readonly ctx: ApiKeyContext) {}
  private get db() { return this.ctx.supabase; }
  async reserve(doc: PreparedDocument, policy: DocumentPolicy): Promise<DeliveryRecord | null> {
    // A later contact edit or webhook failure must never turn a duplicate into a resend.
    if (await this.find(doc.key)) return null;
    const resolved = await resolveConversationByPhone(this.db, this.ctx.accountId, doc.to, null);
    const { data: contact, error: contactError } = await this.db.from('contacts').select('phone')
      .eq('account_id', this.ctx.accountId).eq('id', resolved.contactId).single();
    // The shared resolver supports fuzzy matching. Financial documents do not.
    if (contactError || contact?.phone?.replace(/\D/g, '') !== doc.to.slice(1)) {
      throw new DocumentDeliveryError('recipient_not_exact', 409);
    }
    await enforceTemplateDeliveryRestriction(this.db, resolved.conversationId, policy.name);
    const id = randomUUID();
    const { data, error } = await this.db.from('messages').insert({
      id, conversation_id: resolved.conversationId, sender_type: 'agent', content_type: 'template',
      content_text: doc.renderedBody, template_name: policy.name, status: 'sending',
      media_url: `/api/document-deliveries/${id}/pdf`, media_type: 'application/pdf',
      // Not client_request_id: the generic composer can retry failed attempts.
      // Document reservations, including uncertain ones, must NEVER be reused.
      admin_document_account_id: this.ctx.accountId, admin_document_key: doc.key,
      admin_document_fingerprint: doc.fingerprint, admin_document_state: 'reserved',
      admin_document_metadata: {
        kind: doc.kind, documentNumber: doc.documentNumber, revision: doc.revision ?? null,
        recipient: doc.to, pdfSha256: doc.pdfSha256, filename: doc.filename,
        apiKeyId: this.ctx.keyId, consentConfirmedAt: new Date().toISOString(),
        metaTemplateId: policy.metaTemplateId, language: policy.language,
      },
    }).select(recordColumns).single();
    if (error?.code === '23505') return null;
    if (error || !data) throw new DocumentDeliveryError('document_storage_unavailable',503);
    return deliveryRecord(data);
  }
  async find(key: string): Promise<DeliveryRecord | null> {
    const { data, error } = await this.db.from('messages').select(recordColumns)
      .eq('admin_document_account_id',this.ctx.accountId).eq('admin_document_key',key).maybeSingle();
    if (error) throw new DocumentDeliveryError('document_storage_unavailable',503);
    return data ? deliveryRecord(data) : null;
  }
  async prepareMessage(record: DeliveryRecord, doc: PreparedDocument, policy: DocumentPolicy) {
    const { data, error } = await this.db.from('messages').select('id')
      .eq('admin_document_account_id',this.ctx.accountId).eq('id',record.id)
      .eq('admin_document_key',doc.key).eq('admin_document_fingerprint',doc.fingerprint)
      .eq('admin_document_state','reserved').eq('template_name',policy.name).single();
    if (error || !data) throw new DocumentDeliveryError('document_storage_unavailable',503);
    return data.id as string;
  }
  private async update(id: string, values: Record<string,unknown>) {
    const { data, error } = await this.db.from('messages').update(values)
      .eq('admin_document_account_id',this.ctx.accountId).eq('id',id).eq('admin_document_state','reserved')
      .select('id,conversation_id,content_text').single();
    if (error || !data) throw new DocumentDeliveryError('document_storage_unavailable',503);
    return data;
  }
  async recordMedia(id: string, mediaId: string) { await this.update(id,{admin_document_media_id:mediaId}); }
  async accept(id: string, messageId: string, whatsappId: string) {
    if (id !== messageId) throw new DocumentDeliveryError('document_delivery_conflict');
    // Atomic acknowledgement + state. Do not overwrite an early delivered/read webhook.
    const data = await this.update(id,{message_id:whatsappId,admin_document_state:'accepted'});
    // Best-effort list preview only; its failure must not resubmit an accepted message.
    try {
      await this.db.from('messages').update({status:'sent'})
        .eq('admin_document_account_id',this.ctx.accountId).eq('id',id).eq('status','sending');
      await this.db.from('conversations').update({last_message_text:data.content_text,last_message_at:new Date().toISOString(),updated_at:new Date().toISOString()})
        .eq('account_id',this.ctx.accountId).eq('id',data.conversation_id);
    } catch { /* The acknowledged inbox record is authoritative; do not resubmit. */ }
  }
  async unknown(id: string) {
    await this.update(id,{admin_document_state:'unknown',status:'failed',failure_code:null,
      failure_reason:'Delivery is unconfirmed. Review before any further send; no automatic retry.'});
  }
}
