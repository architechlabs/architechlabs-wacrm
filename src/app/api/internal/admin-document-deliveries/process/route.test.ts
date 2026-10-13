import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(() => ({db:vi.fn(),consume:vi.fn(),runtime:vi.fn(),decrypt:vi.fn(() => 'synthetic'),unknown:vi.fn(async () => undefined),restriction:vi.fn(async () => undefined)}));
vi.mock('@/lib/flows/admin-client',() => ({supabaseAdmin:mocks.db}));
vi.mock('@/lib/document-delivery/queue-runtime',() => ({documentQueueRuntime:mocks.runtime}));
vi.mock('@/lib/document-delivery/queue',async importOriginal => ({...await importOriginal<object>(),consumeDocumentJob:mocks.consume}));
vi.mock('@/lib/document-delivery/store',() => ({SupabaseDocumentDeliveryStore:class {unknown=mocks.unknown;}}));
vi.mock('@/lib/whatsapp/encryption',() => ({decrypt:mocks.decrypt}));
vi.mock('@/lib/whatsapp/send-message',() => ({enforceTemplateDeliveryRestriction:mocks.restriction}));
import { POST } from './route';
import { JOB_TTL_MS } from '@/lib/document-delivery/queue';

const accountId='11111111-1111-4111-8111-111111111111';
const deliveryId='22222222-2222-4222-8222-222222222222';
const token='1'.repeat(64);
const job={version:1,accountId,deliveryId,fingerprint:'a'.repeat(64),createdAt:1000,expiresAt:1000+JOB_TTL_MS};
const policy={kind:'quotation',name:'quotation_pdf',language:'en_US',metaTemplateId:'123',bodyText:'Dear {{1}}, quotation {{2}} is attached.',fields:['customerName','documentNumber']};
const request=(body:unknown=job,authorization=`Bearer ${token}`) => new Request('https://desk.internal/api/internal/admin-document-deliveries/process',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(body)});
function query(data:unknown) {return {select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn(async () => ({data,error:null as object|null})),single:vi.fn(async () => ({data,error:null}))};}
let rows:ReturnType<typeof query>, keys:ReturnType<typeof query>, settings:ReturnType<typeof query>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.restriction.mockResolvedValue(undefined);
  vi.stubEnv('ENABLE_ADMIN_DOCUMENT_QUEUE','true'); vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY','true'); vi.stubEnv('ADMIN_DOCUMENT_WORKER_TOKEN',token);
  vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID',accountId); vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_TEMPLATES',JSON.stringify([policy]));
  rows=query({id:deliveryId,conversation_id:'synthetic-conversation',message_id:null,admin_document_state:'reserved',admin_document_fingerprint:job.fingerprint,admin_document_metadata:{kind:'quotation',apiKeyId:deliveryId}});
  keys=query({id:deliveryId,scopes:['documents:send'],revoked_at:null,expires_at:null});
  settings=query({phone_number_id:'123',waba_id:'456',access_token:'encrypted'});
  mocks.db.mockReturnValue({from:(table:string) => ({messages:rows,api_keys:keys,whatsapp_config:settings})[table as 'messages']});
  mocks.runtime.mockResolvedValue({payloads:{}}); mocks.consume.mockResolvedValue('accepted');
});
afterEach(() => vi.unstubAllEnvs());
describe('private document queue processing route', () => {
  it.each(['ENABLE_ADMIN_DOCUMENT_QUEUE','ENABLE_ADMIN_DOCUMENT_DELIVERY'])('returns before DB/secret/binding access with %s OFF', async flag => {
    vi.stubEnv(flag,'false'); expect((await POST(request())).status).toBe(404);
    expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.decrypt).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it.each(['','Bearer public-api-key',`Bearer ${'2'.repeat(64)}`,`Bearer ${'é'.repeat(64)}`])('refuses invalid worker authorization without throwing: %s', async header => {
    expect((await POST(request(job,header))).status).toBe(403); expect(mocks.db).not.toHaveBeenCalled();
  });
  it('does not touch another account or accept unexpected/big job fields', async () => {
    expect((await POST(request({...job,accountId:deliveryId}))).status).toBe(403);
    expect((await POST(request({...job,pdfBase64:'private'}))).status).toBe(503);
    expect((await POST(request({...job,unexpected:'x'.repeat(2000)}))).status).toBe(503);
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it('scopes every lookup, rechecks key scope and returns only a terminal empty acknowledgement', async () => {
    const response=await POST(request()); expect(response.status).toBe(204); expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rows.eq.mock.calls).toEqual([['admin_document_account_id',accountId],['id',deliveryId],['admin_document_fingerprint',job.fingerprint]]);
    expect(keys.eq.mock.calls).toEqual([['account_id',accountId],['id',deliveryId]]);
    expect(settings.eq).toHaveBeenCalledWith('account_id',accountId);
    expect(mocks.restriction).toHaveBeenCalledWith(expect.anything(),'synthetic-conversation',policy.name);
    expect(mocks.consume).toHaveBeenCalledWith(expect.objectContaining({accountId,job,policy}));
  });
  it.each([{scopes:['messages:send']},{revoked_at:'2026-01-01'},{expires_at:'invalid'},{expires_at:'2020-01-01'}])('holds revoked/expired/unscoped originating key: %j', async change => {
    keys=query({id:deliveryId,scopes:['documents:send'],revoked_at:null,expires_at:null,...change});
    expect((await POST(request())).status).toBe(409); expect(mocks.unknown).toHaveBeenCalledWith(deliveryId);
    expect(mocks.consume).not.toHaveBeenCalled(); expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it('sanitizes database errors and does not misreport held jobs as accepted', async () => {
    rows.maybeSingle.mockResolvedValueOnce({data:null,error:{message:'PRIVATE TOKEN'}});
    const response=await POST(request()); expect(response.status).toBe(503); expect(await response.text()).toBe('');
    mocks.consume.mockResolvedValue('held'); expect((await POST(request())).status).toBe(409);
  });
  it('rechecks recipient/template restrictions added after enqueue before any provider access', async () => {
    mocks.restriction.mockRejectedValue(new Error('restricted'));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.consume).not.toHaveBeenCalled(); expect(mocks.decrypt).not.toHaveBeenCalled();
  });
});
