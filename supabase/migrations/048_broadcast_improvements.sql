-- ============================================================
-- 048_broadcast_improvements.sql
--
-- 1. Add error_code to broadcast_recipients for granular diagnostics.
-- 2. Expand status check constraints on broadcasts and broadcast_recipients
--    to include 'queued'.
-- 3. Set REPLICA IDENTITY FULL on messages and broadcast_recipients so
--    realtime UPDATE payloads reliably trigger client subscriptions.
-- ============================================================

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS error_code INTEGER;

COMMENT ON COLUMN broadcast_recipients.error_code IS
  'Numeric Meta Cloud API error code (e.g. 131048, 131056, 130429, 131049).';

ALTER TABLE broadcast_recipients DROP CONSTRAINT IF EXISTS broadcast_recipients_status_check;
ALTER TABLE broadcast_recipients
  ADD CONSTRAINT broadcast_recipients_status_check
  CHECK (status IN ('queued', 'pending', 'sent', 'delivered', 'read', 'replied', 'failed'));

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'queued', 'sending', 'sent', 'failed'));

-- Full replica identity for reliable realtime delivery of UPDATE events
ALTER TABLE messages REPLICA IDENTITY FULL;
ALTER TABLE broadcast_recipients REPLICA IDENTITY FULL;

-- Ensure incremental aggregate trigger treats 'queued' as non-contributing
CREATE OR REPLACE FUNCTION public._bcast_cols_for_status(s TEXT)
RETURNS TEXT[] AS $$
BEGIN
  IF s IN ('pending', 'queued') THEN RETURN ARRAY[]::TEXT[]; END IF;
  IF s = 'sent'      THEN RETURN ARRAY['sent_count']; END IF;
  IF s = 'delivered' THEN RETURN ARRAY['sent_count','delivered_count']; END IF;
  IF s = 'read'      THEN RETURN ARRAY['sent_count','delivered_count','read_count']; END IF;
  IF s = 'replied'   THEN RETURN ARRAY['sent_count','delivered_count','read_count','replied_count']; END IF;
  IF s = 'failed'    THEN RETURN ARRAY['failed_count']; END IF;
  RETURN ARRAY[]::TEXT[];
END;
$$ LANGUAGE plpgsql IMMUTABLE;
