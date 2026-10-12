import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { ApiError } from '@/lib/api/v1/respond';
const mocks = vi.hoisted(() => ({auth:vi.fn(),deliver:vi.fn(),db:vi.fn(),decrypt:vi.fn(() => 'synthetic')}));
vi.mock('@/lib/auth/api-context',() => ({requireApiKey:mocks.auth}));
vi.mock('@/lib/document-delivery/service',() => ({deliverDocument:mocks.deliver}));
vi.mock('@/lib/whatsapp/encryption',() => ({decrypt:mocks.decrypt}));
import { GET, POST } from './route';

const accountId = '11111111-1111-4111-8111-111111111111';
const policy = {kind:'quotation',name:'quotation_pdf',language:'en_US',metaTemplateId:'123',bodyText:'Dear {{1}}, quotation {{2}} is attached.',fields:['customerName','documentNumber']};
const request = (body:unknown) => new Request('https://desk.example/api/v1/document-deliveries',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
describe('document bridge authorization and default-off routes',() => {
  beforeEach(() => {
    vi.clearAllMocks();vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','false');vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID',accountId);vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_TEMPLATES',JSON.stringify([policy]));
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
    mocks.deliver.mockResolvedValue({status:'accepted',alreadySent:false,deliveryId:'delivery',messageId:'message'});
    const response = await POST(request({kind:'quotation',revision:1,documentNumber:'Q1',to:'+919876543210',consentConfirmed:true,fields:{customerName:'Example',documentNumber:'Q1'},pdfBase64:Buffer.from(await pdf.save()).toString('base64')}));
    expect(response.status).toBe(202);expect(response.headers.get('cache-control')).toBe('no-store');expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.db.mock.results[0].value.eq).toHaveBeenCalledWith('account_id',accountId);
  });
  it('never exposes an unexpected provider or database error',async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true');mocks.auth.mockRejectedValue(new Error('PRIVATE TOKEN'));
    const response = await GET(new Request('https://desk.example/api'));expect(await response.text()).not.toContain('PRIVATE TOKEN');
  });
});
