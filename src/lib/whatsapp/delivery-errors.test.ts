import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  classifyWhatsAppDeliveryError,
  findTemplateDeliveryRestriction,
  isMarketingTemplateCategory,
  isNoCustomerResponseConversation,
} from './delivery-errors';
import type { Message } from '@/types';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    conversation_id: 'conversation-1',
    sender_type: 'agent',
    content_type: 'template',
    template_name: 'marketing_offer',
    status: 'failed',
    created_at: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

function restrictionDb(options: {
  latest?: Record<string, unknown> | null;
}): SupabaseClient {
  return {
    from() {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return builder;
        },
        gt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data: options.latest ?? null,
          error: null,
        }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('WhatsApp delivery-error classification', () => {
  it('classifies 131049 as a non-immediate recipient restriction', () => {
    expect(classifyWhatsAppDeliveryError(131049)).toEqual({
      code: 131049,
      category: 'recipient_delivery_restriction',
      retryableImmediately: false,
    });
  });

  it('leaves unrelated and historical unknown errors unclassified', () => {
    expect(classifyWhatsAppDeliveryError(131026)).toBeNull();
    expect(classifyWhatsAppDeliveryError(null)).toBeNull();
  });

  it('recognizes marketing category without changing it', () => {
    expect(isMarketingTemplateCategory('Marketing')).toBe(true);
    expect(isMarketingTemplateCategory('Utility')).toBe(false);
  });
});

describe('template resend restriction', () => {
  const restricted = {
    status: 'failed',
    failure_code: 131049,
    created_at: '2026-08-18T10:00:00.000Z',
  };

  it('blocks two concurrent agents after the same recorded failure', async () => {
    const db = restrictionDb({ latest: restricted });

    const attempts = await Promise.all([
      findTemplateDeliveryRestriction(db, 'conversation-1', 'marketing_offer'),
      findTemplateDeliveryRestriction(db, 'conversation-1', 'marketing_offer'),
    ]);

    expect(attempts).toEqual([
      expect.objectContaining({ retryableImmediately: false }),
      expect.objectContaining({ retryableImmediately: false }),
    ]);
  });

  it('does not block a successful or unrelated failed status', async () => {
    await expect(
      findTemplateDeliveryRestriction(
        restrictionDb({ latest: { ...restricted, status: 'delivered' } }),
        'conversation-1',
        'marketing_offer'
      )
    ).resolves.toBeNull();
    await expect(
      findTemplateDeliveryRestriction(
        restrictionDb({ latest: { ...restricted, failure_code: 131026 } }),
        'conversation-1',
        'marketing_offer'
      )
    ).resolves.toBeNull();
  });
});

describe('restricted conversation state', () => {
  it('shows no customer response for outbound-only 131049 history', () => {
    expect(
      isNoCustomerResponseConversation([
        message({ id: 'first', failure_code: 131049 }),
        message({ id: 'second', failure_code: 131049 }),
      ])
    ).toBe(true);
  });

  it('returns to the existing session behavior after an inbound message', () => {
    expect(
      isNoCustomerResponseConversation([
        message({ failure_code: 131049 }),
        message({
          id: 'customer-1',
          sender_type: 'customer',
          content_type: 'text',
          content_text: 'Hello',
          status: 'delivered',
          created_at: '2026-08-18T11:00:00.000Z',
        }),
      ])
    ).toBe(false);
  });
});
