import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  resolveConversationByPhone,
  type ResolvedConversation,
} from '@/lib/whatsapp/resolve-conversation';
import {
  enforceTemplateDeliveryRestriction,
  SendMessageError,
  sendMessageToConversation,
} from '@/lib/whatsapp/send-message';
import {
  buildSendComponents,
  type SendTimeParams,
} from '@/lib/whatsapp/template-send-builder';
import {
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import type { MessageTemplate } from '@/types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 200;
const MAX_PHONE_INPUT_LENGTH = 40;
const MAX_PARAMETER_LENGTH = 1024;

export interface InitiateConversationParams {
  accountId: string;
  userId: string;
  contactId?: string | null;
  phone?: string | null;
  name?: string | null;
  templateId: string;
  clientRequestId: string;
  templateMessageParams?: unknown;
  acknowledgeRecipientRestriction?: boolean;
}

export interface InitiateConversationResult {
  conversationId: string;
  contactId: string;
  messageId: string;
  whatsappMessageId: string;
  contactCreated: boolean;
  conversationCreated: boolean;
  deduplicated: boolean;
}

function badRequest(message: string): never {
  throw new SendMessageError('bad_request', message, 400);
}

function parseSendTimeParams(value: unknown): SendTimeParams {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    badRequest('template_message_params must be an object');
  }

  const input = value as Record<string, unknown>;
  const body = input.body;
  const headerText = input.headerText;
  const buttonParams = input.buttonParams;

  if (
    body !== undefined &&
    (!Array.isArray(body) || body.some((entry) => typeof entry !== 'string'))
  ) {
    badRequest('Template body parameters must be strings');
  }
  if (headerText !== undefined && typeof headerText !== 'string') {
    badRequest('Template header parameter must be a string');
  }
  if (
    buttonParams !== undefined &&
    (typeof buttonParams !== 'object' ||
      buttonParams === null ||
      Array.isArray(buttonParams) ||
      Object.entries(buttonParams).some(
        ([key, entry]) => !/^\d+$/.test(key) || typeof entry !== 'string'
      ))
  ) {
    badRequest('Template button parameters must be string values');
  }

  const stringValues = [
    ...((body as string[] | undefined) ?? []),
    ...(typeof headerText === 'string' ? [headerText] : []),
    ...Object.values(
      (buttonParams as Record<string, string> | undefined) ?? {}
    ),
  ];
  if (stringValues.some((entry) => entry.length > MAX_PARAMETER_LENGTH)) {
    badRequest(
      `Template parameters must be ${MAX_PARAMETER_LENGTH} characters or fewer`
    );
  }

  return {
    body: (body as string[] | undefined)?.map((entry) => entry.trim()),
    headerText: typeof headerText === 'string' ? headerText.trim() : undefined,
    buttonParams:
      buttonParams === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(buttonParams as Record<string, string>).map(
              ([key, entry]) => [Number(key), entry.trim()]
            )
          ),
  };
}

async function loadUsableTemplate(
  db: SupabaseClient,
  accountId: string,
  templateId: string
): Promise<MessageTemplate> {
  const { data, error } = await db
    .from('message_templates')
    .select('*')
    .eq('id', templateId)
    .eq('account_id', accountId)
    .eq('status', 'APPROVED')
    .maybeSingle();

  if (error) {
    console.error('[initiate-conversation] approved template lookup failed:', {
      code: error.code,
    });
    throw new SendMessageError(
      'db_error',
      'Could not load approved templates',
      500
    );
  }
  if (!data || !isMessageTemplate(data) || !data.meta_template_id) {
    throw new SendMessageError(
      'no_approved_template',
      'Approved template not found. Sync templates from Meta and try again.',
      400
    );
  }
  return data;
}

function validateTemplateParameters(
  template: MessageTemplate,
  params: SendTimeParams
): void {
  const bodyVariableCount = extractVariableIndices(template.body_text).length;
  const body = params.body ?? [];
  if (
    body.length < bodyVariableCount ||
    body.slice(0, bodyVariableCount).some((entry) => !entry.trim())
  ) {
    badRequest('Every required template body variable must have a value');
  }

  try {
    buildSendComponents(template, params);
  } catch (error) {
    badRequest(
      error instanceof Error
        ? error.message
        : 'Template parameters are incomplete or invalid'
    );
  }
}

async function loadTargetPhone(
  db: SupabaseClient,
  accountId: string,
  contactId: string | null,
  phone: string | null
): Promise<string> {
  if (contactId) {
    const { data, error } = await db
      .from('contacts')
      .select('id, phone')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error || !data?.phone) {
      throw new SendMessageError('not_found', 'Contact not found', 404);
    }
    return data.phone;
  }
  return phone!;
}

async function findReservation(
  db: SupabaseClient,
  conversationId: string,
  clientRequestId: string
) {
  return db
    .from('messages')
    .select('id, status, message_id')
    .eq('conversation_id', conversationId)
    .eq('client_request_id', clientRequestId)
    .maybeSingle();
}

async function rollbackEmptyEntities(
  db: SupabaseClient,
  resolved: ResolvedConversation
): Promise<void> {
  if (!resolved.conversationCreated) return;

  const { data: message } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', resolved.conversationId)
    .limit(1)
    .maybeSingle();
  if (message) return;

  await db.from('conversations').delete().eq('id', resolved.conversationId);
  if (resolved.contactCreated) {
    const { data: anotherConversation } = await db
      .from('conversations')
      .select('id')
      .eq('contact_id', resolved.contactId)
      .limit(1)
      .maybeSingle();
    if (!anotherConversation) {
      await db.from('contacts').delete().eq('id', resolved.contactId);
    }
  }
}

/**
 * Send exactly one approved template to one existing contact or new E.164
 * number. The reservation row is the durable idempotency boundary: Meta is
 * never called unless this request owns a unique `client_request_id`.
 */
export async function initiateConversationWithTemplate(
  db: SupabaseClient,
  input: InitiateConversationParams
): Promise<InitiateConversationResult> {
  const contactId = input.contactId?.trim() || null;
  const phone = input.phone?.trim() || null;
  const name = input.name?.trim() || null;

  if ((contactId && phone) || (!contactId && !phone)) {
    badRequest('Choose one existing contact or enter one new phone number');
  }
  if (contactId && !UUID_PATTERN.test(contactId)) {
    badRequest('contact_id must be a valid UUID');
  }
  if (!UUID_PATTERN.test(input.templateId)) {
    badRequest('template_id must be a valid UUID');
  }
  if (!UUID_PATTERN.test(input.clientRequestId)) {
    badRequest('client_request_id must be a valid UUID');
  }
  if (phone && phone.length > MAX_PHONE_INPUT_LENGTH) {
    badRequest('Phone number is too long');
  }
  if (name && name.length > MAX_NAME_LENGTH) {
    badRequest(`Customer name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }

  // Approval and parameter checks happen before contact/conversation writes.
  const template = await loadUsableTemplate(
    db,
    input.accountId,
    input.templateId
  );
  const templateParams = parseSendTimeParams(input.templateMessageParams);
  validateTemplateParameters(template, templateParams);

  const targetPhone = await loadTargetPhone(
    db,
    input.accountId,
    contactId,
    phone
  );
  const resolved = await resolveConversationByPhone(
    db,
    input.accountId,
    targetPhone,
    contactId ? null : name,
    input.userId,
    contactId
  );

  // A fresh request id must not bypass a recorded recipient restriction
  // accidentally. Authorized callers may deliberately acknowledge the warning;
  // the reservation below remains the one-send idempotency boundary.
  await enforceTemplateDeliveryRestriction(
    db,
    resolved.conversationId,
    template.name,
    input.acknowledgeRecipientRestriction === true
  );

  const renderedText = templateContentText(
    template,
    templateBodyParams(templateParams.body, templateParams)
  );
  const reservationPayload = {
    conversation_id: resolved.conversationId,
    sender_type: 'agent',
    sender_id: input.userId,
    content_type: 'template',
    content_text: renderedText,
    template_name: template.name,
    client_request_id: input.clientRequestId,
    status: 'sending',
  };

  let { data: reservation, error: reservationError } = await db
    .from('messages')
    .insert(reservationPayload)
    .select('id, status, message_id')
    .single();

  if (isUniqueViolation(reservationError)) {
    const existing = await findReservation(
      db,
      resolved.conversationId,
      input.clientRequestId
    );
    if (existing.error || !existing.data) {
      throw new SendMessageError(
        'db_error',
        'Could not resolve the existing send attempt',
        500
      );
    }

    // A wamid proves Meta already accepted this logical send. Return the
    // original result even if a later delivery webhook marked it failed.
    if (existing.data.message_id) {
      return {
        conversationId: resolved.conversationId,
        contactId: resolved.contactId,
        messageId: existing.data.id,
        whatsappMessageId: existing.data.message_id,
        contactCreated: false,
        conversationCreated: false,
        deduplicated: true,
      };
    }
    if (existing.data.status === 'sending') {
      throw new SendMessageError(
        'duplicate_in_progress',
        'This message is already being sent',
        409
      );
    }

    // A failed reservation without a wamid means Meta rejected the previous
    // attempt before accepting it. Reuse the same row for an explicit retry.
    const retry = await db
      .from('messages')
      .update({ ...reservationPayload, message_id: null })
      .eq('id', existing.data.id)
      .eq('status', 'failed')
      .select('id, status, message_id')
      .single();
    reservation = retry.data;
    reservationError = retry.error;
  }

  if (reservationError || !reservation) {
    await rollbackEmptyEntities(db, resolved);
    console.error('[initiate-conversation] message reservation failed:', {
      code: reservationError?.code ?? 'missing_row',
    });
    throw new SendMessageError(
      'db_error',
      'Could not reserve the outbound message',
      500
    );
  }

  const sent = await sendMessageToConversation(db, input.accountId, {
    conversationId: resolved.conversationId,
    messageType: 'template',
    templateName: template.name,
    templateLanguage: template.language,
    templateParams: templateParams.body,
    templateMessageParams: templateParams,
    contentText: renderedText,
    reservedMessageId: reservation.id,
  });

  return {
    conversationId: resolved.conversationId,
    contactId: resolved.contactId,
    messageId: sent.messageId,
    whatsappMessageId: sent.whatsappMessageId,
    contactCreated: resolved.contactCreated,
    conversationCreated: resolved.conversationCreated,
    deduplicated: false,
  };
}
