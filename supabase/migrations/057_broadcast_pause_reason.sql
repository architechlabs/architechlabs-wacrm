-- Keep existing pauses unchanged; new pauses can record a reason.
ALTER TABLE public.broadcasts ADD COLUMN IF NOT EXISTS delivery_pause_reason text;
NOTIFY pgrst, 'reload schema';
