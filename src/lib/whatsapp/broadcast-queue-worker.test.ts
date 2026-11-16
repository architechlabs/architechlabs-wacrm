import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { processBroadcastJob } from './broadcast-queue-worker';

const h = vi.hoisted(() => ({ plan: vi.fn(), send: vi.fn(), claim: vi.fn(), release: vi.fn(), heartbeat: vi.fn(), finalize: vi.fn() }));
vi.mock('./broadcast-resume', () => ({ claimBroadcastDelivery: h.claim, releaseBroadcastDelivery: h.release, heartbeatBroadcastDelivery: h.heartbeat, planBroadcastResume: h.plan }));
vi.mock('./broadcast-core', async original => ({ ...(await original<typeof import('./broadcast-core')>()), finalizeBroadcastStatus: h.finalize }));
vi.mock('./meta-api', async original => ({ ...(await original<typeof import('./meta-api')>()), sendTemplateMessage: h.send }));

describe('broadcast queue worker', () => {
  beforeEach(() => { vi.clearAllMocks(); h.claim.mockResolvedValue('lease'); h.heartbeat.mockResolvedValue('lease2'); h.release.mockResolvedValue(undefined); h.finalize.mockResolvedValue(undefined); });
  it('drains 20 recipients across queue invocations without duplicate sends', async () => {
    const state = Array.from({ length: 20 }, (_, i) => ({ id: String(i), started: false, sent: false }));
    let calls = 0;
    const db = { rpc: async (name: string, args: Record<string, string>) => {
      calls++;
      const row = state.find(r => r.id === args.p_recipient_id)!;
      if (name === 'broadcast_claim_and_reserve') { if (row.started) return { data: [{ outcome: 'unavailable' }], error: null }; row.started = true; return { data: [{ outcome: 'claimed', message_id: row.id }], error: null }; }
      row.sent = true; return { error: null };
    } } as unknown as SupabaseClient;
    h.plan.mockImplementation(async () => {
      const pending = state.filter(r => !r.started);
      return { remaining: Math.max(0, pending.length - 10), plan: { planned: pending.slice(0, 10).map(r => ({ recipientRowId: r.id, phone: `91999999${r.id.padStart(4, '0')}`, params: [] })), phoneNumberId: 'line', accessToken: 'token', templateName: 'welcome', templateLanguage: 'en', templateRow: null } };
    });
    h.send.mockImplementation(async () => { calls++; return { messageId: `wamid.${calls}` }; });
    const queued: unknown[] = [];
    const queue = { send: async (job: unknown) => { queued.push(job); } };
    const job = { account_id: 'account', broadcast_id: 'broadcast' };
    let invocations = 0;
    do {
      calls = 0; const started = Date.now();
      await processBroadcastJob(db, queue, job);
      expect(calls + 10).toBeLessThanOrEqual(40);
      expect(Date.now() - started).toBeLessThan(20_000);
      invocations++;
      if (queued.length) queued.shift(); else break;
    } while (invocations < 10);
    expect(state.every(r => r.sent)).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(20);
    expect(invocations).toBeGreaterThan(1);
  });
  it('releases the lease if delivery fails after the claim', async () => {
    h.plan.mockResolvedValue({ remaining: 0, plan: { planned: [{ recipientRowId: '1', phone: '919999999999', params: [] }], templateRow: null } });
    const db = { rpc: async () => ({ data: [{ outcome: 'claimed', message_id: 'msg' }], error: null }) } as unknown as SupabaseClient;
    h.send.mockRejectedValueOnce(new Error('network lost'));
    await expect(processBroadcastJob(db, { send: async () => {} }, { account_id: 'account', broadcast_id: 'broadcast' })).rejects.toThrow('unknown');
    expect(h.release).toHaveBeenCalledWith(db, 'broadcast', 'lease');
  });
});
