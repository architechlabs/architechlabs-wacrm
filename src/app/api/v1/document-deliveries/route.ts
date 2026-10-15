import { requireApiKey } from '@/lib/auth/api-context';
import { documentConfiguration, DocumentDeliveryError, prepareDocument } from '@/lib/document-delivery/contracts';
import { documentError, documentResponse, readDocumentRequest } from '@/lib/document-delivery/http';
import { validateDocumentPdf } from '@/lib/document-delivery/pdf';
import { enqueueDocument } from '@/lib/document-delivery/queue';
import { documentQueueRuntime } from '@/lib/document-delivery/queue-runtime';
import { SupabaseDocumentDeliveryStore } from '@/lib/document-delivery/store';
import { verifyConfiguredDocumentTemplate } from '@/lib/document-delivery/template-readiness';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const config = documentConfiguration();
    if (!config || process.env.ENABLE_ADMIN_DOCUMENT_QUEUE !== 'true') return documentResponse({enabled:false,policies:[]});
    const ctx = await requireApiKey(request,'documents:send');
    if (ctx.accountId !== config.accountId) throw new DocumentDeliveryError('forbidden',403);
    await documentQueueRuntime();
    // With a pending Meta edit, hide the action until the exact Document/PDF
    // template is approved. Refreshing the dashboard rechecks automatically.
    const checks = await Promise.allSettled(config.policies.map(policy => verifyConfiguredDocumentTemplate(ctx.accountId, policy)));
    const policies = config.policies.filter((_policy, index) => checks[index].status === 'fulfilled');
    if (!policies.length) return documentResponse({enabled:false,policies:[]});
    return documentResponse({enabled:true,mode:'queued',policies:policies.map(({kind,bodyText,fields}) => ({kind,bodyText,fields}))});
  } catch (error) { return documentError(error); }
}
export async function POST(request: Request) {
  try {
    const config = documentConfiguration();
    if (!config || process.env.ENABLE_ADMIN_DOCUMENT_QUEUE !== 'true') throw new DocumentDeliveryError('document_delivery_disabled',404);
    const ctx = await requireApiKey(request,'documents:send');
    if (ctx.accountId !== config.accountId) throw new DocumentDeliveryError('forbidden',403);
    // Fail before reserving a message if storage/queue configuration is incomplete.
    // Never fall back to sending synchronously inside the dashboard request.
    const {payloads,queue} = await documentQueueRuntime();
    const body = await readDocumentRequest(request);
    const kind = body && typeof body === 'object' ? (body as {kind?:unknown}).kind : undefined;
    const policy = config.policies.find(p => p.kind === kind);
    if (!policy) throw new DocumentDeliveryError('document_template_unconfigured',409);
    const doc = prepareDocument(body,policy);
    await validateDocumentPdf(doc.pdf);
    // Reject an unapproved/non-document template before reserving an Inbox row.
    // The worker checks again immediately before upload/send in case approval
    // changes while a queued job is waiting.
    await verifyConfiguredDocumentTemplate(ctx.accountId, policy);
    const result = await enqueueDocument({accountId:ctx.accountId,store:new SupabaseDocumentDeliveryStore(ctx),payloads,queue,policy,document:doc});
    return documentResponse(result,result.alreadySent ? 200 : 202);
  } catch (error) { return documentError(error); }
}
