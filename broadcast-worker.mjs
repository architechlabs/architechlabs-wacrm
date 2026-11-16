import openNextWorker from './.open-next/worker.js';
import { processBroadcastQueue, sweepBroadcastQueue } from './src/lib/whatsapp/broadcast-queue-worker.ts';
export * from './.open-next/worker.js';

export default {
  ...openNextWorker,
  queue: processBroadcastQueue,
  scheduled(_controller, env, ctx) { ctx.waitUntil(sweepBroadcastQueue(env)); },
};
