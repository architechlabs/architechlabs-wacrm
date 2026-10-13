-- REVIEW ONLY. Not applied by startup. Supersedes the unused 045 outbox design.
-- Apply explicitly in staging first, NOT via a blanket `supabase db push`.
-- No existing rows, RLS policies, generic send keys or tables are replaced.
-- Run the separate create-document-message-index.sql AFTER this transaction.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE public.messages
  ADD COLUMN admin_document_account_id uuid REFERENCES public.accounts(id),
  ADD COLUMN admin_document_key text,
  ADD COLUMN admin_document_fingerprint text,
  ADD COLUMN admin_document_metadata jsonb,
  ADD COLUMN admin_document_state text,
  ADD COLUMN admin_document_media_id text,
  ADD COLUMN admin_document_claim_id uuid,
  ADD CONSTRAINT messages_admin_document_shape CHECK (
    (admin_document_key IS NULL AND admin_document_account_id IS NULL
      AND admin_document_fingerprint IS NULL AND admin_document_metadata IS NULL
      AND admin_document_state IS NULL AND admin_document_media_id IS NULL AND admin_document_claim_id IS NULL)
    OR COALESCE((
      admin_document_account_id IS NOT NULL
      AND admin_document_key ~ '^[0-9a-f]{64}$'
      AND admin_document_fingerprint ~ '^[0-9a-f]{64}$'
      AND admin_document_state IN ('reserved','accepted','unknown')
      AND jsonb_typeof(admin_document_metadata) = 'object'
      AND admin_document_metadata ?& ARRAY['kind','documentNumber','revision','recipient','pdfSha256','filename','apiKeyId','consentConfirmedAt','metaTemplateId','language']
      AND (admin_document_metadata - ARRAY['kind','documentNumber','revision','recipient','pdfSha256','filename','apiKeyId','consentConfirmedAt','metaTemplateId','language']) = '{}'::jsonb
      AND admin_document_metadata->>'kind' IN ('quotation','proforma','tax')
      AND length(admin_document_metadata->>'documentNumber') BETWEEN 1 AND 40
      AND admin_document_metadata->>'recipient' ~ '^\+[1-9][0-9]{7,14}$'
      AND admin_document_metadata->>'pdfSha256' ~ '^[0-9a-f]{64}$'
      AND admin_document_metadata->>'filename' ~ '^[A-Za-z0-9._-]+\.pdf$'
      AND length(admin_document_metadata->>'consentConfirmedAt') > 0
      AND admin_document_metadata->>'metaTemplateId' ~ '^[0-9]{1,40}$'
      AND admin_document_metadata->>'language' ~ '^[a-z]{2}(_[A-Z]{2})?$'
      AND (admin_document_media_id IS NULL OR admin_document_media_id ~ '^[0-9]{1,40}$')
      AND (admin_document_state <> 'accepted' OR
        (message_id IS NOT NULL AND length(message_id) > 0 AND admin_document_media_id IS NOT NULL))
      AND content_type = 'template' AND sender_type = 'agent'
      AND media_type = 'application/pdf'
      AND media_url = '/api/document-deliveries/' || id::text || '/pdf'
      AND client_request_id IS NULL
    ), false)
  ) NOT VALID;
-- NOT VALID avoids a full historical-row scan while holding the DDL lock.
-- New/updated rows are checked immediately. Validate separately off peak.
-- TRUNCATE bypasses row-level DELETE triggers/RLS. No application path uses it;
-- leave destructive table-wide maintenance to a separately reviewed DB-admin task.
REVOKE TRUNCATE ON public.messages FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.protect_admin_document_message() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.admin_document_key IS NOT NULL THEN
      RAISE EXCEPTION 'document_message_retention_required' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.admin_document_key IS NOT NULL THEN
    IF current_user NOT IN ('service_role','postgres','supabase_admin') THEN
      RAISE EXCEPTION 'document_message_server_only' USING ERRCODE = '42501';
    END IF;
    -- Only delivery acknowledgement/state/media and existing webhook status fields
    -- may change. A generic retry cannot reuse, move or rewrite a document row.
    IF (to_jsonb(NEW) - ARRAY['message_id','status','failure_code','failure_reason','admin_document_state','admin_document_media_id','admin_document_claim_id'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['message_id','status','failure_code','failure_reason','admin_document_state','admin_document_media_id','admin_document_claim_id']) THEN
      RAISE EXCEPTION 'document_message_immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN
      RAISE EXCEPTION 'document_acknowledgement_immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.admin_document_claim_id IS DISTINCT FROM OLD.admin_document_claim_id AND
       (OLD.admin_document_claim_id IS NOT NULL OR OLD.admin_document_state <> 'reserved'
        OR NEW.admin_document_state <> 'reserved' OR NEW.message_id IS NOT NULL
        OR NEW.admin_document_media_id IS NOT NULL OR NEW.status IS DISTINCT FROM 'sending') THEN
      RAISE EXCEPTION 'document_claim_immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.admin_document_media_id IS NOT NULL AND NEW.admin_document_media_id IS DISTINCT FROM OLD.admin_document_media_id THEN
      RAISE EXCEPTION 'document_media_immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.admin_document_state IS DISTINCT FROM OLD.admin_document_state
       AND NOT (OLD.admin_document_state = 'reserved' AND NEW.admin_document_state IN ('accepted','unknown')) THEN
      RAISE EXCEPTION 'document_attempt_not_retryable' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'sending' AND OLD.status <> 'sending' THEN
      RAISE EXCEPTION 'document_attempt_not_retryable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.admin_document_key IS NOT NULL THEN
    IF TG_OP <> 'INSERT' OR current_user NOT IN ('service_role','postgres','supabase_admin') THEN
      RAISE EXCEPTION 'document_message_server_only' USING ERRCODE = '42501';
    END IF;
    IF NEW.admin_document_state IS DISTINCT FROM 'reserved' OR NEW.message_id IS NOT NULL
       OR NEW.admin_document_media_id IS NOT NULL OR NEW.admin_document_claim_id IS NOT NULL OR NEW.status IS DISTINCT FROM 'sending' THEN
      RAISE EXCEPTION 'document_reservation_invalid' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = NEW.conversation_id
                   AND c.account_id = NEW.admin_document_account_id) THEN
      RAISE EXCEPTION 'document_account_mismatch' USING ERRCODE = '42501';
    END IF;
    -- Fail closed if the separately built unique index is missing or invalid.
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid
      WHERE i.indrelid = 'public.messages'::regclass AND x.relname = 'idx_messages_admin_document_key'
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND pg_get_expr(i.indpred, i.indrelid) = '(admin_document_key IS NOT NULL)'
        AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, pos)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num ORDER BY k.pos)
          = ARRAY['admin_document_account_id','admin_document_key']
    ) THEN
      RAISE EXCEPTION 'document_unique_index_required' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_admin_document_message() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.protect_admin_document_message() TO anon, authenticated, service_role;
CREATE TRIGGER protect_admin_document_message BEFORE INSERT OR UPDATE OR DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.protect_admin_document_message();

CREATE FUNCTION public.protect_admin_document_conversation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id)
     AND EXISTS (SELECT 1 FROM public.messages WHERE conversation_id = OLD.id AND admin_document_key IS NOT NULL) THEN
    RAISE EXCEPTION 'document_conversation_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_admin_document_conversation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.protect_admin_document_conversation() TO anon, authenticated, service_role;
CREATE TRIGGER protect_admin_document_conversation BEFORE UPDATE OF account_id, contact_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.protect_admin_document_conversation();
COMMIT;
