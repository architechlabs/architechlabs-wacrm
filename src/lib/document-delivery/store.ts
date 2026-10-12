import type { ApiKeyContext } from '@/lib/auth/api-context';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { enforceTemplateDeliveryRestriction } from '@/lib/whatsapp/send-message';
import { DocumentDeliveryError, type DocumentPolicy, type PreparedDocument } from './contracts';
import type { DeliveryRecord, DocumentDeliveryStore } from './service';

export class SupabaseDocumentDeliveryStore implements DocumentDeliveryStore {
  constructor(private readonly ctx: ApiKeyContext) {}
  private get db() { return this.ctx.supabase; }
  async reserve(doc: PreparedDocument): Promise<DeliveryRecord | null> {
    const { data, error } = await this.db.from('admin_document_deliveries').insert({
      account_id:this.ctx.accountId,api_key_id:this.ctx.keyId,delivery_key:doc.key,fingerprint:doc.fingerprint,
      document_kind:doc.kind,document_number:doc.documentNumber,document_revision:doc.revision ?? null,recipient:doc.to,pdf_sha256:doc.pdfSha256,filename:doc.filename,
    }).select('id,fingerprint,state,message_id').single();
    if (error?.code === '23505') return null;
    if (error || !data) throw new DocumentDeliveryError('document_storage_unavailable',503);
    return { id:data.id,fingerprint:data.fingerprint,state:data.state,messageId:data.message_id };
  }
  async find(key: string): Promise<DeliveryRecord | null> {
    const { data, error } = await this.db.from('admin_document_deliveries').select('id,fingerprint,state,message_id')
      .eq('account_id',this.ctx.accountId).eq('delivery_key',key).maybeSingle();
    if (error) throw new DocumentDeliveryError('document_storage_unavailable',503);
    return data ? { id:data.id,fingerprint:data.fingerprint,state:data.state,messageId:data.message_id } : null;
  }
  async prepareMessage(record: DeliveryRecord, doc: PreparedDocument, policy: DocumentPolicy) {
    const resolved = await resolveConversationByPhone(this.db,this.ctx.accountId,doc.to,null);
    // The generic contact resolver supports fuzzy matching. Financial documents must not.
    const { data:contact, error:contactError } = await this.db.from('contacts').select('phone')
      .eq('account_id',this.ctx.accountId).eq('id',resolved.contactId).single();
    if (contactError || contact?.phone?.replace(/\D/g,'') !== doc.to.slice(1)) throw new DocumentDeliveryError('recipient_not_exact',409);
    await enforceTemplateDeliveryRestriction(this.db,resolved.conversationId,policy.name);
    const { data, error } = await this.db.from('messages').insert({
      conversation_id:resolved.conversationId,sender_type:'agent',content_type:'template',content_text:doc.renderedBody,
      template_name:policy.name,status:'sending',media_url:`/api/document-deliveries/${record.id}/pdf`,media_type:'application/pdf',
    }).select('id').single();
    if (error || !data) throw new DocumentDeliveryError('document_storage_unavailable',503);
    await this.update(record.id,{message_id:data.id});
    return data.id as string;
  }
  private async update(id: string, values: Record<string,unknown>) {
    const { data, error } = await this.db.from('admin_document_deliveries').update(values)
      .eq('account_id',this.ctx.accountId).eq('id',id).eq('state','reserved').select('id').single();
    if (error || !data) throw new DocumentDeliveryError('document_storage_unavailable',503);
  }
  recordMedia(id: string, mediaId: string) { return this.update(id,{meta_media_id:mediaId}); }
  async accept(id: string, messageId: string, whatsappId: string) {
    // Write only the wamid, not status: an early webhook may already have marked delivered/read.
    const { data, error } = await this.db.from('messages').update({message_id:whatsappId})
      .eq('id',messageId).select('id,conversation_id,content_text').single();
    if (error || !data) throw new DocumentDeliveryError('document_storage_unavailable',503);
    await this.db.from('messages').update({status:'sent'}).eq('id',messageId).eq('status','sending');
    await this.update(id,{state:'accepted',whatsapp_message_id:whatsappId});
    // Best-effort list preview only; its failure must not resubmit an accepted message.
    try {
      await this.db.from('conversations').update({last_message_text:data.content_text,last_message_at:new Date().toISOString(),updated_at:new Date().toISOString()})
        .eq('account_id',this.ctx.accountId).eq('id',data.conversation_id);
    } catch { /* The accepted outbox record is authoritative; do not resubmit. */ }
  }
  unknown(id: string) { return this.update(id,{state:'unknown'}); }
}
