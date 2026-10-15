import { describe, expect, it, vi } from 'vitest';
import { documentObjectKey, JOB_TTL_MS, type DocumentJob, type DocumentPayload } from './queue';
import { EncryptedDocumentPayloads, MAX_ENCRYPTED_PAYLOAD_BYTES } from './queue-payloads';

const job: DocumentJob = {version:1,accountId:'11111111-1111-4111-8111-111111111111',deliveryId:'22222222-2222-4222-8222-222222222222',fingerprint:'a'.repeat(64),createdAt:1000,expiresAt:1000+JOB_TTL_MS};
const payload = {document:{customer:'PRIVATE CUSTOMER',pdfBase64:'PRIVATE PDF'},policy:{name:'synthetic'}} as unknown as DocumentPayload;
function fixture() {
  let bytes: Uint8Array = new Uint8Array();
  const bucket = {
    put:vi.fn(async (_key:string,value:Uint8Array) => { bytes=value; return {}; }),
    get:vi.fn(async () => ({size:bytes.length,body:new ReadableStream<Uint8Array>({start(c) { c.enqueue(bytes); c.close(); }})})),
    delete:vi.fn(async () => undefined),
  };
  return {bucket,payloads:new EncryptedDocumentPayloads(bucket,'1'.repeat(64)),bytes:() => bytes};
}
describe('private encrypted temporary document payloads', () => {
  it('round trips encrypted bytes, pins write-once key and records expiry without pretending it deletes objects', async () => {
    const f = fixture(); await f.payloads.put(job,payload);
    expect(Buffer.from(f.bytes()).toString()).not.toContain('PRIVATE');
    expect(f.bucket.put).toHaveBeenCalledWith(documentObjectKey(job),expect.any(Uint8Array),{
      onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream'},customMetadata:{expiresAt:String(job.expiresAt)},
    });
    expect(await f.payloads.get(job)).toEqual(payload);
    await f.payloads.delete(job); expect(f.bucket.delete).toHaveBeenCalledWith(documentObjectKey(job));
  });
  it('uses random IVs and refuses overwrite conflicts', async () => {
    const f = fixture(); await f.payloads.put(job,payload); const first=Buffer.from(f.bytes());
    await f.payloads.put(job,payload); expect(Buffer.from(f.bytes())).not.toEqual(first);
    f.bucket.put.mockResolvedValueOnce(null as unknown as object);
    await expect(f.payloads.put(job,payload)).rejects.toMatchObject({code:'document_payload_conflict'});
  });
  it.each(['key','bytes','account','timestamp','version'] as const)('rejects tampered %s without exposing plaintext', async change => {
    const f = fixture(); await f.payloads.put(job,payload);
    let target=job, reader=f.payloads;
    if (change === 'key') reader=new EncryptedDocumentPayloads(f.bucket,'2'.repeat(64));
    if (change === 'bytes') f.bytes()[20]^=1;
    if (change === 'version') f.bytes()[0]=2;
    if (change === 'account') target={...job,accountId:job.deliveryId};
    if (change === 'timestamp') target={...job,createdAt:2000,expiresAt:2000+JOB_TTL_MS};
    await expect(reader.get(target)).rejects.toMatchObject({code:'document_payload_unavailable'});
  });
  it('bounds writes and actual read streams, not only claimed object size', async () => {
    const f = fixture();
    await expect(f.payloads.put(job,{...payload,document:{...payload.document,pdfBase64:'x'.repeat(MAX_ENCRYPTED_PAYLOAD_BYTES)}})).rejects.toThrow();
    expect(f.bucket.put).not.toHaveBeenCalled();
    f.bucket.get.mockResolvedValueOnce({size:29,body:new ReadableStream({start(c) {c.enqueue(new Uint8Array(30)); c.close();}})});
    await expect(f.payloads.get(job)).rejects.toMatchObject({code:'document_payload_unavailable'});
  });
  it('fails closed for absent object or invalid dedicated key', async () => {
    const f = fixture(); f.bucket.get.mockResolvedValueOnce(null as never);
    await expect(f.payloads.get(job)).rejects.toThrow('document_payload_unavailable');
    expect(() => new EncryptedDocumentPayloads(f.bucket,'bad')).toThrow('document_queue_configuration_invalid');
  });
});
