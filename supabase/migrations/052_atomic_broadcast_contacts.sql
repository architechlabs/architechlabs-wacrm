-- Insert missing contacts and create the campaign in one transaction. Existing
-- contacts are never overwritten. The unique line/normalized-phone index from
-- migration 047 arbitrates concurrent imports.
CREATE OR REPLACE FUNCTION public.create_broadcast_with_contacts(
  p_account_id uuid, p_user_id uuid, p_name text, p_template_name text,
  p_template_language text, p_recipients jsonb,
  p_whatsapp_config_id uuid, p_idempotency_key text
) RETURNS TABLE(broadcast_id uuid, recipient_id uuid, contact_id uuid, phone text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_broadcast_id uuid; v_inserted integer;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0
    OR jsonb_typeof(p_recipients) <> 'array' OR jsonb_array_length(p_recipients) = 0 THEN
    RAISE EXCEPTION 'Invalid broadcast input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM whatsapp_config w WHERE w.id = p_whatsapp_config_id AND w.account_id = p_account_id) THEN
    RAISE EXCEPTION 'WhatsApp number not found for account' USING ERRCODE = '22023';
  END IF;
  INSERT INTO broadcasts(account_id, user_id, name, template_name, template_language,
    total_recipients, whatsapp_config_id, idempotency_key, status)
  VALUES (p_account_id, p_user_id, p_name, p_template_name, p_template_language,
    jsonb_array_length(p_recipients), p_whatsapp_config_id, p_idempotency_key, 'sending')
  RETURNING id INTO v_broadcast_id;

  INSERT INTO contacts(account_id, user_id, whatsapp_config_id, phone, name)
  SELECT p_account_id, p_user_id, p_whatsapp_config_id, r.phone, r.phone
  FROM jsonb_to_recordset(p_recipients) AS r(phone text, params jsonb)
  ON CONFLICT (account_id, whatsapp_config_id, phone_normalized)
    WHERE phone_normalized <> '' AND whatsapp_config_id IS NOT NULL DO NOTHING;

  RETURN QUERY WITH inserted AS (
    INSERT INTO broadcast_recipients(broadcast_id, contact_id, phone_e164, template_params, status)
    SELECT v_broadcast_id, c.id, '+' || r.phone, r.params, 'pending'
    FROM jsonb_to_recordset(p_recipients) AS r(phone text, params jsonb)
    JOIN contacts c ON c.account_id = p_account_id
      AND c.whatsapp_config_id = p_whatsapp_config_id AND c.phone_normalized = r.phone
    RETURNING id, broadcast_recipients.contact_id, phone_e164
  ) SELECT v_broadcast_id, inserted.id, inserted.contact_id, inserted.phone_e164 FROM inserted;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> jsonb_array_length(p_recipients) THEN
    RAISE EXCEPTION 'Could not resolve every broadcast contact' USING ERRCODE = '23514';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.create_broadcast_with_contacts(uuid,uuid,text,text,text,jsonb,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_contacts(uuid,uuid,text,text,text,jsonb,uuid,text) TO service_role;
NOTIFY pgrst, 'reload schema';
