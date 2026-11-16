-- Claims are permanent: an interrupted Meta request may already have been
-- accepted, so a later worker must not send the same recipient again.
ALTER TABLE public.broadcast_recipients
  ADD COLUMN IF NOT EXISTS send_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_outcome text,
  ADD COLUMN IF NOT EXISTS phone_e164 text;

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS delivery_paused_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_account_idempotency
  ON public.broadcasts(account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_recipient_phone_e164
  ON public.broadcast_recipients(broadcast_id, phone_e164)
  WHERE phone_e164 IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_broadcast_idempotent(
  p_account_id uuid, p_user_id uuid, p_name text, p_template_name text,
  p_template_language text, p_contact_ids uuid[], p_phones text[],
  p_template_params jsonb[], p_whatsapp_config_id uuid, p_idempotency_key text
) RETURNS TABLE(broadcast_id uuid, recipient_id uuid, contact_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'Idempotency key required';
  END IF;
  INSERT INTO broadcasts(account_id, user_id, name, template_name, template_language,
    total_recipients, whatsapp_config_id, idempotency_key, status)
  VALUES(p_account_id, p_user_id, p_name, p_template_name, p_template_language,
    cardinality(p_contact_ids), p_whatsapp_config_id, p_idempotency_key, 'sending') RETURNING id INTO v_id;
  RETURN QUERY WITH inserted AS (
    INSERT INTO broadcast_recipients(broadcast_id, contact_id, phone_e164, template_params, status)
    SELECT v_id, r.contact_id, r.phone, r.params, 'pending'
    FROM unnest(p_contact_ids, p_phones, p_template_params) AS r(contact_id, phone, params)
    RETURNING id, broadcast_recipients.contact_id
  ) SELECT v_id, inserted.id, inserted.contact_id FROM inserted;
END;
$$;
REVOKE ALL ON FUNCTION public.create_broadcast_idempotent(uuid, uuid, text, text, text, uuid[], text[], jsonb[], uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_idempotent(uuid, uuid, text, text, text, uuid[], text[], jsonb[], uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_broadcast_recipient(
  p_account_id uuid, p_broadcast_id uuid, p_recipient_id uuid
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_phone text;
  v_opted_out boolean;
BEGIN
  SELECT c.phone_normalized INTO v_phone
  FROM broadcast_recipients r
  JOIN broadcasts b ON b.id = r.broadcast_id
  JOIN contacts c ON c.id = r.contact_id AND c.account_id = b.account_id
  WHERE r.id = p_recipient_id AND b.id = p_broadcast_id
    AND b.account_id = p_account_id AND b.delivery_paused_at IS NULL AND r.status = 'pending'
    AND r.send_started_at IS NULL AND r.whatsapp_message_id IS NULL
  FOR UPDATE OF r;
  IF NOT FOUND OR v_phone IS NULL OR v_phone = '' THEN RETURN 'unavailable'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    JOIN tags t ON t.id = ct.tag_id
    WHERE c.account_id = p_account_id AND c.phone_normalized = v_phone
      AND regexp_replace(lower(t.name), '[^a-z0-9]', '', 'g') IN ('optout', 'optedout', 'unsubscribed', 'stop')
  ) OR EXISTS (
    SELECT 1 FROM contacts c
    JOIN conversations cv ON cv.contact_id = c.id AND cv.account_id = c.account_id
    JOIN messages m ON m.conversation_id = cv.id
    WHERE c.account_id = p_account_id AND c.phone_normalized = v_phone
      AND m.sender_type = 'customer' AND upper(btrim(m.content_text)) = 'STOP'
  ) INTO v_opted_out;

  IF v_opted_out THEN
    UPDATE broadcast_recipients SET status = 'failed', delivery_outcome = 'skipped_opt_out',
      error_message = 'Skipped: contact opted out' WHERE id = p_recipient_id;
    RETURN 'skipped_opt_out';
  END IF;
  UPDATE broadcast_recipients SET send_started_at = now() WHERE id = p_recipient_id;
  RETURN 'claimed';
END;
$$;
REVOKE ALL ON FUNCTION public.claim_broadcast_recipient(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_broadcast_recipient(uuid, uuid, uuid) TO service_role;
