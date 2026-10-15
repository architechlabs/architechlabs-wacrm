import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DOCUMENT_PAYLOAD_BUCKET, documentStorageFetch, SupabasePayloadBucket } from './supabase-payload-bucket';
import { MAX_ENCRYPTED_PAYLOAD_BYTES } from './queue-payloads';

const path = `admin-document-jobs/v1/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/${'a'.repeat(64)}`;
function fixture() {
  const files = {
    upload: vi.fn(async () => ({ data: { path }, error: null as object | null })),
    download: vi.fn(async () => ({ data: new Blob(['encrypted']), error: null })),
    remove: vi.fn(async () => ({ data: [], error: null })),
    listV2: vi.fn(async () => ({ data: { objects: [] as {key: string; name: string; created_at: string}[] }, error: null })),
  };
  const storage = {
    getBucket: vi.fn(async () => ({ data: { public: false, file_size_limit: MAX_ENCRYPTED_PAYLOAD_BYTES, allowed_mime_types: ['application/octet-stream'] }, error: null })),
    from: vi.fn(() => files),
  };
  return { storage, files, bucket: new SupabasePayloadBucket({ storage } as unknown as SupabaseClient) };
}
describe('private Supabase document payloads', () => {
  it('uses edge-compatible manual redirect handling and refuses credential forwarding',async () => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:307,headers:{Location:'https://evil.example'}}));
    await expect(documentStorageFetch(fetcher)('https://project.supabase.co/storage/v1/bucket/private',{headers:{Authorization:'Bearer synthetic'}})).rejects.toMatchObject({code:'document_payload_unavailable'});
    expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
  });
  it('refuses public buckets or an unexpected size limit', async () => {
    const f = fixture();
    await f.bucket.verifyPrivate();
    f.storage.getBucket.mockResolvedValue({ data: { public: true, file_size_limit: MAX_ENCRYPTED_PAYLOAD_BYTES, allowed_mime_types: ['application/octet-stream'] }, error: null });
    await expect(f.bucket.verifyPrivate()).rejects.toMatchObject({ code: 'document_queue_configuration_invalid' });
    f.storage.getBucket.mockResolvedValue({ data: { public: false, file_size_limit: MAX_ENCRYPTED_PAYLOAD_BYTES + 1, allowed_mime_types: ['application/octet-stream'] }, error: null });
    await expect(f.bucket.verifyPrivate()).rejects.toMatchObject({ code: 'document_queue_configuration_invalid' });
  });
  it('uses create-only uploads and never exposes an existing payload on conflict', async () => {
    const f = fixture();
    const options = { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { expiresAt: '123' } };
    await f.bucket.put(path, new Uint8Array([1]), options);
    expect(f.storage.from).toHaveBeenCalledWith(DOCUMENT_PAYLOAD_BUCKET);
    expect(f.files.upload).toHaveBeenCalledWith(path, expect.any(Uint8Array), expect.objectContaining({ upsert: false }));
    f.files.upload.mockResolvedValue({ data: { path }, error: { message: 'PRIVATE' } });
    await expect(f.bucket.put(path, new Uint8Array([2]), options)).rejects.toMatchObject({ code: 'document_payload_unavailable' });
    expect(f.files.download).not.toHaveBeenCalled();
    await expect(f.bucket.delete('../chat-media/file')).rejects.toMatchObject({ code: 'invalid_document_request' });
    expect(f.files.remove).not.toHaveBeenCalled();
  });
  it('cleans only strictly scoped files older than 24 hours', async () => {
    const f = fixture();
    const now = Date.parse('2026-10-13T12:00:00Z');
    f.files.listV2.mockResolvedValue({ data: { objects: [
      { key: path, name: path, created_at: '2026-10-12T11:00:00Z' },
      { key: path.replace(/a{64}$/, 'b'.repeat(64)), name: path, created_at: '2026-10-13T11:00:00Z' },
    ] }, error: null });
    expect(await f.bucket.removeExpired(now)).toBe(1);
    expect(f.files.remove).toHaveBeenCalledExactlyOnceWith([path]);
    f.files.remove.mockClear();
    f.files.listV2.mockResolvedValue({ data: { objects: [{ key: 'other-data/file', name: 'other-data/file', created_at: '2026-10-12T11:00:00Z' }] }, error: null });
    await expect(f.bucket.removeExpired(now)).rejects.toMatchObject({ code: 'invalid_document_request' });
    expect(f.files.remove).not.toHaveBeenCalled();
  });
});
