-- Store bounded, sanitized diagnostics from Meta failed-status webhooks.
-- Existing messages remain NULL and unchanged. RLS and realtime settings are
-- inherited from the messages table and are not modified here.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS failure_code INTEGER,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

COMMENT ON COLUMN messages.failure_code IS
  'Numeric Meta error code from a failed outbound status webhook.';

COMMENT ON COLUMN messages.failure_reason IS
  'Sanitized, bounded Meta failure summary; never the raw webhook payload.';
