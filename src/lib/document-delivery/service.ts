import { DocumentDeliveryError, type DocumentPolicy, type PreparedDocument } from './contracts';

export interface DeliveryRecord { id: string; fingerprint: string; state: 'reserved' | 'accepted' | 'unknown'; messageId: string | null }
export interface DocumentDeliveryStore {
  reserve(document: PreparedDocument): Promise<DeliveryRecord | null>;
  find(key: string): Promise<DeliveryRecord | null>;
  prepareMessage(record: DeliveryRecord, document: PreparedDocument, policy: DocumentPolicy): Promise<string>;
  recordMedia(id: string, mediaId: string): Promise<void>;
  accept(id: string, messageId: string, whatsappId: string): Promise<void>;
  unknown(id: string): Promise<void>;
}
export interface DocumentTransport {
  verifyTemplate(policy: DocumentPolicy): Promise<void>;
  upload(document: PreparedDocument): Promise<string>;
  send(policy: DocumentPolicy, document: PreparedDocument, mediaId: string): Promise<string>;
}
export async function deliverDocument(store: DocumentDeliveryStore, transport: DocumentTransport, policy: DocumentPolicy, document: PreparedDocument) {
  // Reserve before any upload/send. Uncertain sends are NEVER retried automatically.
  const record = await store.reserve(document);
  if (!record) {
    const existing = await store.find(document.key);
    if (!existing || existing.fingerprint !== document.fingerprint) throw new DocumentDeliveryError('document_delivery_conflict');
    if (existing.state !== 'accepted' || !existing.messageId) throw new DocumentDeliveryError('document_delivery_unconfirmed');
    return { deliveryId: existing.id, messageId: existing.messageId, status: 'accepted' as const, alreadySent: true };
  }
  try {
    await transport.verifyTemplate(policy);
    // Persist the inbox row before sending, so a DB outage cannot trigger an untracked send.
    const messageId = await store.prepareMessage(record, document, policy);
    const mediaId = await transport.upload(document);
    await store.recordMedia(record.id, mediaId);
    const whatsappId = await transport.send(policy, document, mediaId);
    await store.accept(record.id, messageId, whatsappId);
    return { deliveryId: record.id, messageId, status: 'accepted' as const, alreadySent: false };
  } catch (error) {
    await store.unknown(record.id).catch(() => undefined);
    if (error instanceof DocumentDeliveryError && error.code === 'template_not_verified') throw error;
    throw new DocumentDeliveryError('document_delivery_unconfirmed',502);
  }
}
