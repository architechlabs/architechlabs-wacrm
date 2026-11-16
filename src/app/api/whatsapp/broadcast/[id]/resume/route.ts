import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { planBroadcastResume, RESUME_SCOPES, type ResumeScope } from '@/lib/whatsapp/broadcast-resume';
import { enqueueBroadcast } from '@/lib/whatsapp/broadcast-queue-runtime';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const limit = checkRateLimit(`broadcast-resume:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const scope: ResumeScope = RESUME_SCOPES.includes(body?.scope) ? body.scope : 'pending';
    const { plan, remaining, unsendable } = await planBroadcastResume(supabase, accountId, id, scope, body?.acknowledge_pause === true);
    await enqueueBroadcast({ account_id: accountId, broadcast_id: id });
    return NextResponse.json({ success: true, broadcast_id: id, scope, resuming: plan.planned.length, remaining, unsendable }, { status: 202 });
  } catch (error) {
    if (error instanceof BroadcastError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return toErrorResponse(error);
  }
}
