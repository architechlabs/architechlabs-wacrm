import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { planBroadcastResume, RESUME_SCOPES, type ResumeScope } from '@/lib/whatsapp/broadcast-resume';
import { enqueueBroadcast } from '@/lib/whatsapp/broadcast-queue-runtime';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const scope: ResumeScope = RESUME_SCOPES.includes(body?.scope) ? body.scope : 'pending';
    const { plan, remaining } = await planBroadcastResume(ctx.supabase, ctx.accountId, id, scope, body?.acknowledge_pause === true);
    await enqueueBroadcast({ account_id: ctx.accountId, broadcast_id: id });
    return ok({ broadcast_id: id, queued: plan.planned.length, remaining }, 202);
  } catch (error) {
    if (error instanceof BroadcastError) return fail(error.code, error.message, error.status);
    return toApiErrorResponse(error);
  }
}
