import { requireApiKey } from '@/lib/auth/api-context';
import { documentConfiguration, DocumentDeliveryError } from '@/lib/document-delivery/contracts';
import { documentError, documentResponse } from '@/lib/document-delivery/http';

export const runtime = 'nodejs';
export async function GET(request: Request, {params}: {params:Promise<{deliveryId:string}>}) {
  try {
    const config = documentConfiguration();
    if (!config) throw new DocumentDeliveryError('document_delivery_disabled',404);
    const ctx = await requireApiKey(request,'documents:send');
    if (ctx.accountId !== config.accountId) throw new DocumentDeliveryError('forbidden',403);
    const {deliveryId} = await params;
    if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) throw new DocumentDeliveryError('invalid_delivery_id',400);
    const {data,error} = await ctx.supabase.from('messages').select('id,admin_document_state,status')
      .eq('admin_document_account_id',ctx.accountId).eq('id',deliveryId).maybeSingle();
    if (error) throw new DocumentDeliveryError('document_storage_unavailable',503);
    if (!data) throw new DocumentDeliveryError('not_found',404);
    return documentResponse({deliveryId:data.id,status:data.admin_document_state,messageStatus:data.status});
  } catch (error) { return documentError(error); }
}
