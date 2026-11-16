import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { BroadcastJob, BroadcastQueue } from './broadcast-queue-worker';

/** Producer binding only; queue payloads never include credentials. */
export async function enqueueBroadcast(job: BroadcastJob): Promise<void> {
  const { env } = await getCloudflareContext({ async: true });
  const queue = (env as unknown as { BROADCAST_QUEUE?: BroadcastQueue }).BROADCAST_QUEUE;
  if (!queue) throw new Error('Broadcast queue is unavailable');
  await queue.send(job);
}
