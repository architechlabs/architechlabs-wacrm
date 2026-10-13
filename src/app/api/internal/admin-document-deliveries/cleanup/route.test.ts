import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ bucket: vi.fn(), removeExpired: vi.fn() }));
vi.mock('@/lib/document-delivery/supabase-payload-bucket', () => ({ privateSupabasePayloadBucket: mocks.bucket }));
import { POST } from './route';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('private temporary document cleanup', () => {
  it('does not access storage without its configured backend and private authorization', async () => {
    expect((await POST(new Request('https://desk.internal', { method: 'POST' }))).status).toBe(404);
    vi.stubEnv('ADMIN_DOCUMENT_PAYLOAD_STORAGE', 'supabase');
    vi.stubEnv('ADMIN_DOCUMENT_WORKER_TOKEN', 'a'.repeat(64));
    expect((await POST(new Request('https://desk.internal', { method: 'POST' }))).status).toBe(403);
    expect(mocks.bucket).not.toHaveBeenCalled();
  });
  it('removes expired files after sending has been disabled', async () => {
    vi.stubEnv('ADMIN_DOCUMENT_PAYLOAD_STORAGE', 'supabase');
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_DELIVERY', 'false');
    vi.stubEnv('ADMIN_DOCUMENT_WORKER_TOKEN', 'a'.repeat(64));
    mocks.bucket.mockResolvedValue({ removeExpired: mocks.removeExpired });
    mocks.removeExpired.mockResolvedValue(0);
    expect((await POST(new Request('https://desk.internal', {
      method: 'POST', headers: { Authorization: `Bearer ${'a'.repeat(64)}` },
    }))).status).toBe(204);
    expect(mocks.removeExpired).toHaveBeenCalledOnce();
  });
});
