import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DocumentDeliveryError, MAX_REQUEST_BYTES } from './contracts';
import { documentObjectKey, type DocumentJob, type DocumentPayload, type PayloadStore } from './queue';

export const MAX_ENCRYPTED_PAYLOAD_BYTES = MAX_REQUEST_BYTES + 24_000;
// Structural binding contract: no HTTP URL, public bucket, presigned link or S3 key.
export interface PrivateBucket {
  put(key: string, value: Uint8Array, options: {onlyIf:{etagDoesNotMatch:string};httpMetadata:{contentType:string};customMetadata:Record<string,string>}): Promise<unknown>;
  get(key: string): Promise<{size:number;body:ReadableStream<Uint8Array>} | null>;
  delete(key: string): Promise<void>;
}
function aad(job: DocumentJob) {
  return Buffer.from(JSON.stringify([documentObjectKey(job),job.createdAt,job.expiresAt]));
}
export class EncryptedDocumentPayloads implements PayloadStore {
  private readonly key: Buffer;
  constructor(private readonly bucket: PrivateBucket, keyHex: string) {
    if (!/^[0-9a-f]{64}$/iu.test(keyHex)) throw new DocumentDeliveryError('document_queue_configuration_invalid',503);
    this.key = Buffer.from(keyHex,'hex');
  }
  async put(job: DocumentJob, payload: DocumentPayload) {
    const bytes = Buffer.from(JSON.stringify(payload));
    if (bytes.length > MAX_ENCRYPTED_PAYLOAD_BYTES-29) throw new DocumentDeliveryError('invalid_document_request',400);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(aad(job));
    const encrypted = Buffer.concat([Buffer.from([1]),iv,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);
    // Conditional write prevents replacing a reserved job's PDF or variable map.
    const stored = await this.bucket.put(documentObjectKey(job),new Uint8Array(encrypted),{
      onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream'},
      customMetadata:{expiresAt:String(job.expiresAt)},
    });
    if (!stored) throw new DocumentDeliveryError('document_payload_conflict');
  }
  async get(job: DocumentJob): Promise<DocumentPayload> {
    try {
      const object = await this.bucket.get(documentObjectKey(job));
      if (!object || object.size < 29 || object.size > MAX_ENCRYPTED_PAYLOAD_BYTES) throw new Error();
      const reader = object.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const {done,value} = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_ENCRYPTED_PAYLOAD_BYTES || size > object.size) throw new Error();
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const encrypted = Buffer.concat(chunks);
      if (size !== object.size || encrypted[0] !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm',this.key,encrypted.subarray(1,13));
      decipher.setAAD(aad(job));
      decipher.setAuthTag(encrypted.subarray(-16));
      const payload: unknown = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(13,-16)),decipher.final()]).toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'document,policy') throw new Error();
      return payload as DocumentPayload;
    } catch { throw new DocumentDeliveryError('document_payload_unavailable',503); }
  }
  async delete(job: DocumentJob) { await this.bucket.delete(documentObjectKey(job)); }
}
