import { timingSafeEqual } from 'node:crypto';
import { privateSupabasePayloadBucket } from '@/lib/document-delivery/supabase-payload-bucket';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  // Cleanup remains available after sending is disabled, so queued documents
  // do not remain in temporary storage after a rollback.
  if (process.env.ADMIN_DOCUMENT_PAYLOAD_STORAGE !== 'supabase') return new Response(null, { status: 404, headers });
  const expected = process.env.ADMIN_DOCUMENT_WORKER_TOKEN ?? '';
  const provided = request.headers.get('authorization') ?? '';
  if (!/^[0-9a-f]{64}$/iu.test(expected) || !/^Bearer [0-9a-f]{64}$/iu.test(provided) ||
      !timingSafeEqual(Buffer.from(`Bearer ${expected}`), Buffer.from(provided))) {
    return new Response(null, { status: 403, headers });
  }
  try {
    await (await privateSupabasePayloadBucket()).removeExpired();
    return new Response(null, { status: 204, headers });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
