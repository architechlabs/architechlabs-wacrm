import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  insertError: null as { code?: string; message: string } | null,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  deletes: [] as string[],
  status: 'processed',
  updateThrows: false,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== 'razorpay_webhook_events')
        throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { status: state.status },
              error: null,
            }),
          }),
        }),
        insert: async (row: Record<string, unknown>) => {
          state.inserts.push(row);
          return { error: state.insertError };
        },
        update: (row: Record<string, unknown>) => {
          state.updates.push(row);
          return {
            eq: async () => {
              if (state.updateThrows)
                throw new Error('sensitive database error');
              return { error: null };
            },
          };
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
  body: unknown,
  options: { signature?: string | null; eventId?: string } = {}
) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const signature =
    options.signature === undefined
      ? createHmac('sha256', secret).update(rawBody).digest('hex')
      : options.signature;
  const headers = new Headers();
  if (signature) headers.set('x-razorpay-signature', signature);
  headers.set('x-razorpay-event-id', options.eventId ?? 'evt_default');
  return new Request('https://crm.example.com/api/razorpay/webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

describe('POST /api/razorpay/webhook', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    state.insertError = null;
    state.status = 'processed';
    state.updateThrows = false;
    state.inserts.length = 0;
    state.updates.length = 0;
    state.deletes.length = 0;
    vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', secret);
    vi.stubEnv('WHATSAPP_DESK_API_KEY', 'desk-api-key');
    vi.stubEnv('RAZORPAY_SETTLEMENT_RECIPIENT_PHONE', '+919876543210');
    vi.stubEnv('RAZORPAY_SETTLEMENT_RECIPIENT_NAME', 'Finance Team');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com');
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
          '01 Apr 2024',
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

  it.each(['{broken', 'null', '[]', '42'])(
    'rejects malformed JSON/object: %s',
    async (body) => {
      expect((await POST(requestFor(body))).status).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('verifies the original raw bytes including whitespace', async () => {
    expect(
      (await POST(requestFor(JSON.stringify(settlementBody, null, 2)))).status
    ).toBe(200);
  });

  it('rejects a signature with trailing non-hex characters', async () => {
    const signature = createHmac('sha256', secret)
      .update(JSON.stringify(settlementBody))
      .digest('hex');
    expect(
      (await POST(requestFor(settlementBody, { signature: signature + 'zz' })))
        .status
    ).toBe(401);
  });

  it('acknowledges completed duplicates without sending', async () => {
    state.insertError = { code: '23505', message: 'duplicate' };
    expect((await POST(requestFor(settlementBody))).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps concurrent duplicates retryable', async () => {
    state.insertError = { code: '23505', message: 'duplicate' };
    state.status = 'processing';
    expect((await POST(requestFor(settlementBody))).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'RAZORPAY_WEBHOOK_SECRET',
    'WHATSAPP_DESK_API_KEY',
    'RAZORPAY_SETTLEMENT_RECIPIENT_PHONE',
    'RAZORPAY_SETTLEMENT_RECIPIENT_NAME',
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_SITE_URL',
  ])('fails closed without %s', async (name) => {
    vi.stubEnv(name, '');
    expect((await POST(requestFor(settlementBody))).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it('requires E.164 with a country code and plus prefix', async () => {
    vi.stubEnv('RAZORPAY_SETTLEMENT_RECIPIENT_PHONE', '9876543210');
    expect((await POST(requestFor(settlementBody))).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prefers event time and formats the Kolkata date across UTC midnight', async () => {
    await POST(
      requestFor({
        ...settlementBody,
        created_at: Date.parse('2026-09-17T20:00:00Z') / 1000,
      })
    );
    const params = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
      .template.params;
    expect(params[3]).toBe('18 Sept 2026');
  });

  it('requires an event ID for persistent deduplication', async () => {
    const request = requestFor(settlementBody);
    request.headers.delete('x-razorpay-event-id');
    expect((await POST(request)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed if event persistence fails', async () => {
    state.insertError = { code: '42P01', message: 'missing table' };
    expect((await POST(requestFor(settlementBody))).status).toBe(502);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('releases failed network sends without logging credentials', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValueOnce(
      new Error('Bearer desk-api-key test-webhook-secret')
    );
    expect((await POST(requestFor(settlementBody))).status).toBe(502);
    expect(state.deletes).toEqual(['evt_default']);
    expect(JSON.stringify(log.mock.calls)).not.toContain('desk-api-key');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it('does not release a successfully sent event when completion persistence throws', async () => {
    state.updateThrows = true;
    expect((await POST(requestFor(settlementBody))).status).toBe(502);
    expect(state.deletes).toHaveLength(0);
  });
});
