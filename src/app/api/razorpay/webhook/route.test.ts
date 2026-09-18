import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  insertError: null as { code?: string; message: string } | null,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  deletes: [] as string[],
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== 'razorpay_webhook_events')
        throw new Error(`unexpected table: ${table}`);
      return {
        insert: async (row: Record<string, unknown>) => {
          state.inserts.push(row);
          return { error: state.insertError };
        },
        update: (row: Record<string, unknown>) => {
          state.updates.push(row);
          return { eq: async () => ({ error: null }) };
        },
        delete: () => ({
          eq: async (_column: string, value: string) => {
            state.deletes.push(value);
            return { error: null };
          },
        }),
      };
    },
  }),
}));

import { POST } from './route';

const secret = 'test-webhook-secret';
const settlementBody = {
  event: 'settlement.processed',
  payload: {
    settlement: {
      entity: {
        id: 'setl_123',
        amount: 123456,
        created_at: 1711929600,
        utr: 'UTR123456',
      },
    },
  },
};

function requestFor(
  body: object,
  options: { signature?: string | null; eventId?: string } = {}
) {
  const rawBody = JSON.stringify(body);
  const signature =
    options.signature === undefined
      ? createHmac('sha256', secret).update(rawBody).digest('hex')
      : options.signature;
  const headers = new Headers();
  if (signature) headers.set('x-razorpay-signature', signature);
  if (options.eventId) headers.set('x-razorpay-event-id', options.eventId);
  return new Request('https://crm.example.com/api/razorpay/webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

describe('POST /api/razorpay/webhook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    state.insertError = null;
    state.inserts.length = 0;
    state.updates.length = 0;
    state.deletes.length = 0;
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    process.env.WHATSAPP_DESK_API_KEY = 'desk-api-key';
    process.env.RAZORPAY_SETTLEMENT_RECIPIENT_PHONE = '+919876543210';
    process.env.RAZORPAY_SETTLEMENT_RECIPIENT_NAME = 'Finance Team';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 201 }))
    );
  });

  it('accepts a valid signature', async () => {
    const response = await POST(requestFor({ event: 'payment.captured' }));
    expect(response.status).toBe(200);
  });

  it('rejects an invalid signature', async () => {
    const response = await POST(
      requestFor(settlementBody, { signature: '00'.repeat(32) })
    );
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a missing signature', async () => {
    const response = await POST(
      requestFor(settlementBody, { signature: null })
    );
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores non-settlement events', async () => {
    const response = await POST(requestFor({ event: 'payment.captured' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ignored' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends settlement.processed through the public WhatsApp API', async () => {
    const response = await POST(
      requestFor(settlementBody, { eventId: 'evt_123' })
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://crm.example.com/api/v1/messages'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer desk-api-key',
          'Content-Type': 'application/json',
        },
      })
    );
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      to: '+919876543210',
      name: 'Finance Team',
      type: 'template',
      template: {
        name: 'settlement_processed',
        language: 'en_US',
        params: [
          'Finance Team',
          'setl_123',
          'INR 1,234.56',
          '2024-04-01',
          'UTR123456',
        ],
      },
    });
    expect(state.inserts).toEqual([
      { event_id: 'evt_123', event_type: 'settlement.processed' },
    ]);
    expect(state.updates).toHaveLength(1);
  });

  it('returns 502 and releases the event claim when the WhatsApp API fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 500 }));

    const response = await POST(
      requestFor(settlementBody, { eventId: 'evt_failed' })
    );

    expect(response.status).toBe(502);
    expect(state.deletes).toEqual(['evt_failed']);
    expect(state.updates).toHaveLength(0);
  });
});
