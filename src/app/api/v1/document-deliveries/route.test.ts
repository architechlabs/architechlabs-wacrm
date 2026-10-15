import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { ApiError } from '@/lib/api/v1/respond';
const mocks = vi.hoisted(() => ({auth:vi.fn(),enqueue:vi.fn(),runtime:vi.fn(),db:vi.fn(),deliver:vi.fn(),decrypt:vi.fn(() => 'synthetic'),ready:vi.fn()}));
vi.mock('@/lib/auth/api-context',() => ({requireApiKey:mocks.auth}));
vi.mock('@/lib/document-delivery/service',() => ({deliverDocument:mocks.deliver}));
vi.mock('@/lib/document-delivery/queue',() => ({enqueueDocument:mocks.enqueue}));
vi.mock('@/lib/document-delivery/queue-runtime',() => ({documentQueueRuntime:mocks.runtime}));
vi.mock('@/lib/document-delivery/template-readiness',() => ({verifyConfiguredDocumentTemplate:mocks.ready}));
vi.mock('@/lib/whatsapp/encryption',() => ({decrypt:mocks.decrypt}));
import { GET, POST } from './route';

const accountId = '11111111-1111-4111-8111-111111111111';
const policy = {kind:'quotation',name:'quotation_pdf',language:'en_US',metaTemplateId:'123',bodyText:'Dear {{1}}, quotation {{2}} is attached.',fields:['customerName','documentNumber']};
const request = (body:unknown) => new Request('https://desk.example/api/v1/document-deliveries',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
describe('document bridge authorization and default-off routes',() => {
  beforeEach(() => {
    vi.resetAllMocks();vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','false');vi.stubEnv('ENABLE_ADMIN_DOCUMENT_QUEUE','true');vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID',accountId);vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_TEMPLATES',JSON.stringify([policy]));
    mocks.runtime.mockResolvedValue({payloads:{},queue:{}});
    mocks.ready.mockResolvedValue(undefined);
    const query = {select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),single:vi.fn(async () => ({data:{phone_number_id:'789',access_token:'encrypted',waba_id:'987'},error:null}))};
    mocks.db.mockReturnValue(query);mocks.auth.mockResolvedValue({accountId,keyId:'key',supabase:{from:mocks.db}});
  });
  it('does not authenticate, touch DB, or send when off',async () => {
    expect((await GET(new Request('https://desk.example/api'))).status).toBe(200);
    expect((await POST(request({}))).status).toBe(404);
    expect(mocks.auth).not.toHaveBeenCalled();expect(mocks.db).not.toHaveBeenCalled();expect(mocks.deliver).not.toHaveBeenCalled();
  });
  it('requires a separate documents:send scope before any PDF parsing',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');mocks.auth.mockRejectedValue(new ApiError('forbidden','wrong scope',403));
    expect((await POST(request({}))).status).toBe(403);expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request),'documents:send');expect(mocks.db).not.toHaveBeenCalled();
  });
  it('rejects other accounts even if their key has the scope',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');mocks.auth.mockResolvedValue({accountId:'other-account',supabase:{from:mocks.db}});
    expect((await GET(new Request('https://desk.example/api'))).status).toBe(403);expect((await POST(request({}))).status).toBe(403);expect(mocks.db).not.toHaveBeenCalled();
  });
  it('rejects unconfigured document types before any write',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');expect((await POST(request({kind:'tax'}))).status).toBe(409);expect(mocks.db).not.toHaveBeenCalled();
  });
  it('only dispatches a static consented PDF with the pinned account config',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');
    const pdf = await PDFDocument.create();pdf.addPage();
    mocks.enqueue.mockResolvedValue({status:'queued',alreadySent:false,deliveryId:'delivery',messageId:'message'});
    const response = await POST(request({kind:'quotation',revision:1,documentNumber:'Q1',to:'+919876543210',consentConfirmed:true,fields:{customerName:'Example',documentNumber:'Q1'},pdfBase64:Buffer.from(await pdf.save()).toString('base64')}));
    expect(response.status).toBe(202);expect(response.headers.get('cache-control')).toBe('no-store');expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({data:{status:'queued'}});
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({accountId,payloads:{},queue:{}}));
    expect(mocks.ready).toHaveBeenCalledWith(accountId,policy);
    expect(mocks.db).not.toHaveBeenCalled();expect(mocks.decrypt).not.toHaveBeenCalled();expect(mocks.deliver).not.toHaveBeenCalled();
  });
  it('never uses the synchronous path when the queue is off',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');vi.stubEnv('ENABLE_ADMIN_DOCUMENT_QUEUE','false');
    expect(await (await GET(new Request('https://desk.example/api'))).json()).toEqual({data:{enabled:false,policies:[]}});
    expect((await POST(request({}))).status).toBe(404);
    expect(mocks.auth).not.toHaveBeenCalled();expect(mocks.runtime).not.toHaveBeenCalled();expect(mocks.deliver).not.toHaveBeenCalled();
  });
  it('advertises queued mode only with valid bindings and fails before any reservation if missing',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');
    expect(await (await GET(new Request('https://desk.example/api'))).json()).toMatchObject({data:{enabled:true,mode:'queued'}});
    mocks.runtime.mockRejectedValue(new Error('PRIVATE CONFIG'));
    expect((await POST(request({}))).status).toBe(503);expect(mocks.enqueue).not.toHaveBeenCalled();expect(mocks.db).not.toHaveBeenCalled();
  });
  it('hides a pending template and refuses a send before creating an Inbox reservation',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');
    mocks.ready.mockRejectedValue(new Error('template_header_mismatch'));
    expect(await (await GET(new Request('https://desk.example/api'))).json()).toEqual({data:{enabled:false,policies:[]}});
    const pdf = await PDFDocument.create();pdf.addPage();
    const response = await POST(request({kind:'quotation',revision:1,documentNumber:'Q1',to:'+919876543210',consentConfirmed:true,
      fields:{customerName:'Example',documentNumber:'Q1'},pdfBase64:Buffer.from(await pdf.save()).toString('base64')}));
    expect(response.status).not.toBe(202);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('keeps a verified quotation available when another configured template is pending',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');
    const proforma={...policy,kind:'proforma',name:'proforma_invoice_pdf',bodyText:'Dear {{1}}, Proforma Invoice {{2}} is ready.'};
    vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_TEMPLATES',JSON.stringify([policy,proforma]));
    mocks.ready.mockImplementation(async (_account,p) => {if(p.kind === 'proforma') throw new Error('pending');});
    const response=await GET(new Request('https://desk.example/api'));
    expect(await response.json()).toEqual({data:{enabled:true,mode:'queued',policies:[{kind:policy.kind,bodyText:policy.bodyText,fields:policy.fields}]}});
    expect(mocks.ready).toHaveBeenCalledTimes(2);
  });
  it('returns existing acceptance without re-enqueueing an accepted duplicate',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');
    const pdf = await PDFDocument.create();pdf.addPage();
    mocks.enqueue.mockResolvedValue({status:'accepted',alreadySent:true,deliveryId:'delivery',messageId:'message'});
    const response = await POST(request({kind:'quotation',revision:1,documentNumber:'Q1',to:'+919876543210',consentConfirmed:true,fields:{customerName:'Example',documentNumber:'Q1'},pdfBase64:Buffer.from(await pdf.save()).toString('base64')}));
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({data:{status:'accepted',alreadySent:true}});expect(mocks.deliver).not.toHaveBeenCalled();
  });
  it('never exposes an unexpected provider or database error',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');mocks.auth.mockRejectedValue(new Error('PRIVATE TOKEN'));
    const response = await GET(new Request('https://desk.example/api'));expect(await response.text()).not.toContain('PRIVATE TOKEN');
  });
});
