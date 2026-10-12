import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({auth:vi.fn(),admin:vi.fn(),visible:vi.fn(),download:vi.fn(),decrypt:vi.fn(() => 'synthetic')}));
vi.mock('@/lib/auth/account',() => ({
  requireRole:mocks.auth,
  UnauthorizedError:class UnauthorizedError extends Error {},
  ForbiddenError:class ForbiddenError extends Error {},
}));
vi.mock('@/lib/flows/admin-client',() => ({supabaseAdmin:mocks.admin}));
vi.mock('@/lib/whatsapp/encryption',() => ({decrypt:mocks.decrypt}));
vi.mock('@/lib/document-delivery/meta',() => ({DocumentMetaClient:class {download=mocks.download;}}));
import { UnauthorizedError } from '@/lib/auth/account';
import { GET } from './route';

const accountId='11111111-1111-4111-8111-111111111111';
const deliveryId='22222222-2222-4222-8222-222222222222';
const request=new Request(`https://desk.example/api/document-deliveries/${deliveryId}/pdf`);
const context={params:Promise.resolve({deliveryId})};
function query(data:unknown) {
  return {select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn(async () => ({data,error:null})),single:vi.fn(async () => ({data,error:null}))};
}

describe('private document attachment access',() => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({accountId,supabase:{from:mocks.visible}});
    mocks.visible.mockReturnValue(query({id:'message'}));
    mocks.download.mockResolvedValue(new Uint8Array(Buffer.from('%PDF-fixture')));
  });
  it('requires a signed-in account before any service-role read',async () => {
    mocks.auth.mockRejectedValue(new UnauthorizedError());
    expect((await GET(request,context)).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();expect(mocks.download).not.toHaveBeenCalled();
  });
  it('scopes attachment lookup to the signed-in account and accepted state',async () => {
    const outbox=query(null);mocks.admin.mockReturnValue({from:vi.fn(() => outbox)});
    expect((await GET(request,context)).status).toBe(404);
    expect(outbox.eq).toHaveBeenCalledWith('account_id',accountId);
    expect(outbox.eq).toHaveBeenCalledWith('id',deliveryId);
    expect(outbox.eq).toHaveBeenCalledWith('state','accepted');
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('denies access if the member cannot read the linked inbox message through RLS',async () => {
    const outbox=query({message_id:'message',meta_media_id:'456',filename:'invoice.pdf',pdf_sha256:'hash'});
    mocks.admin.mockReturnValue({from:vi.fn(() => outbox)});mocks.visible.mockReturnValue(query(null));
    expect((await GET(request,context)).status).toBe(404);
    expect(mocks.decrypt).not.toHaveBeenCalled();expect(mocks.download).not.toHaveBeenCalled();
  });
  it('returns the exact verified bytes privately using the account-owned configuration',async () => {
    const outbox=query({message_id:'message',meta_media_id:'456',filename:'invoice.pdf',pdf_sha256:'hash'});
    const settings=query({phone_number_id:'789',waba_id:'987',access_token:'encrypted'});
    mocks.admin.mockReturnValue({from:vi.fn((table:string) => table==='whatsapp_config' ? settings : outbox)});
    const response=await GET(request,context);
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('application/pdf');expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('%PDF-fixture'));
    expect(settings.eq).toHaveBeenCalledWith('account_id',accountId);
    expect(mocks.download).toHaveBeenCalledWith('456','hash');
  });
  it('does not expose credentials or provider errors from an expired attachment',async () => {
    mocks.auth.mockRejectedValue(new Error('PRIVATE TOKEN'));
    const response=await GET(request,context);
    expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE TOKEN');
  });
});
