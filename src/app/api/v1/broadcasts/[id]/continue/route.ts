import { after } from 'next/server';
import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { BroadcastError, deliverBroadcast } from '@/lib/whatsapp/broadcast-core';
import { claimBroadcastDelivery, planBroadcastResume, releaseBroadcastDelivery } from '@/lib/whatsapp/broadcast-resume';
import { continueBroadcastAutomatically } from '@/lib/whatsapp/broadcast-continuation';

/** Run the next bounded batch. Repeated calls cannot reclaim attempted rows. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let lock: { accountId: string; id: string; db: Awaited<ReturnType<typeof requireApiKey>>['supabase'] } | null = null;
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await context.params;
    if (!await claimBroadcastDelivery(ctx.supabase, ctx.accountId, id)) return fail('busy', 'Broadcast is busy or was not found', 409);
    lock = { accountId: ctx.accountId, id, db: ctx.supabase };
    const { plan, remaining } = await planBroadcastResume(ctx.supabase, ctx.accountId, id, 'pending');
    lock = null;
    after(async () => {
      try { await deliverBroadcast(ctx.supabase, plan); }
      finally { await releaseBroadcastDelivery(ctx.supabase, id); }
      await continueBroadcastAutomatically(ctx.supabase, ctx.accountId, id, request.url, request.headers.get('authorization'));
    });
    return ok({ broadcast_id: id, queued: plan.planned.length, remaining }, 202);
  } catch (error) {
    if (lock) await releaseBroadcastDelivery(lock.db, lock.id);
    if (error instanceof BroadcastError) return fail(error.code, error.message, error.status);
    return toApiErrorResponse(error);
  }
}
