import { describe, expect, it } from 'vitest';
import { BROADCAST_SUBREQUEST_BUDGET, runBroadcastSlice, type BroadcastSliceDriver } from './broadcast-queue-slice';

describe('queue slice budgets', () => {
  it('drains 20 unattempted recipients across bounded invocations', async () => {
    let pending = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
    const attempted = new Set<string>();
    let slices = 0;
    while (pending.length) {
      let time = 0;
      const driver: BroadcastSliceDriver = {
        now: () => time,
        reserve: async (r) => { expect(attempted.has(r.id)).toBe(false); attempted.add(r.id); return 'claimed'; },
        send: async () => { time += 2500; return { wamid: 'wamid.example' }; },
        finish: async () => {}, heartbeat: async () => true,
      };
      const result = await runBroadcastSlice(driver, pending);
      expect(result.subrequestAllowance).toBeLessThanOrEqual(BROADCAST_SUBREQUEST_BUDGET);
      expect(time).toBeLessThanOrEqual(20_000);
      expect(result.visited).toBeGreaterThan(0);
      pending = pending.slice(result.visited);
      slices++;
    }
    expect(attempted.size).toBe(20);
    expect(slices).toBeGreaterThan(1);
  });
  it.each([[131049, 2, false], [131048, 1, true], [130429, 1, true]])('handles %s', async (errorCode, visited, paused) => {
    let sends = 0;
    const driver: BroadcastSliceDriver = { now: () => 0, reserve: async () => 'claimed', send: async () => ++sends === 1 ? { errorCode, error: 'Meta error' } : { wamid: 'wamid.2' }, finish: async () => {}, heartbeat: async () => true };
    expect(await runBroadcastSlice(driver, [{ id: '1' }, { id: '2' }])).toMatchObject({ visited, paused });
  });
  it('stops before starting work when the deadline is close', async () => {
    let time = 0;
    const driver: BroadcastSliceDriver = { now: () => time, reserve: async () => 'claimed', send: async () => { time = 16_000; return { wamid: 'wamid.1' }; }, finish: async () => {}, heartbeat: async () => true };
    expect((await runBroadcastSlice(driver, [{ id: '1' }, { id: '2' }])).visited).toBe(1);
  });
});
