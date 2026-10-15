import { timingSafeEqual } from 'node:crypto';
import { documentConfiguration, DocumentDeliveryError } from '@/lib/document-delivery/contracts';
import { privateSupabasePayloadBucket } from '@/lib/document-delivery/supabase-payload-bucket';
import { inspectConfiguredDocumentTemplates, verifyConfiguredDocumentTemplate } from '@/lib/document-delivery/template-readiness';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
function authorized(request: Request) {
  const expected = process.env.ADMIN_DOCUMENT_WORKER_TOKEN ?? '';
  const provided = request.headers.get('authorization') ?? '';
  return /^[0-9a-f]{64}$/iu.test(expected) && /^Bearer [0-9a-f]{64}$/iu.test(provided) &&
      timingSafeEqual(Buffer.from(`Bearer ${expected}`), Buffer.from(provided));
}
// Read-only live discovery works with send switches OFF and before candidate
// policies are pinned. Credentials stay inside Desk; no customer rows are read.
export async function GET(request: Request) {
  if (!authorized(request)) return new Response(null,{status:403,headers});
  try {
    return Response.json({templates:await inspectConfiguredDocumentTemplates(process.env.ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID ?? '')},{headers});
  } catch (error) {
    return Response.json({code:error instanceof DocumentDeliveryError ? error.code : 'document_readiness_unavailable'},{status:503,headers});
  }
}
export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null,{status:403,headers});
  try {
    // Validate configured templates while the production send switch stays OFF.
    const config = documentConfiguration({ ...process.env, ENABLE_ADMIN_DOCUMENT_DELIVERY: 'true' });
    if (!config) throw new Error();
    for (const policy of config.policies) await verifyConfiguredDocumentTemplate(config.accountId, policy);
    await privateSupabasePayloadBucket();
    return Response.json({ templatesVerified: config.policies.map(p => p.kind), privateStorageVerified: true }, { headers });
  } catch (error) {
    return Response.json({ code: error instanceof DocumentDeliveryError ? error.code : 'document_readiness_unavailable' }, { status: 503, headers });
  }
}
