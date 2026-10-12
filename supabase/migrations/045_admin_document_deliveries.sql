-- Additive, NOT applied by application startup. Review and apply separately.
-- 044 is reserved for the existing local Razorpay webhook work.
-- Server-only outbox: no PDF bytes, no public storage objects, no anonymous access.
CREATE TABLE admin_document_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  api_key_id UUID NOT NULL,
  delivery_key TEXT NOT NULL CHECK (length(delivery_key) = 64),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  document_kind TEXT NOT NULL CHECK (document_kind IN ('quotation','proforma','tax')),
  document_number TEXT NOT NULL,
  document_revision INTEGER CHECK (document_revision > 0),
  recipient TEXT NOT NULL,
  pdf_sha256 TEXT NOT NULL CHECK (length(pdf_sha256) = 64),
  filename TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','accepted','unknown')),
  message_id UUID,
  meta_media_id TEXT,
  whatsapp_message_id TEXT,
  consent_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, delivery_key)
);
ALTER TABLE admin_document_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_document_deliveries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON admin_document_deliveries TO service_role;
