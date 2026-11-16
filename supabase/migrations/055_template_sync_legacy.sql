BEGIN;

-- Record the line used to import a WABA-shared template. Existing templates
-- remain scoped by WABA; several lines may share the same WABA.
ALTER TABLE public.message_templates
  ADD COLUMN IF NOT EXISTS whatsapp_config_id uuid REFERENCES public.whatsapp_config(id) ON DELETE RESTRICT;

-- Only associate rows already known to belong to the default WABA.
-- Unassigned rows and Meta IDs are reconciled using the sync response.
UPDATE public.message_templates t SET whatsapp_config_id = w.id
FROM public.whatsapp_config w
WHERE w.account_id = t.account_id AND w.is_default
  AND w.waba_id = '1055269280554939' AND t.waba_id = w.waba_id
  AND t.whatsapp_config_id IS NULL;

-- One template per WABA; identical names in distinct WABAs are independent.
-- Index creation fails without deleting anything if existing WABA duplicates exist.
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_waba_name_language_key
  ON public.message_templates (account_id, waba_id, name, language);
DROP INDEX IF EXISTS public.message_templates_user_name_language_key;

-- Serialize syncs and never move a different WABA's row on a name-only match.
CREATE OR REPLACE FUNCTION public.sync_waba_template(p_config_id uuid, p_template jsonb)
RETURNS TABLE(template_id uuid, was_inserted boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_account uuid; v_waba text; v_default boolean; v_user uuid := auth.uid();
  v_template public.message_templates%ROWTYPE; v_id uuid; v_count integer;
BEGIN
  SELECT account_id, waba_id, is_default INTO v_account, v_waba, v_default
  FROM public.whatsapp_config WHERE id = p_config_id;
  IF v_account IS NULL OR v_waba IS NULL OR v_user IS NULL
     OR NOT public.is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Not authorized to sync templates for this number' USING ERRCODE = '42501';
  END IF;
  v_template := jsonb_populate_record(NULL::public.message_templates, p_template);
  IF v_template.name IS NULL OR v_template.language IS NULL OR v_template.meta_template_id IS NULL THEN
    RAISE EXCEPTION 'Meta template name, language and ID are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_account::text || ':' || v_template.name || ':' || v_template.language, 0));

  SELECT count(*), min(id::text)::uuid INTO v_count, v_id FROM public.message_templates
  WHERE account_id = v_account AND waba_id = v_waba AND name = v_template.name AND language = v_template.language;
  IF v_count > 1 THEN RAISE EXCEPTION 'Multiple templates match this WABA, name and language; review duplicates'; END IF;

  IF v_id IS NULL THEN
    SELECT count(*), min(id::text)::uuid INTO v_count, v_id FROM public.message_templates
    WHERE account_id = v_account AND meta_template_id = v_template.meta_template_id
      AND name = v_template.name AND language = v_template.language;
    IF v_count > 1 THEN RAISE EXCEPTION 'Multiple templates match this Meta ID; review duplicates'; END IF;
  END IF;

  IF v_id IS NULL AND v_default THEN
    SELECT count(*), min(id::text)::uuid INTO v_count, v_id FROM public.message_templates
    WHERE account_id = v_account AND waba_id IS NULL AND (whatsapp_config_id IS NULL OR whatsapp_config_id = p_config_id)
      AND (meta_template_id IS NULL OR meta_template_id = v_template.meta_template_id)
      AND name = v_template.name AND language = v_template.language;
    IF v_count > 1 THEN RAISE EXCEPTION 'Multiple unassigned templates match; review duplicates'; END IF;
  END IF;

  IF v_id IS NOT NULL THEN
    UPDATE public.message_templates SET
      waba_id = v_waba, whatsapp_config_id = p_config_id,
      category = v_template.category, status = v_template.status,
      header_type = v_template.header_type, header_content = v_template.header_content,
      header_handle = v_template.header_handle, body_text = v_template.body_text,
      footer_text = v_template.footer_text, buttons = v_template.buttons,
      sample_values = v_template.sample_values, quality_score = v_template.quality_score,
      meta_template_id = v_template.meta_template_id, meta_components = v_template.meta_components,
      updated_at = now() WHERE id = v_id AND account_id = v_account;
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;

  INSERT INTO public.message_templates (account_id, user_id, whatsapp_config_id, waba_id,
    name, language, category, status, header_type, header_content, header_handle,
    body_text, footer_text, buttons, sample_values, quality_score, meta_template_id, meta_components)
  VALUES (v_account, v_user, p_config_id, v_waba, v_template.name, v_template.language,
    v_template.category, v_template.status, v_template.header_type, v_template.header_content,
    v_template.header_handle, v_template.body_text, v_template.footer_text, v_template.buttons,
    v_template.sample_values, v_template.quality_score, v_template.meta_template_id, v_template.meta_components)
  ON CONFLICT (account_id, waba_id, name, language) DO UPDATE SET
    whatsapp_config_id = excluded.whatsapp_config_id, waba_id = excluded.waba_id,
    category = excluded.category, status = excluded.status, header_type = excluded.header_type,
    header_content = excluded.header_content, header_handle = excluded.header_handle,
    body_text = excluded.body_text, footer_text = excluded.footer_text, buttons = excluded.buttons,
    sample_values = excluded.sample_values, quality_score = excluded.quality_score,
    meta_template_id = excluded.meta_template_id, meta_components = excluded.meta_components, updated_at = now()
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Template could not be saved'; END IF;
  RETURN QUERY SELECT v_id, true;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_waba_template(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_waba_template(uuid, jsonb) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
