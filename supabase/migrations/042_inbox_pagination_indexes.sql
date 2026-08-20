-- Support deterministic keyset pagination for the Inbox conversation and
-- message lists. Both timestamp columns are nullable in the applied schema,
-- so the index ordering explicitly matches the planned NULLS LAST queries.

CREATE INDEX IF NOT EXISTS idx_conversations_account_recency
  ON public.conversations (
    account_id,
    last_message_at DESC NULLS LAST,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_messages_conversation_recency
  ON public.messages (
    conversation_id,
    created_at DESC NULLS LAST,
    id DESC
  );
