-- Add queue delivery functions without changing existing rows or claims.
ALTER TABLE public.broadcasts ADD COLUMN IF NOT EXISTS message_params jsonb;
CREATE OR REPLACE FUNCTION public.broadcast_claim_and_reserve(
  p_account_id uuid, p_broadcast_id uuid, p_recipient_id uuid, p_content_text text
) RETURNS TABLE(outcome text, message_id uuid, conversation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claim text; v_contact uuid; v_line uuid; v_user uuid; v_template text;
  v_conversation uuid; v_message uuid;
BEGIN
  v_claim := public.claim_broadcast_recipient(p_account_id, p_broadcast_id, p_recipient_id);
  IF v_claim <> 'claimed' THEN RETURN QUERY SELECT v_claim, NULL::uuid, NULL::uuid; RETURN; END IF;
  SELECT r.contact_id, b.whatsapp_config_id, b.user_id, b.template_name
    INTO v_contact, v_line, v_user, v_template
  FROM public.broadcast_recipients r JOIN public.broadcasts b ON b.id = r.broadcast_id
  WHERE r.id = p_recipient_id AND b.id = p_broadcast_id AND b.account_id = p_account_id;
  IF v_contact IS NULL OR v_line IS NULL THEN RAISE EXCEPTION 'Broadcast recipient has no contact or line'; END IF;
  SELECT c.id INTO v_conversation FROM public.conversations c
    WHERE c.account_id = p_account_id AND c.whatsapp_config_id = v_line AND c.contact_id = v_contact
    ORDER BY c.created_at, c.id LIMIT 1;
  IF v_conversation IS NULL THEN
    INSERT INTO public.conversations(account_id,user_id,contact_id,whatsapp_config_id)
      VALUES(p_account_id,v_user,v_contact,v_line) ON CONFLICT DO NOTHING RETURNING id INTO v_conversation;
    IF v_conversation IS NULL THEN
      SELECT c.id INTO v_conversation FROM public.conversations c
        WHERE c.account_id = p_account_id AND c.whatsapp_config_id = v_line AND c.contact_id = v_contact
        ORDER BY c.created_at, c.id LIMIT 1;
    END IF;
  END IF;
  IF v_conversation IS NULL THEN RAISE EXCEPTION 'Could not resolve broadcast conversation'; END IF;
  INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,template_name,status,broadcast_id)
    VALUES(v_conversation,'agent','template',p_content_text,v_template,'sending',p_broadcast_id)
    RETURNING id INTO v_message;
  RETURN QUERY SELECT 'claimed'::text, v_message, v_conversation;
END $$;
REVOKE ALL ON FUNCTION public.broadcast_claim_and_reserve(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_claim_and_reserve(uuid,uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.broadcast_finish_recipient(
  p_account_id uuid, p_broadcast_id uuid, p_recipient_id uuid, p_message_id uuid,
  p_wamid text, p_error_code integer, p_error_message text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_conversation uuid; v_content text; v_template text;
BEGIN
  SELECT m.conversation_id,m.content_text,m.template_name INTO v_conversation,v_content,v_template
  FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id
  JOIN public.broadcast_recipients r ON r.id=p_recipient_id AND r.contact_id=c.contact_id
  JOIN public.broadcasts b ON b.id=r.broadcast_id AND b.id=m.broadcast_id
  WHERE m.id=p_message_id AND b.id=p_broadcast_id AND b.account_id=p_account_id
    AND c.account_id=p_account_id AND r.send_started_at IS NOT NULL
    AND r.whatsapp_message_id IS NULL AND r.status='pending'
  FOR UPDATE OF r,m;
  IF NOT FOUND THEN RAISE EXCEPTION 'Broadcast reservation not available'; END IF;
  IF p_wamid IS NOT NULL THEN
    UPDATE public.messages SET message_id=p_wamid,status='sent' WHERE id=p_message_id;
    UPDATE public.broadcast_recipients SET status='sent',sent_at=now(),whatsapp_message_id=p_wamid,error_message=NULL
      WHERE id=p_recipient_id;
  ELSE
    UPDATE public.messages SET status='failed',failure_code=p_error_code,failure_reason=left(p_error_message,500) WHERE id=p_message_id;
    UPDATE public.broadcast_recipients SET status='failed',error_code=p_error_code,error_message=left(p_error_message,500)
      WHERE id=p_recipient_id;
  END IF;
  UPDATE public.conversations SET last_message_text=COALESCE(NULLIF(v_content,''),'[Template: '||v_template||']'),
    last_message_at=now(),updated_at=now() WHERE id=v_conversation AND account_id=p_account_id;
  IF p_error_code IN (131048,130429,131056,368,131031,190) THEN
    UPDATE public.broadcasts SET delivery_paused_at=now(),delivery_pause_reason='Meta error '||p_error_code
      WHERE id=p_broadcast_id AND account_id=p_account_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.broadcast_finish_recipient(uuid,uuid,uuid,uuid,text,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_finish_recipient(uuid,uuid,uuid,uuid,text,integer,text) TO service_role;

CREATE OR REPLACE FUNCTION public.sweep_broadcast_queue()
RETURNS TABLE(account_id uuid,broadcast_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.broadcast_recipients r SET delivery_outcome='in_progress_or_unknown'
  WHERE r.send_started_at < now() - interval '10 minutes'
    AND r.whatsapp_message_id IS NULL AND r.status='pending'
    AND r.delivery_outcome IS DISTINCT FROM 'in_progress_or_unknown';
  RETURN QUERY SELECT b.account_id,b.id FROM public.broadcasts b
    WHERE b.status='sending' AND b.delivery_paused_at IS NULL
      AND (b.delivery_locked_at IS NULL OR b.delivery_locked_at < now() - interval '2 minutes')
      AND EXISTS (SELECT 1 FROM public.broadcast_recipients r WHERE r.broadcast_id=b.id
        AND r.status='pending' AND r.send_started_at IS NULL AND r.whatsapp_message_id IS NULL)
    ORDER BY b.updated_at NULLS FIRST,b.id LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION public.sweep_broadcast_queue() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_broadcast_queue() TO service_role;
NOTIFY pgrst, 'reload schema';
