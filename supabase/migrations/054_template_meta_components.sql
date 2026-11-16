-- Preserve the original Meta components, including component types the
-- current editor does not yet render. Templates are shared by WABA.
ALTER TABLE public.message_templates ADD COLUMN IF NOT EXISTS meta_components jsonb;
NOTIFY pgrst, 'reload schema';
