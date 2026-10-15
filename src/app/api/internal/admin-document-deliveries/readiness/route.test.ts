import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(), decrypt: vi.fn(), verifyTemplate: vi.fn(), inspectTemplate: vi.fn(), bucket: vi.fn(),
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: mocks.supabaseAdmin }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: mocks.decrypt }));
vi.mock('@/lib/document-delivery/meta', () => ({
  DocumentMetaClient: class { verifyTemplate = mocks.verifyTemplate; inspectTemplate = mocks.inspectTemplate; },
}));
vi.mock('@/lib/document-delivery/supabase-payload-bucket', () => ({ privateSupabasePayloadBucket: mocks.bucket }));
import { GET, POST } from './route';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('private document readiness', () => {
  it('rejects callers without the worker token before reading settings', async () => {
    vi.stubEnv('ADMIN_DOCUMENT_WORKER_TOKEN', 'a'.repeat(64));
    expect((await POST(new Request('https://desk.internal', { method: 'POST' }))).status).toBe(403);
    expect((await GET(new Request('https://desk.internal'))).status).toBe(403);
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled();
  });
  it('reads the fixed three candidates while OFF without saving, uploading, or sending',async () => {
    vi.stubEnv('ADMIN_DOCUMENT_WORKER_TOKEN','a'.repeat(64));
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','false');
    vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID','90e47f37-19d5-4fb8-94f8-8c2df7599f7e');
    const single=vi.fn().mockResolvedValue({data:{phone_number_id:'123',access_token:'ciphertext',waba_id:'456'},error:null});
    mocks.supabaseAdmin.mockReturnValue({from:vi.fn().mockReturnValue({select:vi.fn().mockReturnValue({eq:vi.fn().mockReturnValue({single})})})});
    mocks.decrypt.mockReturnValue('token');
    mocks.inspectTemplate.mockImplementation(async name => {if(name === 'proforma_invoice_pdf') throw new Error('PRIVATE DETAILS');return {name,headerFormat:'DOCUMENT'};});
    const response=await GET(new Request('https://desk.internal',{headers:{Authorization:`Bearer ${'a'.repeat(64)}`}}));
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({templates:[{name:'quotation_pdf',template:{name:'quotation_pdf',headerFormat:'DOCUMENT'}},
      {name:'proforma_invoice_pdf',code:'template_lookup_unavailable'},{name:'tax_invoice_pdf',template:{name:'tax_invoice_pdf',headerFormat:'DOCUMENT'}}]});
    expect(mocks.inspectTemplate.mock.calls).toEqual([['quotation_pdf','en_US'],['proforma_invoice_pdf','en_US'],['tax_invoice_pdf','en_US']]);
    expect(mocks.verifyTemplate).not.toHaveBeenCalled();expect(mocks.bucket).not.toHaveBeenCalled();
  });

  it('verifies the live quotation policy and private bucket while sending remains off', async () => {
    vi.stubEnv('ADMIN_DOCUMENT_WORKER_TOKEN', 'a'.repeat(64));
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY', 'false');
    vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID', '90e47f37-19d5-4fb8-94f8-8c2df7599f7e');
    vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_TEMPLATES', JSON.stringify([{
      kind: 'quotation', name: 'quotation_pdf', language: 'en_US', metaTemplateId: '1277253704541513',
      bodyText: 'Dear {{1}}, quotation {{2}}', fields: ['customerName', 'documentNumber'],
    }]));
    const single = vi.fn().mockResolvedValue({ data: { phone_number_id: '123', access_token: 'ciphertext', waba_id: '456' }, error: null });
    const eq = vi.fn().mockReturnValue({ single });
    const select = vi.fn().mockReturnValue({ eq });
    mocks.supabaseAdmin.mockReturnValue({ from: vi.fn().mockReturnValue({ select }) });
    mocks.decrypt.mockReturnValue('token');
    mocks.verifyTemplate.mockResolvedValue(undefined);
    mocks.bucket.mockResolvedValue({});
    const response = await POST(new Request('https://desk.internal', {
      method: 'POST', headers: { Authorization: `Bearer ${'a'.repeat(64)}` },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ templatesVerified: ['quotation'], privateStorageVerified: true });
    expect(eq).toHaveBeenCalledWith('account_id', '90e47f37-19d5-4fb8-94f8-8c2df7599f7e');
    expect(mocks.verifyTemplate).toHaveBeenCalledOnce();
    expect(mocks.bucket).toHaveBeenCalledOnce();
  });
});
