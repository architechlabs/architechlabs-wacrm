import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { processDocumentQueue } from './queue-worker';
import { JOB_TTL_MS } from './queue';

const body = {version:1,accountId:'11111111-1111-4111-8111-111111111111',deliveryId:'22222222-2222-4222-8222-222222222222',fingerprint:'a'.repeat(64),createdAt:1000,expiresAt:1000+JOB_TTL_MS};
const token='1'.repeat(64);
function fixture() {
  const message={body,ack:vi.fn(),retry:vi.fn()};
  const env={ENABLE_ADMIN_DOCUMENT_QUEUE_CONSUMER:'true',ADMIN_DOCUMENT_WORKER_TOKEN:token,DESK:{fetch:vi.fn(async (request:Request) => { expect(request.method).toBe('POST'); return new Response(null,{status:204}); })}};
  return {message,env};
}
afterEach(() => vi.useRealTimers());
describe('isolated queue Worker preparation', () => {
  it('calls only a fixed private service binding with metadata; acknowledges only terminal acceptance', async () => {
    const f=fixture(); await processDocumentQueue({messages:[f.message]},f.env);
    expect(f.message.ack).toHaveBeenCalledOnce(); expect(f.message.retry).not.toHaveBeenCalled();
    const request=f.env.DESK.fetch.mock.calls[0][0];
    expect(request.url).toBe('https://desk.internal/api/internal/admin-document-deliveries/process');
    expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(await request.json()).toEqual(body); expect(request.redirect).toBe('error');
  });
  it.each([{}, {ENABLE_ADMIN_DOCUMENT_QUEUE_CONSUMER:'false'}, {ADMIN_DOCUMENT_WORKER_TOKEN:'bad'}, {DESK:undefined}])('holds disabled/missing configuration for DLQ without sending: %j', async overrides => {
    const f=fixture(); const env=Object.keys(overrides).length ? {...f.env,...overrides} : {};
    await processDocumentQueue({messages:[f.message]},env);
    expect(f.env.DESK.fetch).not.toHaveBeenCalled(); expect(f.message.retry).toHaveBeenCalledOnce();
  });
  it.each([409,503,302])('does not ack or retry the service call after HTTP %s', async status => {
    const f=fixture(); f.env.DESK.fetch.mockResolvedValue(new Response('PRIVATE',{status}));
    await processDocumentQueue({messages:[f.message]},f.env);
    expect(f.env.DESK.fetch).toHaveBeenCalledOnce(); expect(f.message.ack).not.toHaveBeenCalled(); expect(f.message.retry).toHaveBeenCalledOnce();
  });
  it('rejects extra queue fields and exposes no public HTTP endpoint', async () => {
    const f=fixture(); await processDocumentQueue({messages:[{...f.message,body:{...body,pdfBase64:'PRIVATE'}}]},f.env);
    expect(f.env.DESK.fetch).not.toHaveBeenCalled(); expect(worker.fetch().status).toBe(404);
  });
  it('bounds a processing request without starting a second one after timeout', async () => {
    vi.useFakeTimers(); const f=fixture();
    f.env.DESK.fetch.mockImplementation(request => new Promise((_resolve,reject) => request.signal.addEventListener('abort',() => reject(new Error('aborted')))));
    const pending=processDocumentQueue({messages:[f.message]},f.env);
    await vi.advanceTimersByTimeAsync(45_000); await pending;
    expect(f.message.retry).toHaveBeenCalledOnce(); expect(f.env.DESK.fetch).toHaveBeenCalledOnce();
  });
});
