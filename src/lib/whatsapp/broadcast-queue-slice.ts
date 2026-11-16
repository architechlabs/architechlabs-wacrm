import { shouldPauseBroadcast } from './delivery-errors';

// Includes a conservative fixed allowance for loading, lease handling, and
// enqueue/finalization. Every adapter call below must stay within these costs.
export const BROADCAST_SUBREQUEST_BUDGET = 40;
export const BROADCAST_TIME_BUDGET_MS = 20_000;
export const BROADCAST_SLICE_OVERHEAD = 10;
export const BROADCAST_RECIPIENT_COST = 4; // reserve, Meta, finish, heartbeat allowance
export const BROADCAST_MIN_TIME_TO_START_MS = 5_000;

export type QueueRecipient = { id: string };
export interface BroadcastSliceDriver {
  now(): number;
  reserve(recipient: QueueRecipient): Promise<'claimed' | 'unavailable' | 'skipped_opt_out'>;
  send(recipient: QueueRecipient, timeoutMs: number): Promise<{ wamid: string } | { errorCode: number; error: string }>;
  finish(recipient: QueueRecipient, result: { wamid: string } | { errorCode: number; error: string }): Promise<void>;
  heartbeat(): Promise<boolean>;
}

/** A single bounded slice. Unknown outcomes retain the claim and are never resent. */
export async function runBroadcastSlice(driver: BroadcastSliceDriver, recipients: QueueRecipient[], started = driver.now()) {
  let budget = BROADCAST_SLICE_OVERHEAD;
  let visited = 0;
  let paused = false;
  for (const recipient of recipients) {
    const remaining = BROADCAST_TIME_BUDGET_MS - (driver.now() - started);
    if (budget + BROADCAST_RECIPIENT_COST > BROADCAST_SUBREQUEST_BUDGET || remaining < BROADCAST_MIN_TIME_TO_START_MS) break;
    budget += BROADCAST_RECIPIENT_COST;
    const claim = await driver.reserve(recipient);
    visited++;
    if (claim !== 'claimed') continue;
    if (BROADCAST_TIME_BUDGET_MS - (driver.now() - started) <= 4000) {
      throw new Error('Slice expired after claiming a recipient; outcome requires reconciliation');
    }
    // The adapter must abort or time out the provider request within this limit.
    // A timeout is an unknown outcome: do not finish or retry this recipient.
    const timeoutMs = BROADCAST_TIME_BUDGET_MS - (driver.now() - started) - 4000;
    const result = await driver.send(recipient, timeoutMs);
    await driver.finish(recipient, result);
    if ('errorCode' in result && shouldPauseBroadcast(result.errorCode)) { paused = true; break; }
    if (visited % 3 === 0 && !await driver.heartbeat()) throw new Error('Broadcast lease lost');
  }
  return { visited, paused, subrequestAllowance: budget };
}
