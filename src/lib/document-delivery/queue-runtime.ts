import { getCloudflareContext } from '@opennextjs/cloudflare';
import { DocumentDeliveryError } from './contracts';
import type { DocumentJob, JobQueue } from './queue';
import { EncryptedDocumentPayloads, type PrivateBucket } from './queue-payloads';
import { privateSupabasePayloadBucket } from './supabase-payload-bucket';

interface DocumentQueueBindings {
  ADMIN_DOCUMENT_PAYLOADS?: PrivateBucket;
  ADMIN_DOCUMENT_QUEUE?: JobQueue;
  ADMIN_DOCUMENT_PAYLOAD_KEY?: string;
}
export async function documentQueueRuntime() {
  // An absent/OFF flag must not look up bindings or load encryption keys.
  if (process.env.ENABLE_ADMIN_DOCUMENT_QUEUE !== 'true') throw new DocumentDeliveryError('document_queue_disabled',404);
  try {
    const {env} = await getCloudflareContext({async:true});
    const bindings = env as unknown as DocumentQueueBindings;
    if (!bindings.ADMIN_DOCUMENT_QUEUE) throw new Error();
    const bucket = process.env.ADMIN_DOCUMENT_PAYLOAD_STORAGE === 'supabase'
      ? await privateSupabasePayloadBucket()
      : bindings.ADMIN_DOCUMENT_PAYLOADS;
    if (!bucket) throw new Error();
    const payloads = new EncryptedDocumentPayloads(bucket,bindings.ADMIN_DOCUMENT_PAYLOAD_KEY ?? '');
    const queue = {send:async (job: DocumentJob) => { await bindings.ADMIN_DOCUMENT_QUEUE!.send(job); }};
    return {payloads,queue};
  } catch { throw new DocumentDeliveryError('document_queue_configuration_invalid',503); }
}
