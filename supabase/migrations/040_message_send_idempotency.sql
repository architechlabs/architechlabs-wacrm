-- ============================================================
-- 040_message_send_idempotency
--
-- A single-contact, business-initiated template send is reserved in
-- `messages` before Meta is called. The browser supplies a UUID for the
-- logical send attempt; this nullable column gives that attempt a durable
-- database identity so retries and double-clicks cannot send twice.
--
-- Existing messages remain unchanged (NULL keys never collide). The key is
-- scoped to a conversation so separate accounts/conversations can safely use
-- independently generated UUIDs without a global coordination point.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS client_request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_client_request
  ON messages (conversation_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
