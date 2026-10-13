import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { prepareDocument, type DocumentInput, type DocumentPolicy } from './contracts';
import { consumeDocumentJob, enqueueDocument, JOB_TTL_MS, parseDocumentJob, type DocumentJob } from './queue';
import type { DeliveryRecord, DocumentDeliveryStore } from './service';

const accountId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const policy: DocumentPolicy = {kind:'quotation',name:'quotation_pdf',language:'en_US',metaTemplateId:'123',bodyText:'Dear {{1}}, quotation {{2}} is attached.',fields:['customerName','documentNumber']};
async function fixture() {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const input: DocumentInput = {kind:'quotation',revision:1,documentNumber:'Q/1',to:'+919876543210',consentConfirmed:true,fields:{customerName:'Synthetic Customer',documentNumber:'Q/1'},pdfBase64:Buffer.from(await pdf.save()).toString('base64')};
  const document = prepareDocument(input,policy);
  const record: DeliveryRecord = {id,fingerprint:document.fingerprint,state:'reserved',messageId:null};
  let reserved = false, claimed = false;
  const events: string[] = [];
  const store: DocumentDeliveryStore = {
    reserve:vi.fn(async () => { events.push('reserve'); if (reserved) return null; reserved=true; return record; }),
    find:vi.fn(async () => record),
    prepareMessage:vi.fn(async () => { events.push('message'); return id; }),
    recordMedia:vi.fn(async () => { events.push('media'); }),
    accept:vi.fn(async () => { events.push('accept'); record.state='accepted'; record.messageId=id; }),
    unknown:vi.fn(async () => { events.push('unknown'); record.state='unknown'; }),
  };
  const claims = {claim:vi.fn(async () => { events.push('claim'); if (claimed) return false; claimed=true; return true; })};
  const payloads = {put:vi.fn(async () => { events.push('put'); }),get:vi.fn(async () => ({document:input,policy})),delete:vi.fn(async () => { events.push('delete'); })};
  const queue = {send:vi.fn(async () => { events.push('queue'); })};
  const transport = {verifyTemplate:vi.fn(async () => { events.push('verify'); }),upload:vi.fn(async () => { events.push('upload'); return '123'; }),send:vi.fn(async () => { events.push('send'); return 'wamid.synthetic'; })};
  const job: DocumentJob = {version:1,accountId,deliveryId:id,fingerprint:document.fingerprint,createdAt:1000,expiresAt:1000+JOB_TTL_MS};
  return {accountId,document,record,store,claims,payloads,queue,transport,job,policy,now:1000,events};
}
describe('local metadata-only document queue preparation', () => {
  it('reserves the existing Inbox row, stores the payload, then acknowledges queued only', async () => {
    const f = await fixture();
    expect(await enqueueDocument(f)).toEqual({deliveryId:id,messageId:id,status:'queued',alreadySent:false});
    expect(f.events).toEqual(['reserve','put','queue']);
    const queued = f.queue.send.mock.calls[0] as unknown as [DocumentJob];
    expect(Object.keys(queued[0]).sort()).toEqual(['accountId','createdAt','deliveryId','expiresAt','fingerprint','version']);
    expect(JSON.stringify(queued)).not.toContain('Synthetic Customer');
    expect(JSON.stringify(queued)).not.toContain('919876543210');
    expect(f.transport.send).not.toHaveBeenCalled();
  });
  it('never republishes a reserved duplicate, including concurrent requests', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([enqueueDocument(f),enqueueDocument(f)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.payloads.put).toHaveBeenCalledTimes(1); expect(f.queue.send).toHaveBeenCalledTimes(1);
    await expect(enqueueDocument(f)).rejects.toMatchObject({code:'document_delivery_unconfirmed'});
  });
  it('returns an accepted duplicate without storing or publishing again', async () => {
    const f = await fixture(); await enqueueDocument(f);
    f.record.state='accepted'; f.record.messageId=id;
    expect(await enqueueDocument(f)).toMatchObject({status:'accepted',alreadySent:true});
    expect(f.queue.send).toHaveBeenCalledTimes(1);
  });
  it.each(['put','queue'] as const)('holds an uncertain %s failure without retry or deleting evidence', async failure => {
    const f = await fixture();
    if (failure === 'put') f.payloads.put.mockRejectedValue(new Error('PRIVATE'));
    else f.queue.send.mockRejectedValue(new Error('PRIVATE'));
    await expect(enqueueDocument(f)).rejects.toMatchObject({code:'document_queue_unconfirmed'});
    expect(f.record.state).toBe('unknown'); expect(f.payloads.delete).not.toHaveBeenCalled();
    await expect(enqueueDocument(f)).rejects.toMatchObject({code:'document_delivery_unconfirmed'});
    expect(f.payloads.put).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid account/job metadata before any reservation or payload lookup', async () => {
    const f = await fixture();
    await expect(enqueueDocument({...f,accountId:'../invalid'})).rejects.toThrow();
    expect(f.store.reserve).not.toHaveBeenCalled();
    for (const change of [{version:2},{deliveryId:'../bad'},{fingerprint:'bad'},{expiresAt:2000},{createdAt:-1},{pdfBase64:'private'}]) {
      expect(() => parseDocumentJob({...f.job,...change})).toThrow('invalid_document_job');
    }
  });
});
describe('permanent claim prevents duplicate Meta sends', () => {
  it('allows one consumer only under concurrent redelivery and keeps the existing row UUID', async () => {
    const f = await fixture();
    expect((await Promise.all([consumeDocumentJob(f),consumeDocumentJob(f)])).sort()).toEqual(['accepted','held']);
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf('claim')).toBeLessThan(f.events.indexOf('upload'));
    expect(f.events.indexOf('media')).toBeLessThan(f.events.indexOf('send'));
    expect(f.store.accept).toHaveBeenCalledWith(id,id,'wamid.synthetic');
    expect(await consumeDocumentJob(f)).toBe('accepted');
    expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
  it('holds a previously claimed reserved row without touching payload or Meta', async () => {
    const f = await fixture(); await f.claims.claim();
    expect(await consumeDocumentJob(f)).toBe('held');
    expect(f.payloads.get).not.toHaveBeenCalled(); expect(f.transport.send).not.toHaveBeenCalled();
  });
  it.each(['verifyTemplate','upload','send','accept','recordMedia'] as const)('does not resend after %s fails, even if marking unknown fails', async method => {
    const f = await fixture();
    if (method === 'accept' || method === 'recordMedia') vi.mocked(f.store[method]).mockRejectedValue(new Error('PRIVATE'));
    else f.transport[method].mockRejectedValue(new Error('PRIVATE'));
    vi.mocked(f.store.unknown).mockRejectedValue(new Error('database unavailable'));
    expect(await consumeDocumentJob(f)).toBe('held');
    expect(await consumeDocumentJob(f)).toBe('held');
    expect(f.transport.send.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it.each(['expired','future','policy','fingerprint','corrupt'] as const)('holds %s payloads before any provider access', async failure => {
    const f = await fixture();
    if (failure === 'expired') f.now=f.job.expiresAt;
    if (failure === 'future') f.now=-5000;
    if (failure === 'policy') f.payloads.get.mockResolvedValue({document:(await f.payloads.get()).document,policy:{...policy,metaTemplateId:'456'}});
    if (failure === 'fingerprint') f.payloads.get.mockResolvedValue({document:{...(await f.payloads.get()).document,fields:{customerName:'Changed',documentNumber:'Q/1'}},policy});
    if (failure === 'corrupt') {
      const document = {...(await f.payloads.get()).document,pdfBase64:Buffer.from('%PDF-1.7\ncorrupt').toString('base64')};
      f.job.fingerprint=prepareDocument(document,policy).fingerprint; f.record.fingerprint=f.job.fingerprint;
      f.payloads.get.mockResolvedValue({document,policy});
    }
    expect(await consumeDocumentJob(f)).toBe('held');
    expect(f.transport.verifyTemplate).not.toHaveBeenCalled(); expect(f.record.state).toBe('unknown');
  });
  it('rejects cross-account or mismatched reservations before claiming', async () => {
    const f = await fixture();
    await expect(consumeDocumentJob({...f,accountId:id})).rejects.toMatchObject({code:'document_delivery_conflict'});
    expect(f.claims.claim).not.toHaveBeenCalled();
  });
  it('keeps accepted status if temporary object cleanup fails', async () => {
    const f = await fixture(); f.payloads.delete.mockRejectedValue(new Error('storage unavailable'));
    expect(await consumeDocumentJob(f)).toBe('accepted'); expect(f.store.unknown).not.toHaveBeenCalled();
  });
});
