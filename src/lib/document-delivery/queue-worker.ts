import { parseDocumentJob } from './queue-job';

export interface DocumentWorkerEnvironment {
  ENABLE_ADMIN_DOCUMENT_QUEUE_CONSUMER?: string;
  ADMIN_DOCUMENT_WORKER_TOKEN?: string;
  DESK?: {fetch(request: Request): Promise<Response>};
}
export interface QueueMessage {
  body: unknown;
  ack(): void;
  retry(): void;
}
export interface QueueBatch { messages: QueueMessage[] }
const endpoint = 'https://desk.internal/api/internal/admin-document-deliveries/process';

export async function processDocumentQueue(batch: QueueBatch, env: DocumentWorkerEnvironment) {
  // Failed/OFF jobs go to the configured DLQ, not a Meta send retry. The consumer
  // config has max_retries=0; the durable Inbox claim also blocks redelivery.
  for (const message of batch.messages) {
    try {
      if (env.ENABLE_ADMIN_DOCUMENT_QUEUE_CONSUMER !== 'true' || !env.DESK || !/^[0-9a-f]{64}$/iu.test(env.ADMIN_DOCUMENT_WORKER_TOKEN ?? '')) throw new Error();
      const job = parseDocumentJob(message.body);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(),45_000);
      try {
        // Private service binding only. There is no arbitrary HTTP target, public
        // PDF URL, Supabase credential or Meta token in this Worker or queue.
        const response = await env.DESK.fetch(new Request(endpoint,{
          method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.ADMIN_DOCUMENT_WORKER_TOKEN}`},
          body:JSON.stringify(job),signal:controller.signal,redirect:'error',
        }));
        // Terminal tiny response: do not parse/log an untrusted provider body.
        await response.body?.cancel();
        if (response.status === 204) message.ack();
        else throw new Error();
      } finally { clearTimeout(timer); }
    } catch {
      message.retry();
      // No logs of payloads, credentials, PDF bytes or upstream errors.
    }
  }
}
const worker = {
  fetch() { return new Response(null,{status:404,headers:{'Cache-Control':'no-store'}}); },
  queue: processDocumentQueue,
  async scheduled(_event: unknown, env: DocumentWorkerEnvironment) {
    if (!env.DESK || !/^[0-9a-f]{64}$/iu.test(env.ADMIN_DOCUMENT_WORKER_TOKEN ?? '')) throw new Error('Document cleanup configuration unavailable');
    const response = await env.DESK.fetch(new Request('https://desk.internal/api/internal/admin-document-deliveries/cleanup', {
      method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_DOCUMENT_WORKER_TOKEN}` },
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    }));
    await response.body?.cancel();
    if (response.status !== 204) throw new Error('Document cleanup failed');
  },
};
export default worker;
