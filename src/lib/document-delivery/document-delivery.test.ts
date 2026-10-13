import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { documentConfiguration, prepareDocument, sha256, type DocumentPolicy } from './contracts';
import { deliverDocument, type DeliveryRecord, type DocumentDeliveryStore } from './service';
import { DocumentMetaClient } from './meta';
import { validateDocumentPdf } from './pdf';
import { readDocumentRequest } from './http';

const policy:DocumentPolicy = {kind:'quotation',name:'quotation_pdf',language:'en_US',metaTemplateId:'123',bodyText:'Dear {{1}}, your quotation {{2}} is attached.',fields:['customerName','documentNumber']};
const input = {kind:'quotation',revision:3,documentNumber:'Q/1',to:'+919876543210',consentConfirmed:true,fields:{customerName:'Example',documentNumber:'Q/1'},pdfBase64:Buffer.from('%PDF-1.7\nfixture').toString('base64')};
function memoryStore() {
  const rows = new Map<string,DeliveryRecord>();
  const events:string[] = [];
  const store:DocumentDeliveryStore = {
    async reserve(doc) {events.push('reserve');if (rows.has(doc.key)) return null;const row:DeliveryRecord = {id:'reserved',fingerprint:doc.fingerprint,state:'reserved',messageId:null};rows.set(doc.key,row);return row;},
    async find(key) {return rows.get(key) ?? null;},
    async prepareMessage() {events.push('message');return 'message';},
    async recordMedia() {events.push('media');},
    async accept(_id,messageId) {events.push('accept');const row = [...rows.values()][0];row.state='accepted';row.messageId=messageId;},
    async unknown() {events.push('unknown');[...rows.values()][0].state='unknown';},
  };
  const transport = {verifyTemplate:vi.fn(async () => {events.push('verify');}),upload:vi.fn(async () => {events.push('upload');return '123';}),send:vi.fn(async () => {events.push('send');return 'wamid.example';})};
  return {store,transport,rows,events};
}
describe('document configuration',() => {
  it('is off by default without reading malformed template configuration',() => {
    expect(documentConfiguration({ADMIN_DOCUMENT_DELIVERY_TEMPLATES:'bad'})).toBeNull();
  });
  const config = (p:DocumentPolicy) => ({ENABLE_ADMIN_DOCUMENT_DELIVERY:'true',ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID:'11111111-1111-4111-8111-111111111111',ADMIN_DOCUMENT_DELIVERY_TEMPLATES:JSON.stringify([p])});
  it('records the confirmed six-field quotation text without activating or guessing a template ID',() => {
    const examples = JSON.parse(readFileSync(new URL('../../../docs/admin-document-delivery/quotation-templates.example.json',import.meta.url),'utf8')) as DocumentPolicy[];
    expect(examples).toHaveLength(1);
    const example=examples[0];
    expect(documentConfiguration({...config(example),ENABLE_ADMIN_DOCUMENT_DELIVERY:'false'})).toBeNull();
    expect(() => documentConfiguration(config(example))).toThrow('document_configuration_invalid');
    const verifiedFixture={...example,metaTemplateId:'123'};
    expect(documentConfiguration(config(verifiedFixture))?.policies).toEqual([verifiedFixture]);
    expect(verifiedFixture.fields).toEqual(['customerName','documentNumber','documentDate','project','amount','validUntil']);
    const fields={customerName:'Example Customer',documentNumber:'Q/1',documentDate:'12 October 2026',project:'Example project',amount:'INR 1,180.00',validUntil:'26 October 2026'};
    const doc=prepareDocument({...input,fields},verifiedFixture);
    expect(doc.parameters).toEqual(Object.values(fields));
    expect(doc.renderedBody).toContain('Quotation Amount: INR 1,180.00\nValid Until: 26 October 2026');
    expect(doc.renderedBody).toContain('Dear Example Customer,\n\nPlease find attached');
    expect(doc.renderedBody.endsWith('Thank you for considering Architech Labs.\n\nArchitech Labs')).toBe(true);
    expect(doc.renderedBody).not.toContain('{{');
  });
  it('requires explicit contiguous variable maps and exact approved snapshot',() => {
    expect(documentConfiguration(config(policy))?.policies).toEqual([policy]);
    for (const p of [{...policy,fields:['customerName']},{...policy,bodyText:'Dear {{1}} quotation {{3}}'},{...policy,bodyText:'Dear {{customer}} quotation {{2}}'},{...policy,fields:['customerName','customerName']}]) expect(() => documentConfiguration(config(p as DocumentPolicy))).toThrow();
  });
  it('blocks the currently supplied payment-received tax template and misleading proforma reuse',() => {
    expect(() => documentConfiguration(config({...policy,kind:'tax',bodyText:'Dear {{1}}, payment has been received; tax invoice {{2}}'}))).toThrow();
    expect(() => documentConfiguration(config({...policy,kind:'proforma'}))).toThrow();
    expect(documentConfiguration(config({...policy,kind:'tax',bodyText:'Dear {{1}}, tax invoice {{2}} is attached for your records.'}))).not.toBeNull();
  });
});
describe('document validation and duplicate boundary',() => {
  it('pins the document bytes, recipient, kind, template and quotation revision',() => {
    const doc = prepareDocument(input,policy);
    expect(doc.renderedBody).toBe('Dear Example, your quotation Q/1 is attached.');
    expect(doc.pdfSha256).toBe(sha256(doc.pdf));
    expect(prepareDocument({...input,revision:4},policy).key).not.toBe(doc.key);
    expect(prepareDocument({...input,pdfBase64:Buffer.from('%PDF-1.7\nchanged').toString('base64')},policy).key).toBe(doc.key);
    expect(prepareDocument({...input,to:'+919876543211'},policy).key).not.toBe(doc.key);
  });
  it('rejects missing consent, guessed phones, extra/missing values and mismatched numbers',() => {
    for (const changes of [{consentConfirmed:false},{to:'9876543210'},{to:'+91 9876543210'},{revision:undefined},{fields:{customerName:'Example'}},{fields:{...input.fields,amount:'123'}},{fields:{...input.fields,documentNumber:'Q/2'}},{fields:{...input.fields,customerName:'bad\nname'}},{pdfBase64:'bad'},{media_url:'https://public.example/test.pdf'}]) expect(() => prepareDocument({...input,...changes},policy)).toThrow();
  });
  it('makes one send under concurrent requests and returns the accepted result for an identical duplicate',async () => {
    const {store,transport,events} = memoryStore();
    const doc = prepareDocument(input,policy);
    const results = await Promise.allSettled([deliverDocument(store,transport,policy,doc),deliverDocument(store,transport,policy,doc)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(events.indexOf('reserve')).toBeLessThan(events.indexOf('upload'));
    expect(events.indexOf('message')).toBeLessThan(events.indexOf('send'));
    expect((await deliverDocument(store,transport,policy,doc)).alreadySent).toBe(true);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it('blocks changed payloads and uncertain provider results permanently until reviewed',async () => {
    const {store,transport} = memoryStore();
    const doc = prepareDocument(input,policy);
    transport.send.mockRejectedValue(new Error('synthetic timeout'));
    await expect(deliverDocument(store,transport,policy,doc)).rejects.toMatchObject({code:'document_delivery_unconfirmed'});
    await expect(deliverDocument(store,transport,policy,doc)).rejects.toMatchObject({code:'document_delivery_unconfirmed'});
    await expect(deliverDocument(store,transport,policy,prepareDocument({...input,fields:{...input.fields,customerName:'Changed'}},policy))).rejects.toMatchObject({code:'document_delivery_conflict'});
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it('never sends when the message reservation or media-persistence write fails',async () => {
    for (const method of ['prepareMessage','recordMedia'] as const) {
      const {store,transport} = memoryStore();
      store[method] = vi.fn(async () => {throw new Error('database unavailable');});
      await expect(deliverDocument(store,transport,policy,prepareDocument(input,policy))).rejects.toThrow();
      expect(transport.send).not.toHaveBeenCalled();
      if (method === 'prepareMessage') expect(transport.upload).not.toHaveBeenCalled();
    }
  });
  it('does not retry Meta even when the acceptance write fails',async () => {
    const {store,transport} = memoryStore();
    store.accept = vi.fn(async () => {throw new Error('database unavailable');});
    const doc = prepareDocument(input,policy);
    await expect(deliverDocument(store,transport,policy,doc)).rejects.toThrow();
    await expect(deliverDocument(store,transport,policy,doc)).rejects.toThrow();
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});
describe('private Meta transport',() => {
  const approved = {id:'123',name:'quotation_pdf',language:'en_US',status:'APPROVED',category:'UTILITY',components:[{type:'HEADER',format:'DOCUMENT'},{type:'BODY',text:policy.bodyText}]};
  it('checks approval/body/language and uploads bytes, never sample handles or public URLs',async () => {
    const calls:{url:string;init?:RequestInit}[] = [];
    const fetcher = vi.fn(async (url:RequestInfo|URL,init?:RequestInit) => {
      calls.push({url:String(url),init});
      return Response.json(calls.length === 1 ? {data:[approved]} : calls.length === 2 ? {id:'456'} : {messages:[{id:'wamid.example'}]});
    });
    const client = new DocumentMetaClient('789','synthetic','987',fetcher);
    const doc = prepareDocument(input,policy);
    await client.verifyTemplate(policy);
    const id = await client.upload(doc);
    await client.send(policy,doc,id);
    expect(new URL(calls[0].url).pathname).toBe('/v21.0/987/message_templates');
    expect(new URL(calls[0].url).searchParams.get('name')).toBe('quotation_pdf');
    const form = calls[1].init?.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(doc.pdf);
    const payload = JSON.parse(calls[2].init?.body as string);
    expect(payload.to).toBe('919876543210');
    expect(payload.template.components[0].parameters[0].document).toEqual({id:'456',filename:doc.filename});
    expect(calls.every(c => c.init?.redirect === 'error')).toBe(true);
  });
  it('rejects paused, changed, wrong-language, wrong-header and button-bearing templates',async () => {
    for (const change of [{status:'PAUSED'},{language:'en'},{category:'MARKETING'},{components:[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:policy.bodyText}]},{components:[...approved.components,{type:'BUTTONS'}]},{components:[{type:'HEADER',format:'DOCUMENT'},{type:'BODY',text:'Changed'}]}]) {
      const client = new DocumentMetaClient('789','synthetic','987',vi.fn(async () => Response.json({data:[{...approved,...change}]})));
      await expect(client.verifyTemplate(policy)).rejects.toMatchObject({code:'template_not_verified'});
    }
  });
  it('never retries a rejected upload and sanitizes provider errors',async () => {
    const fetcher = vi.fn(async () => new Response('PRIVATE TOKEN/DETAILS',{status:500}));
    const client = new DocumentMetaClient('789','synthetic','987',fetcher);
    await expect(client.upload(prepareDocument(input,policy))).rejects.toMatchObject({code:'meta_response_unconfirmed'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('matches the Inbox media ID limit and refuses invalid IDs before sending or downloading',async () => {
    const doc=prepareDocument(input,policy);
    const maximum='4'.repeat(40);
    const accepted=new DocumentMetaClient('789','synthetic','987',vi.fn(async () => Response.json({id:maximum})));
    expect(await accepted.upload(doc)).toBe(maximum);
    for (const mediaId of ['4'.repeat(41),'','not-a-media-id']) {
      const upload=new DocumentMetaClient('789','synthetic','987',vi.fn(async () => Response.json({id:mediaId})));
      await expect(upload.upload(doc)).rejects.toMatchObject({code:'media_upload_unconfirmed'});
      const fetcher=vi.fn();
      const client=new DocumentMetaClient('789','synthetic','987',fetcher);
      await expect(client.send(policy,doc,mediaId)).rejects.toMatchObject({code:'media_upload_unconfirmed'});
      await expect(client.download(mediaId,'hash')).rejects.toMatchObject({code:'media_unavailable'});
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it('rejects oversized responses and refuses to forward credentials to another media host',async () => {
    const client = new DocumentMetaClient('789','synthetic','987',vi.fn(async () => new Response('x'.repeat(70_000))));
    await expect(client.verifyTemplate(policy)).rejects.toThrow();
    const fetcher = vi.fn(async () => Response.json({mime_type:'application/pdf',url:'https://evil.example/file.pdf'}));
    await expect(new DocumentMetaClient('789','synthetic','987',fetcher).download('456','hash')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses an ID-only result, absent WABA membership, or an ambiguous match',async () => {
    for (const response of [approved,{data:[]},{data:[{...approved,id:'other'}]},{data:[approved,approved]}]) {
      const fetcher = vi.fn(async () => Response.json(response));
      await expect(new DocumentMetaClient('789','synthetic','987',fetcher).verifyTemplate(policy)).rejects.toMatchObject({code:'template_not_verified'});
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
describe('bounded static PDF input',() => {
  it('accepts a real static PDF without rewriting its bytes and rejects active/corrupt PDFs',async () => {
    const document = await PDFDocument.create();document.addPage();
    const bytes = await document.save();await expect(validateDocumentPdf(bytes)).resolves.toBeUndefined();
    document.catalog.set(PDFName.of('OpenAction'),document.context.obj({S:'JavaScript'}));
    await expect(validateDocumentPdf(await document.save())).rejects.toMatchObject({code:'invalid_static_pdf'});
    await expect(validateDocumentPdf(Buffer.from('not pdf'))).rejects.toThrow();
  });
  it('rejects oversized JSON, queries, and non-JSON requests before parsing',async () => {
    for (const request of [new Request('https://desk.example/api?ignored=1',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),new Request('https://desk.example/api',{method:'POST',body:'{}'}),new Request('https://desk.example/api',{method:'POST',headers:{'content-type':'application/json','content-length':'9999999'},body:'{}'})]) await expect(readDocumentRequest(request)).rejects.toThrow();
  });
});
