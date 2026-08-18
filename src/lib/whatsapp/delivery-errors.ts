import type { SupabaseClient } from '@supabase/supabase-js';

import type { Message } from '@/types';

const ECOSYSTEM_ENGAGEMENT_ERROR_CODE = 131049;

export type WhatsAppDeliveryErrorCategory = 'recipient_delivery_restriction';

export interface WhatsAppDeliveryErrorClassification {
  code: number;
  category: WhatsAppDeliveryErrorCategory;
  retryableImmediately: boolean;
}

export const RECIPIENT_DELIVERY_RESTRICTION_MESSAGE =
  'Meta previously restricted this marketing message for this recipient. Sending again may fail. Explicit confirmation is required.';

export const RECIPIENT_RETRY_ACKNOWLEDGEMENT_CODE =
  'retry_acknowledgement_required';

export class RecipientRetryAcknowledgementRequiredError extends Error {
  constructor(message = RECIPIENT_DELIVERY_RESTRICTION_MESSAGE) {
    super(message);
    this.name = 'RecipientRetryAcknowledgementRequiredError';
  }
}

export function classifyWhatsAppDeliveryError(
  code: number | null | undefined
): WhatsAppDeliveryErrorClassification | null {
  if (code !== ECOSYSTEM_ENGAGEMENT_ERROR_CODE) return null;

  return {
    code: ECOSYSTEM_ENGAGEMENT_ERROR_CODE,
    category: 'recipient_delivery_restriction',
    retryableImmediately: false,
  };
}

export function isMarketingTemplateCategory(
  category: string | null | undefined
): boolean {
  return category?.trim().toLowerCase() === 'marketing';
}

export function isNoCustomerResponseConversation(messages: Message[]): boolean {
  if (messages.length === 0) return false;
  if (messages.some((message) => message.sender_type === 'customer')) {
    return false;
  }

  const onlyOutboundTemplates = messages.every(
    (message) =>
      message.sender_type === 'agent' && message.content_type === 'template'
  );
  if (!onlyOutboundTemplates) return false;

  return messages.some(
    (message) =>
      message.status === 'failed' &&
      classifyWhatsAppDeliveryError(message.failure_code)?.category ===
        'recipient_delivery_restriction'
  );
}

export class DeliveryRestrictionLookupError extends Error {
  constructor() {
    super('Could not verify recent template delivery restrictions');
    this.name = 'DeliveryRestrictionLookupError';
  }
}

/**
 * Return the most recent identical-template 131049 classification. This is
 * an acknowledgement gate, not a permanent block or a guessed Meta cooldown.
 * An authorized agent may deliberately retry after acknowledging the warning.
 */
export async function findTemplateDeliveryRestriction(
  db: SupabaseClient,
  conversationId: string,
  templateName: string
): Promise<WhatsAppDeliveryErrorClassification | null> {
  const { data: latest, error: latestError } = await db
    .from('messages')
    .select('status, failure_code')
    .eq('conversation_id', conversationId)
    .eq('content_type', 'template')
    .eq('template_name', templateName)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestError) throw new DeliveryRestrictionLookupError();
  if (!latest || latest.status !== 'failed') return null;

  const classification = classifyWhatsAppDeliveryError(latest.failure_code);
  return classification?.retryableImmediately === false ? classification : null;
}
