import { NextResponse } from 'next/server';
import { ApiError } from '@/lib/api/v1/respond';
import { DocumentDeliveryError, MAX_REQUEST_BYTES } from './contracts';

export function documentError(error: unknown) {
  // Never expose/log provider response bodies, tokens, recipient numbers, or PDF data.
  const code = error instanceof ApiError || error instanceof DocumentDeliveryError ? error.code : 'document_delivery_unconfirmed';
  const status = error instanceof ApiError || error instanceof DocumentDeliveryError ? error.status : 503;
  return NextResponse.json({error:{code,message:'Document delivery was not confirmed. Review WhatsApp Desk before sending again; no automatic retry is made.'}},
    {status,headers:{'Cache-Control':'no-store',...(error instanceof ApiError ? error.headers : {})}});
}
export function documentResponse(data: unknown, status = 200) {
  return NextResponse.json({data},{status,headers:{'Cache-Control':'no-store'}});
}
export async function readDocumentRequest(request: Request): Promise<unknown> {
  if (new URL(request.url).search || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new DocumentDeliveryError('invalid_document_request',400);
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES) throw new DocumentDeliveryError('document_too_large',413);
  if (!request.body) throw new DocumentDeliveryError('invalid_document_request',400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timer = setTimeout(() => void reader.cancel(),10_000);
  try {
    for (;;) {
      const { done,value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_REQUEST_BYTES) throw new DocumentDeliveryError('document_too_large',413);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof DocumentDeliveryError) throw error;
    throw new DocumentDeliveryError('invalid_document_request',400);
  } finally { clearTimeout(timer); await reader.cancel().catch(() => undefined); }
}
