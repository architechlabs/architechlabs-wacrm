import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: mocks.auth }));
import { GET } from './route';

const accountId = '11111111-1111-4111-8111-111111111111';
const deliveryId = '22222222-2222-4222-8222-222222222222';
const request = new Request(`https://desk.example/api/v1/document-deliveries/${deliveryId}`);
const context = { params: Promise.resolve({ deliveryId }) };
function query(data: unknown, error: unknown = null) {
  return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn(async () => ({ data, error })) };
}
describe('document status from the existing inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY', 'true');
    vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID', accountId);
    vi.stubEnv('ADMIN_DOCUMENT_DELIVERY_TEMPLATES', JSON.stringify([{
      kind: 'quotation', name: 'quotation_pdf', language: 'en_US', metaTemplateId: '123',
      bodyText: 'Dear {{1}}, quotation {{2}} is attached.', fields: ['customerName', 'documentNumber'],
    }]));
    mocks.auth.mockResolvedValue({ accountId, supabase: { from: mocks.from } });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('does no authentication or DB work while disabled', async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY', 'false');
    expect((await GET(request, context)).status).toBe(404);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled();
  });
  it('returns acceptance separately from the webhook status using one account-scoped row', async () => {
    const message = query({ id: deliveryId, admin_document_state: 'accepted', status: 'read' });
    mocks.from.mockReturnValue(message);
    const response = await GET(request, context);
    expect(await response.json()).toEqual({ data: { deliveryId, status: 'accepted', messageStatus: 'read' } });
    expect(mocks.auth).toHaveBeenCalledWith(request, 'documents:send');
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith('messages');
    expect(message.eq).toHaveBeenCalledWith('admin_document_account_id', accountId);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('does not reveal messages owned by another account or ordinary messages', async () => {
    mocks.from.mockReturnValue(query(null));
    expect((await GET(request, context)).status).toBe(404);
    mocks.auth.mockResolvedValue({ accountId: 'another-account', supabase: { from: mocks.from } });
    mocks.from.mockClear();
    expect((await GET(request, context)).status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('sanitizes storage errors', async () => {
    mocks.from.mockReturnValue(query(null, { message: 'PRIVATE DATABASE DETAIL' }));
    const response = await GET(request, context);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE DATABASE DETAIL');
  });
});
