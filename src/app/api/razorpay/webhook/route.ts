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
  created_at?: number;
  payload?: {
    settlement?: {
      entity?: RazorpaySettlement;
    };
  };
};

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function verifySignature(rawBody: Buffer, signature: string, secret: string) {
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) return false;
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
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(createdAt * 1000));
}

function validTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    Number.isFinite(new Date(value * 1000).getTime())
  );
}

async function claimEvent(eventId: string, eventType: string) {
  const { error } = await supabaseAdmin()
    .from('razorpay_webhook_events')
    .insert({
      event_id: eventId,
      event_type: eventType,
    });

  if (!error) return 'claimed';
  if (error.code === '23505') {
    const { data, error: lookupError } = await supabaseAdmin()
      .from('razorpay_webhook_events')
      .select('status')
      .eq('event_id', eventId)
      .maybeSingle();
    if (lookupError) throw new Error('Event lookup failed');
    return data?.status === 'processed' ? 'duplicate' : 'processing';
  }
  throw new Error('Unable to claim Razorpay event');
}

async function releaseEvent(eventId: string) {
  const { error } = await supabaseAdmin()
    .from('razorpay_webhook_events')
    .delete()
    .eq('event_id', eventId);

  if (error) {
    console.error('[razorpay-webhook] failed to release event claim', {});
  }
}

async function completeEvent(eventId: string) {
  const { error } = await supabaseAdmin()
    .from('razorpay_webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString() })
    .eq('event_id', eventId);

  if (error) {
    console.error('[razorpay-webhook] failed to mark event processed', {});
  }
}

export async function POST(request: Request) {
  const rawBody = Buffer.from(await request.arrayBuffer());
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
    body = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhook;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Invalid body');
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (body.event !== 'settlement.processed') {
    return Response.json({ status: 'ignored' }, { status: 200 });
  }

  const settlement = body.payload?.settlement?.entity;
  const timestamp = validTimestamp(body.created_at)
    ? body.created_at
    : settlement?.created_at;
  if (
    typeof settlement?.id !== 'string' ||
    !settlement.id.trim() ||
    typeof settlement.amount !== 'number' ||
    !Number.isSafeInteger(settlement.amount) ||
    settlement.amount < 0 ||
    !validTimestamp(timestamp) ||
    typeof settlement.utr !== 'string' ||
    !settlement.utr.trim()
  ) {
    console.warn('[razorpay-webhook] settlement payload is incomplete');
    return Response.json(
      { error: 'Invalid settlement payload' },
      { status: 400 }
    );
  }

  const eventId = request.headers.get('x-razorpay-event-id');
  if (!eventId?.trim() || eventId.length > 255) {
    return Response.json(
      { error: 'Missing or invalid event ID' },
      { status: 400 }
    );
  }
  let claimed = false;
  let sent = false;

  try {
    const apiKey = process.env.WHATSAPP_DESK_API_KEY;
    const recipientPhone =
      process.env.RAZORPAY_SETTLEMENT_RECIPIENT_PHONE?.trim();
    const recipientName =
      process.env.RAZORPAY_SETTLEMENT_RECIPIENT_NAME?.trim();

    if (
      !apiKey?.trim() ||
      !recipientPhone ||
      !/^\+[1-9]\d{6,14}$/.test(recipientPhone) ||
      !recipientName ||
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !process.env.NEXT_PUBLIC_SITE_URL
    ) {
      console.error('[razorpay-webhook] missing or invalid configuration');
      return Response.json(
        { error: 'Webhook is not configured' },
        { status: 500 }
      );
    }
    // Use the configured site origin, never an untrusted incoming Host header.
    const origin = new URL(process.env.NEXT_PUBLIC_SITE_URL);
    if (origin.protocol !== 'https:' || origin.username || origin.password)
      throw new Error('Invalid site origin');
    const claim = await claimEvent(eventId, body.event);
    if (claim === 'duplicate') return Response.json({ status: 'duplicate' });
    if (claim === 'processing')
      return Response.json(
        { error: 'Event processing pending' },
        { status: 503 }
      );
    claimed = true;

    const response = await fetch(new URL('/api/v1/messages', origin), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
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
            formatDate(timestamp),
            settlement.utr,
          ],
        },
      }),
    });

    if (!response.ok) {
      console.error('[razorpay-webhook] WhatsApp API request failed', {
        status: response.status,
      });
      throw new Error('WhatsApp API request failed');
    }

    sent = true;
    await completeEvent(eventId);

    console.info('[razorpay-webhook] settlement notification sent', {});
    return Response.json({ status: 'processed' }, { status: 200 });
  } catch {
    if (claimed && !sent) {
      try {
        await releaseEvent(eventId);
      } catch {
        console.error('[razorpay-webhook] failed to release event claim');
      }
    }
    console.error('[razorpay-webhook] processing failed');
    return Response.json(
      { error: 'Webhook processing failed' },
      { status: 502 }
    );
  }
}
