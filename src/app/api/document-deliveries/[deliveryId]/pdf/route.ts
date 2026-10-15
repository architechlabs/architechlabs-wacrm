import { requireRole, UnauthorizedError, ForbiddenError } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { DocumentMetaClient } from '@/lib/document-delivery/meta';
import { DocumentDeliveryError } from '@/lib/document-delivery/contracts';

export const runtime = 'nodejs';
export async function GET(_request: Request,{params}:{params:Promise<{deliveryId:string}>}) {
  const headers = {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
  try {
    const ctx = await requireRole('viewer');
    const {deliveryId} = await params;
    if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) throw new DocumentDeliveryError('not_found',404);
    const db = supabaseAdmin();
    const {data,error} = await db.from('messages').select('id,message_id,admin_document_media_id,admin_document_metadata')
      .eq('admin_document_account_id',ctx.accountId).eq('id',deliveryId).eq('admin_document_state','accepted').maybeSingle();
    const metadata = data?.admin_document_metadata;
    if (error || !data?.admin_document_media_id || !data.message_id ||
        typeof metadata?.filename !== 'string' || typeof metadata?.pdfSha256 !== 'string') throw new DocumentDeliveryError('not_found',404);
    // In addition to account ownership, verify the logged-in user can read the inbox message through RLS.
    const visible = await ctx.supabase.from('messages').select('id').eq('id',data.id).maybeSingle();
    if (visible.error || !visible.data) throw new DocumentDeliveryError('not_found',404);
    const settings = await db.from('whatsapp_config').select('phone_number_id,access_token,waba_id').eq('account_id',ctx.accountId).single();
    if (settings.error || !settings.data) throw new DocumentDeliveryError('not_found',404);
    const pdf = await new DocumentMetaClient(settings.data.phone_number_id,decrypt(settings.data.access_token),settings.data.waba_id).download(data.admin_document_media_id,metadata.pdfSha256);
    return new Response(new Uint8Array(pdf),{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${metadata.filename.replace(/[^A-Za-z0-9._-]/g,'-')}"`}});
  } catch (error) {
    const status = error instanceof UnauthorizedError ? 401 : error instanceof ForbiddenError ? 403 : error instanceof DocumentDeliveryError ? error.status : 503;
    return Response.json({error:'The document is unavailable or its Meta media copy has expired.'},{status,headers});
  }
}
