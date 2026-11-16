-- Link new outgoing messages to the broadcast that created them.
-- Existing message and broadcast history is left unchanged.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS broadcast_id UUID REFERENCES public.broadcasts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_broadcast_id
  ON public.messages (broadcast_id) WHERE broadcast_id IS NOT NULL;
