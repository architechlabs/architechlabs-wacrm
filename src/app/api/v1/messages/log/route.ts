import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { ExternalLogError, logExternalMessage } from '@/lib/whatsapp/external-message-log';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('bad_request', 'Request body must be a JSON object', 400);
    if ('messages' in body) {
      const messages = (body as { messages: unknown }).messages;
      if (!Array.isArray(messages) || messages.length < 1 || messages.length > 500) return fail('bad_request', 'messages must contain 1 to 500 items', 400);
      const results = [];
      for (const [index, item] of messages.entries()) {
        try { results.push({ index, data: await logExternalMessage(ctx.supabase, ctx.accountId, item) }); }
        catch (err) {
          const e = err instanceof ExternalLogError ? err : new ExternalLogError('internal', 'Could not record message', 500);
          results.push({ index, error: { code: e.code, message: e.message, status: e.status } });
        }
      }
      return ok({ results });
    }
    const data = await logExternalMessage(ctx.supabase, ctx.accountId, body);
    return ok(data, data.duplicate ? 200 : 201);
  } catch (err) {
    if (err instanceof ExternalLogError) return fail(err.code, err.message, err.status);
    return toApiErrorResponse(err);
  }
}
