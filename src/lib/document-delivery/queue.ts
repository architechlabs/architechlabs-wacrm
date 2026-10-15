import { randomUUID } from 'node:crypto';
import { DocumentDeliveryError, prepareDocument, type DocumentInput, type DocumentPolicy, type PreparedDocument } from './contracts';
import { validateDocumentPdf } from './pdf';
import type { DeliveryRecord, DocumentDeliveryStore, DocumentTransport } from './service';
import { JOB_TTL_MS, parseDocumentJob, type DocumentJob } from './queue-job';
export { JOB_TTL_MS, parseDocumentJob, documentObjectKey, type DocumentJob } from './queue-job';
export interface DocumentPayload { document: DocumentInput; policy: DocumentPolicy }
export interface PayloadStore {
  put(job: DocumentJob, payload: DocumentPayload): Promise<void>;
  get(job: DocumentJob): Promise<DocumentPayload>;
  delete(job: DocumentJob): Promise<void>;
}
export interface JobQueue { send(job: DocumentJob): Promise<void> }
export interface ClaimStore {
  // Must atomically set a permanent claim on the existing, account-scoped row.
  // A worker death does NOT expire the claim or authorize a second Meta send.
  claim(job: DocumentJob, claimId: string): Promise<boolean>;
}
function input(document: PreparedDocument): DocumentInput {
  return {kind:document.kind,documentNumber:document.documentNumber,to:document.to,consentConfirmed:true,
    fields:document.fields,pdfBase64:document.pdfBase64,...(document.revision === undefined ? {} : {revision:document.revision}),
    ...(document.paymentReceivedConfirmed === true ? {paymentReceivedConfirmed:true as const} : {})};
}
/** Reserve one Inbox row, persist the encrypted payload, then publish metadata only. */
export async function enqueueDocument(options: {
  accountId: string; store: DocumentDeliveryStore; payloads: PayloadStore; queue: JobQueue;
  policy: DocumentPolicy; document: PreparedDocument; now?: number;
}) {
  const {store,payloads,queue,document,policy} = options;
  const createdAt = options.now ?? Date.now();
  // Validate account before creating even a reservation.
  parseDocumentJob({version:1,accountId:options.accountId,deliveryId:randomUUID(),fingerprint:document.fingerprint,createdAt,expiresAt:createdAt+JOB_TTL_MS});
  const record = await store.reserve(document,policy);
  if (!record) {
    const existing = await store.find(document.key);
    if (!existing || existing.fingerprint !== document.fingerprint) throw new DocumentDeliveryError('document_delivery_conflict');
    if (existing.state === 'accepted' && existing.messageId) return {deliveryId:existing.id,messageId:existing.messageId,status:'accepted' as const,alreadySent:true};
    // No re-publication after an uncertain queue acknowledgement or stale reservation.
    throw new DocumentDeliveryError('document_delivery_unconfirmed');
  }
  const job: DocumentJob = {version:1,accountId:options.accountId,deliveryId:record.id,fingerprint:document.fingerprint,createdAt,expiresAt:createdAt+JOB_TTL_MS};
  try {
    await payloads.put(job,{document:input(document),policy});
    await queue.send(job);
    // A queued acknowledgement is NOT provider acceptance or customer delivery.
    return {deliveryId:record.id,messageId:record.id,status:'queued' as const,alreadySent:false};
  } catch {
    await store.unknown(record.id).catch(() => undefined);
    // Keep the encrypted object for bounded reconciliation/lifecycle cleanup.
    // An ambiguous queue write may already be visible to a consumer.
    throw new DocumentDeliveryError('document_queue_unconfirmed',503);
  }
}

export async function consumeDocumentJob(options: {
  job: DocumentJob; accountId: string; record: DeliveryRecord; policy: DocumentPolicy;
  store: DocumentDeliveryStore; claims: ClaimStore; payloads: PayloadStore;
  transport: DocumentTransport; now?: number;
}) {
  const {store,claims,payloads,transport,policy,record} = options;
  const job = parseDocumentJob(options.job);
  if (job.accountId !== options.accountId || job.deliveryId !== record.id || job.fingerprint !== record.fingerprint) throw new DocumentDeliveryError('document_delivery_conflict');
  if (record.state === 'accepted' && record.messageId) return 'accepted' as const;
  if (record.state !== 'reserved') return 'held' as const;
  if (!await claims.claim(job,randomUUID())) return 'held' as const;
  // From this point every error is held, never retried, including worker crashes.
  try {
    const now = options.now ?? Date.now();
    if (job.createdAt > now+5_000 || job.expiresAt <= now) throw new DocumentDeliveryError('document_job_expired');
    const payload = await payloads.get(job);
    if (JSON.stringify(payload.policy) !== JSON.stringify(policy)) throw new DocumentDeliveryError('document_policy_changed');
    const document = prepareDocument(payload.document,policy);
    if (document.fingerprint !== job.fingerprint) throw new DocumentDeliveryError('document_delivery_conflict');
    await validateDocumentPdf(document.pdf);
    await transport.verifyTemplate(policy);
    const messageId = await store.prepareMessage(record,document,policy);
    const mediaId = await transport.upload(document);
    await store.recordMedia(record.id,mediaId);
    const whatsappId = await transport.send(policy,document,mediaId);
    await store.accept(record.id,messageId,whatsappId);
    // Never convert acceptance into failure because temporary cleanup failed.
    await payloads.delete(job).catch(() => undefined);
    return 'accepted' as const;
  } catch {
    await store.unknown(record.id).catch(() => undefined);
    return 'held' as const;
  }
}
