import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  roleAllowed: true,
  initiate: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...args: unknown[]) => h.requireRole(...args),
  toErrorResponse: (error: { status?: number; message?: string }) =>
    Response.json(
      { error: error.message ?? 'Internal server error' },
      { status: error.status ?? 500 }
    ),
}));

vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { send: { limit: 60, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true, remaining: 59, reset: 0, limit: 60 }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));

vi.mock('@/lib/whatsapp/initiate-conversation', () => ({
  initiateConversationWithTemplate: (...args: unknown[]) => h.initiate(...args),
}));

import { SendMessageError } from '@/lib/whatsapp/send-message';
import { POST } from './route';

function request(overrides: Record<string, unknown> = {}) {
  return new Request('https://app.test/api/whatsapp/conversations/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contact_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      template_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      client_request_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      template_message_params: { body: [] },
      ...overrides,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.roleAllowed = true;
  h.requireRole.mockImplementation(async (minimum: string) => {
    if (!h.roleAllowed) {
      throw Object.assign(new Error('Insufficient role'), { status: 403 });
    }
    return {
      supabase: { from: vi.fn() },
      accountId: 'account-1',
      userId: 'user-1',
      role: 'agent',
      minimum,
    };
  });
  h.initiate.mockResolvedValue({
    conversationId: 'conversation-1',
    contactId: 'contact-1',
    messageId: 'message-1',
    whatsappMessageId: 'wamid.1',
    contactCreated: false,
    conversationCreated: false,
    deduplicated: false,
  });
});

describe('POST /api/whatsapp/conversations/initiate', () => {
  it('requires agent-or-higher authorization server-side', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(h.requireRole).toHaveBeenCalledWith('agent');
    expect(h.initiate).toHaveBeenCalledTimes(1);
  });

  it('refuses a viewer before any Meta workflow runs', async () => {
    h.roleAllowed = false;
    const response = await POST(
      request({ acknowledge_recipient_restriction: true })
    );
    expect(response.status).toBe(403);
    expect(h.initiate).not.toHaveBeenCalled();
  });

  it('passes an explicit retry acknowledgement to the authorized service', async () => {
    await POST(request({ acknowledge_recipient_restriction: true }));

    expect(h.initiate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ acknowledgeRecipientRestriction: true })
    );
  });

  it('accepts only the template initiation shape (no free-form message field)', async () => {
    await POST(request({ message_type: 'text', content_text: 'hello' }));
    expect(h.initiate).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ messageType: 'text', contentText: 'hello' })
    );
  });

  it('sanitizes a Meta rejection returned to the browser', async () => {
    h.initiate.mockRejectedValue(
      new SendMessageError(
        'meta_error',
        'raw Meta response with internal diagnostic detail',
        502
      )
    );
    const response = await POST(request());
    const payload = await response.json();
    expect(response.status).toBe(502);
    expect(payload).toEqual({
      error:
        'Meta rejected the message. Check the recipient and approved template configuration.',
      code: 'meta_error',
    });
    expect(JSON.stringify(payload)).not.toContain('internal diagnostic');
  });

  it('returns the agent-safe retry warning without exposing raw details', async () => {
    h.initiate.mockRejectedValue(
      new SendMessageError(
        'retry_acknowledgement_required',
        'Meta previously restricted this marketing message for this recipient. Sending again may fail. Explicit confirmation is required.',
        409
      )
    );

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual({
      error:
        'Meta previously restricted this marketing message for this recipient. Sending again may fail. Explicit confirmation is required.',
      code: 'retry_acknowledgement_required',
    });
    expect(h.initiate).toHaveBeenCalledTimes(1);
  });
});
