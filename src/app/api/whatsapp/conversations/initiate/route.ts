import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { initiateConversationWithTemplate } from '@/lib/whatsapp/initiate-conversation';
import { SendMessageError } from '@/lib/whatsapp/send-message';

function publicSendError(error: SendMessageError): string {
  if (error.code === 'meta_error') {
    return 'Meta rejected the message. Check the recipient and approved template configuration.';
  }
  if (error.code === 'db_error') {
    return 'The message could not be saved safely. Please try again.';
  }
  return error.message;
}

/**
 * Initiate one WhatsApp conversation with one approved Meta template.
 * Free-form messages are intentionally unsupported by this endpoint.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const limit = checkRateLimit(`initiate:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    try {
      const result = await initiateConversationWithTemplate(supabase, {
        accountId,
        userId,
        contactId:
          typeof body.contact_id === 'string' ? body.contact_id : undefined,
        phone: typeof body.phone === 'string' ? body.phone : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        templateId:
          typeof body.template_id === 'string' ? body.template_id : '',
        clientRequestId:
          typeof body.client_request_id === 'string'
            ? body.client_request_id
            : '',
        templateMessageParams: body.template_message_params,
      });

      return NextResponse.json({
        success: true,
        conversation_id: result.conversationId,
        contact_id: result.contactId,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
        contact_created: result.contactCreated,
        conversation_created: result.conversationCreated,
        deduplicated: result.deduplicated,
      });
    } catch (error) {
      if (error instanceof SendMessageError) {
        console.error('[initiate-conversation] controlled send failure:', {
          code: error.code,
          status: error.status,
        });
        return NextResponse.json(
          { error: publicSendError(error), code: error.code },
          { status: error.status }
        );
      }
      throw error;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
