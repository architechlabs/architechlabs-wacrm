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
    const {data,error} = await ctx.supabase.from('admin_document_deliveries').select('id,state,message_id').eq('account_id',ctx.accountId).eq('id',deliveryId).maybeSingle();
    if (error) throw new DocumentDeliveryError('document_storage_unavailable',503);
    if (!data) throw new DocumentDeliveryError('not_found',404);
    let messageStatus: string | null = null;
    if (data.message_id) {
      // The outbox's immutable account-scoped link is the authorization boundary.
      const result = await ctx.supabase.from('messages').select('status').eq('id',data.message_id).maybeSingle();
      if (result.error) throw new DocumentDeliveryError('document_storage_unavailable',503);
      messageStatus = result.data?.status ?? null;
    }
    return documentResponse({deliveryId:data.id,status:data.state,messageStatus});
  } catch (error) { return documentError(error); }
}
