import { timingSafeEqual } from 'node:crypto';
import { documentConfiguration, DocumentDeliveryError } from '@/lib/document-delivery/contracts';
import { consumeDocumentJob, parseDocumentJob } from '@/lib/document-delivery/queue';
import { documentQueueRuntime } from '@/lib/document-delivery/queue-runtime';
import { SupabaseDocumentClaims } from '@/lib/document-delivery/queue-claims';
import { SupabaseDocumentDeliveryStore } from '@/lib/document-delivery/store';
import { DocumentMetaClient } from '@/lib/document-delivery/meta';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { enforceTemplateDeliveryRestriction } from '@/lib/whatsapp/send-message';
import type { ApiKeyContext } from '@/lib/auth/api-context';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  const headers = {'Cache-Control':'no-store'};
  // This private processing endpoint never accepts a public documents:send key.
  // Disabled mode returns before auth, binding lookup or DB access.
  if (process.env.ENABLE_ADMIN_DOCUMENT_QUEUE !== 'true' || process.env.ENABLE_ADMIN_DOCUMENT_DELIVERY !== 'true') return new Response(null,{status:404,headers});
  const expected = process.env.ADMIN_DOCUMENT_WORKER_TOKEN ?? '';
  const provided = request.headers.get('authorization') ?? '';
  if (!/^[0-9a-f]{64}$/iu.test(expected) || !/^Bearer [0-9a-f]{64}$/iu.test(provided) || !timingSafeEqual(Buffer.from(`Bearer ${expected}`),Buffer.from(provided))) return new Response(null,{status:403,headers});
  try {
    const config = documentConfiguration();
    if (!config) throw new DocumentDeliveryError('document_queue_disabled',404);
    if (request.headers.get('content-length') && Number(request.headers.get('content-length')) > 1024) throw new Error();
    // A metadata-only request: bound the stream too, not just Content-Length.
    const body = await request.body?.getReader();
    if (!body) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const {done,value} = await body.read();
        if (done) break;
        size += value.length;
        if (size > 1024) throw new Error();
        chunks.push(value);
      }
    } finally { await body.cancel().catch(() => undefined); }
    const job = parseDocumentJob(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (job.accountId !== config.accountId) return new Response(null,{status:403,headers});
    const db = supabaseAdmin();
    const {data:row,error} = await db.from('messages').select('id,conversation_id,message_id,admin_document_state,admin_document_fingerprint,admin_document_metadata')
      .eq('admin_document_account_id',job.accountId).eq('id',job.deliveryId).eq('admin_document_fingerprint',job.fingerprint).maybeSingle();
    if (error || !row) throw new Error();
    const metadata = row.admin_document_metadata;
    const policy = config.policies.find(p => p.kind === metadata?.kind);
    if (!policy || typeof metadata?.apiKeyId !== 'string') throw new Error();
    const ctx: ApiKeyContext = {authType:'api_key',supabase:db,accountId:job.accountId,keyId:metadata.apiKeyId,scopes:['documents:send'],createdBy:null};
    const store = new SupabaseDocumentDeliveryStore(ctx);
    // Recheck originating key liveness/scope at processing time. No key plaintext
    // is duplicated into a queue, R2 object or the background Worker.
    const {data:key,error:keyError} = await db.from('api_keys').select('id,scopes,revoked_at,expires_at')
      .eq('account_id',job.accountId).eq('id',metadata.apiKeyId).maybeSingle();
    if (keyError) throw new Error();
    if (!key || key.revoked_at || !Array.isArray(key.scopes) || !key.scopes.includes('documents:send') ||
        (key.expires_at && (!Number.isFinite(Date.parse(key.expires_at)) || Date.parse(key.expires_at) <= Date.now()))) {
      await store.unknown(row.id).catch(() => undefined);
      return new Response(null,{status:409,headers});
    }
    // Restrictions can change between enqueue and processing. Recheck the
    // existing Inbox's recipient/template restriction before provider access.
    if (row.admin_document_state === 'reserved') {
      await enforceTemplateDeliveryRestriction(db,row.conversation_id,policy.name);
    }
    const {data:settings,error:settingsError} = await db.from('whatsapp_config').select('phone_number_id,access_token,waba_id').eq('account_id',job.accountId).single();
    if (settingsError || !settings) throw new Error();
    const {payloads} = await documentQueueRuntime();
    const result = await consumeDocumentJob({job,accountId:job.accountId,policy,
      record:{id:row.id,fingerprint:row.admin_document_fingerprint,state:row.admin_document_state,messageId:row.message_id ? row.id : null},
      store,claims:new SupabaseDocumentClaims(db,job.accountId),payloads,
      transport:new DocumentMetaClient(settings.phone_number_id,decrypt(settings.access_token),settings.waba_id),
    });
    return new Response(null,{status:result === 'accepted' ? 204 : 409,headers});
  } catch {
    return new Response(null,{status:503,headers});
  }
}
