-- Restore the RPC if a deployment skipped migration 051, and refresh the
-- PostgREST schema cache so its named uuid argument is discoverable.
CREATE OR REPLACE FUNCTION public.get_inbox_awaiting_reply(p_whatsapp_config_id uuid)
RETURNS TABLE(conversation_id uuid, last_outbound_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT c.id, latest.created_at
  FROM conversations c
  CROSS JOIN LATERAL (
    SELECT m.sender_type, m.created_at
    FROM messages m
    WHERE m.conversation_id = c.id
      AND (m.sender_type = 'customer' OR (m.sender_type IN ('agent', 'bot') AND m.status IN ('sent', 'delivered', 'read')))
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) latest
  WHERE c.whatsapp_config_id = p_whatsapp_config_id
    AND latest.sender_type IN ('agent', 'bot')
    AND latest.created_at <= now() - interval '24 hours';
$$;
REVOKE ALL ON FUNCTION public.get_inbox_awaiting_reply(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inbox_awaiting_reply(uuid) TO authenticated;
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_id
  ON public.messages (conversation_id, created_at DESC, id DESC);
NOTIFY pgrst, 'reload schema';
