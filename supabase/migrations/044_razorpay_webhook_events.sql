-- Durable idempotency claims for Razorpay webhook deliveries.
CREATE TABLE IF NOT EXISTS public.razorpay_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'processed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

ALTER TABLE public.razorpay_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.razorpay_webhook_events FROM PUBLIC;
REVOKE ALL ON TABLE public.razorpay_webhook_events FROM anon;
REVOKE ALL ON TABLE public.razorpay_webhook_events FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.razorpay_webhook_events TO service_role;
