import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

type RazorpaySettlement = {
  id?: string;
  amount?: number;
  created_at?: number;
  utr?: string;
};

type RazorpayWebhook = {
  event?: string;
  payload?: {
    settlement?: {
      entity?: RazorpaySettlement;
    };
  };
};

// The project does not currently expose generated Supabase database types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adminClient: any = null;

function supabaseAdmin() {
  if (!adminClient) {
    adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return adminClient;
}

function verifySignature(rawBody: string, signature: string, secret: string) {
  const expected = createHmac('sha256', secret).update(rawBody).digest();

  let received: Buffer;
  try {
    received = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }

  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

function formatAmount(amount: number) {
  return `INR ${(amount / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(createdAt: number) {
  return new Date(createdAt * 1000).toISOString().slice(0, 10);
}

async function claimEvent(eventId: string, eventType: string) {
  const { error } = await supabaseAdmin()
    .from('razorpay_webhook_events')
    .insert({
      event_id: eventId,
      event_type: eventType,
    });

  if (!error) return true;
  if (error.code === '23505') return false;
  throw new Error(`Unable to claim Razorpay event: ${error.message}`);
}

async function releaseEvent(eventId: string) {
  const { error } = await supabaseAdmin()
    .from('razorpay_webhook_events')
    .delete()
    .eq('event_id', eventId);

  if (error) {
    console.error('[razorpay-webhook] failed to release event claim', {
      eventId,
      error: error.message,
    });
  }
}

async function completeEvent(eventId: string) {
  const { error } = await supabaseAdmin()
    .from('razorpay_webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString() })
    .eq('event_id', eventId);

  if (error) {
    console.error('[razorpay-webhook] failed to mark event processed', {
      eventId,
      error: error.message,
    });
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-razorpay-signature');
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!secret) {
    console.error('[razorpay-webhook] webhook secret is not configured');
    return Response.json(
      { error: 'Webhook is not configured' },
      { status: 500 }
    );
  }

  if (!signature || !verifySignature(rawBody, signature, secret)) {
    console.warn('[razorpay-webhook] rejected request with invalid signature');
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: RazorpayWebhook;
  try {
    body = JSON.parse(rawBody) as RazorpayWebhook;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (body.event !== 'settlement.processed') {
    return Response.json({ status: 'ignored' }, { status: 200 });
  }

  const settlement = body.payload?.settlement?.entity;
  if (
    !settlement?.id ||
    typeof settlement.amount !== 'number' ||
    !Number.isFinite(settlement.amount) ||
    typeof settlement.created_at !== 'number' ||
    !settlement.utr
  ) {
    console.warn('[razorpay-webhook] settlement payload is incomplete');
    return Response.json(
      { error: 'Invalid settlement payload' },
      { status: 400 }
    );
  }

  const eventId = request.headers.get('x-razorpay-event-id');
  let claimed = false;

  try {
    if (eventId) {
      claimed = await claimEvent(eventId, body.event);
      if (!claimed) {
        return Response.json({ status: 'duplicate' }, { status: 200 });
      }
    } else {
      console.warn(
        '[razorpay-webhook] event ID missing; deduplication unavailable'
      );
    }

    const apiKey = process.env.WHATSAPP_DESK_API_KEY;
    const recipientPhone = process.env.RAZORPAY_SETTLEMENT_RECIPIENT_PHONE;
    const recipientName = process.env.RAZORPAY_SETTLEMENT_RECIPIENT_NAME;

    if (!apiKey || !recipientPhone || !recipientName) {
      throw new Error('WhatsApp settlement notification is not configured');
    }

    const response = await fetch(new URL('/api/v1/messages', request.url), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: recipientPhone,
        name: recipientName,
        type: 'template',
        template: {
          name: 'settlement_processed',
          language: 'en_US',
          params: [
            recipientName,
            settlement.id,
            formatAmount(settlement.amount),
            formatDate(settlement.created_at),
            settlement.utr,
          ],
        },
      }),
    });

    if (!response.ok) {
      console.error('[razorpay-webhook] WhatsApp API request failed', {
        eventId: eventId ?? 'missing',
        settlementId: settlement.id,
        status: response.status,
      });
      throw new Error('WhatsApp API request failed');
    }

    if (eventId) await completeEvent(eventId);

    console.info('[razorpay-webhook] settlement notification sent', {
      eventId: eventId ?? 'missing',
      settlementId: settlement.id,
    });
    return Response.json({ status: 'processed' }, { status: 200 });
  } catch (error) {
    if (eventId && claimed) await releaseEvent(eventId);
    console.error('[razorpay-webhook] processing failed', {
      eventId: eventId ?? 'missing',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return Response.json(
      { error: 'Webhook processing failed' },
      { status: 502 }
    );
  }
}
