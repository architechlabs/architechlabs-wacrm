-- Refuse to change existing data if global Meta IDs are already duplicated.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.messages WHERE message_id IS NOT NULL
             GROUP BY message_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate message_id values exist; review before enabling external message logging';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_global_message_id
  ON public.messages(message_id) WHERE message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.log_external_message(
  p_account_id uuid, p_config_id uuid, p_conversation_id uuid, p_contact_id uuid,
  p_wamid text, p_content_type text, p_content_text text, p_template_name text,
  p_status text, p_sent_at timestamptz, p_error_code integer, p_broadcast_id uuid
) RETURNS TABLE(message_id uuid, conversation_id uuid, duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_conversation uuid;
BEGIN
  IF p_status NOT IN ('sent','delivered','read','failed') OR p_content_type NOT IN ('text','template') THEN
    RAISE EXCEPTION 'Invalid external message' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.conversations c
    WHERE c.id = p_conversation_id AND c.account_id = p_account_id
      AND c.contact_id = p_contact_id AND c.whatsapp_config_id = p_config_id) THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '22023';
  END IF;
  IF p_broadcast_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.broadcasts b
    WHERE b.id = p_broadcast_id AND b.account_id = p_account_id AND b.whatsapp_config_id = p_config_id) THEN
    RAISE EXCEPTION 'Broadcast not found' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text,
    template_name, message_id, status, created_at, failure_code, broadcast_id)
  VALUES (p_conversation_id, 'agent', p_content_type, p_content_text, p_template_name,
    p_wamid, p_status, p_sent_at, p_error_code, p_broadcast_id)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT m.id, m.conversation_id INTO v_id, v_conversation
    FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.message_id = p_wamid AND c.account_id = p_account_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Message ID unavailable' USING ERRCODE = '23505'; END IF;
    RETURN QUERY SELECT v_id, v_conversation, true;
    RETURN;
  END IF;
  UPDATE public.conversations c SET last_message_text = p_content_text,
    last_message_at = p_sent_at, updated_at = now()
  WHERE c.id = p_conversation_id AND c.account_id = p_account_id
    AND (c.last_message_at IS NULL OR c.last_message_at <= p_sent_at);
  IF p_broadcast_id IS NOT NULL THEN
    UPDATE public.broadcast_recipients r SET whatsapp_message_id = p_wamid,
      status = p_status, sent_at = p_sent_at,
      delivered_at = CASE WHEN p_status IN ('delivered','read') THEN p_sent_at ELSE r.delivered_at END,
      read_at = CASE WHEN p_status = 'read' THEN p_sent_at ELSE r.read_at END,
      error_code = CASE WHEN p_status = 'failed' THEN p_error_code ELSE r.error_code END
    WHERE r.broadcast_id = p_broadcast_id AND r.contact_id = p_contact_id
      AND r.status = 'pending' AND r.whatsapp_message_id IS NULL;
  END IF;
  RETURN QUERY SELECT v_id, p_conversation_id, false;
END $$;
REVOKE ALL ON FUNCTION public.log_external_message(uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,integer,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_external_message(uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz,integer,uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
