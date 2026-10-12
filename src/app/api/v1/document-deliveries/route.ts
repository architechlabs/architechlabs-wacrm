import { requireApiKey } from '@/lib/auth/api-context';
import { decrypt } from '@/lib/whatsapp/encryption';
import { documentConfiguration, DocumentDeliveryError, prepareDocument } from '@/lib/document-delivery/contracts';
import { documentError, documentResponse, readDocumentRequest } from '@/lib/document-delivery/http';
import { DocumentMetaClient } from '@/lib/document-delivery/meta';
import { validateDocumentPdf } from '@/lib/document-delivery/pdf';
import { deliverDocument } from '@/lib/document-delivery/service';
import { SupabaseDocumentDeliveryStore } from '@/lib/document-delivery/store';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const config = documentConfiguration();
    if (!config) return documentResponse({enabled:false,policies:[]});
    const ctx = await requireApiKey(request,'documents:send');
    if (ctx.accountId !== config.accountId) throw new DocumentDeliveryError('forbidden',403);
    // Expose only reviewed text/maps, never Meta credentials or sample media.
    return documentResponse({enabled:true,policies:config.policies.map(({kind,bodyText,fields}) => ({kind,bodyText,fields}))});
  } catch (error) { return documentError(error); }
}
export async function POST(request: Request) {
  try {
    const config = documentConfiguration();
    if (!config) throw new DocumentDeliveryError('document_delivery_disabled',404);
    const ctx = await requireApiKey(request,'documents:send');
    if (ctx.accountId !== config.accountId) throw new DocumentDeliveryError('forbidden',403);
    const body = await readDocumentRequest(request);
    const kind = body && typeof body === 'object' ? (body as {kind?:unknown}).kind : undefined;
    const policy = config.policies.find(p => p.kind === kind);
    if (!policy) throw new DocumentDeliveryError('document_template_unconfigured',409);
    const doc = prepareDocument(body,policy);
    await validateDocumentPdf(doc.pdf);
    const { data:settings,error } = await ctx.supabase.from('whatsapp_config').select('phone_number_id,access_token,waba_id').eq('account_id',ctx.accountId).single();
    if (error || !settings) throw new DocumentDeliveryError('whatsapp_not_configured',503);
    const result = await deliverDocument(new SupabaseDocumentDeliveryStore(ctx),new DocumentMetaClient(settings.phone_number_id,decrypt(settings.access_token),settings.waba_id),policy,doc);
    return documentResponse(result,result.alreadySent ? 200 : 202);
  } catch (error) { return documentError(error); }
}
