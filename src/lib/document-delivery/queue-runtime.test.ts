import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks=vi.hoisted(() => ({context:vi.fn()}));
vi.mock('@opennextjs/cloudflare',() => ({getCloudflareContext:mocks.context}));
import { documentQueueRuntime } from './queue-runtime';
import { SupabaseDocumentClaims } from './queue-claims';
import { JOB_TTL_MS } from './queue';

afterEach(() => {vi.unstubAllEnvs(); vi.clearAllMocks();});
describe('default-off queue bindings', () => {
  it('does not access bindings/keys when disabled', async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_QUEUE','false');
    await expect(documentQueueRuntime()).rejects.toMatchObject({code:'document_queue_disabled'});
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it('sanitizes missing bindings and invalid encryption keys', async () => {
    vi.stubEnv('ENABLE_ADMIN_DOCUMENT_QUEUE','true');
    for (const env of [{},{ADMIN_DOCUMENT_QUEUE:{send:vi.fn()},ADMIN_DOCUMENT_PAYLOADS:{},ADMIN_DOCUMENT_PAYLOAD_KEY:'PRIVATE'}]) {
      mocks.context.mockResolvedValue({env});
      await expect(documentQueueRuntime()).rejects.toMatchObject({code:'document_queue_configuration_invalid'});
    }
  });
});
describe('atomic scoped claim query', () => {
  const accountId='11111111-1111-4111-8111-111111111111';
  const deliveryId='22222222-2222-4222-8222-222222222222';
  const job={version:1 as const,accountId,deliveryId,fingerprint:'a'.repeat(64),createdAt:1000,expiresAt:1000+JOB_TTL_MS};
  function fixture() {
    const q={update:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),is:vi.fn().mockReturnThis(),select:vi.fn().mockReturnThis(),maybeSingle:vi.fn(async () => ({data:{id:deliveryId} as {id:string}|null,error:null as object|null}))};
    const from=vi.fn(() => q);
    return {q,from,claims:new SupabaseDocumentClaims({from} as unknown as SupabaseClient,accountId)};
  }
  it('claims only an unclaimed reserved row with exact account/id/fingerprint', async () => {
    const f=fixture(); expect(await f.claims.claim(job,deliveryId)).toBe(true);
    expect(f.from).toHaveBeenCalledWith('messages'); expect(f.q.update).toHaveBeenCalledWith({admin_document_claim_id:deliveryId});
    expect(f.q.eq.mock.calls).toEqual([['admin_document_account_id',accountId],['id',deliveryId],['admin_document_fingerprint',job.fingerprint],['admin_document_state','reserved']]);
    expect(f.q.is).toHaveBeenCalledWith('admin_document_claim_id',null);
    f.q.maybeSingle.mockResolvedValue({data:null,error:null});
    expect(await f.claims.claim(job,deliveryId)).toBe(false);
  });
  it('does not claim another account and sanitizes a DB failure', async () => {
    const f=fixture();
    await expect(f.claims.claim({...job,accountId:deliveryId},deliveryId)).rejects.toMatchObject({code:'forbidden'});
    expect(f.from).not.toHaveBeenCalled(); f.q.maybeSingle.mockResolvedValue({data:null,error:{message:'PRIVATE'}});
    await expect(f.claims.claim(job,deliveryId)).rejects.toMatchObject({code:'document_storage_unavailable'});
  });
});
