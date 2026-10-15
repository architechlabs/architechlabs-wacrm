-- Intended Supabase project only. Catalog diagnostics, no customer rows/secrets.
-- Does not apply any migration. Missing schema yields false, not DDL.
-- These checks are prerequisites, NOT a full security audit or activation approval.
BEGIN TRANSACTION READ ONLY;
WITH target AS (
  SELECT c.oid,c.relrowsecurity FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='messages' AND c.relkind='r'
), checks AS (
  SELECT 'messages_table_exists' AS check_name, EXISTS(SELECT 1 FROM target) AS passed
  UNION ALL
  SELECT 'existing_message_rls_enabled', COALESCE((SELECT relrowsecurity FROM target),false)
  UNION ALL
  SELECT 'no_application_truncate_privilege', COALESCE((
    SELECT NOT has_table_privilege('anon',oid,'TRUNCATE')
      AND NOT has_table_privilege('authenticated',oid,'TRUNCATE')
      AND NOT has_table_privilege('service_role',oid,'TRUNCATE') FROM target
  ),false)
  UNION ALL
  SELECT 'document_columns_present', (
    SELECT count(*)=7 FROM pg_catalog.pg_attribute a WHERE a.attrelid=(SELECT oid FROM target) AND NOT a.attisdropped
      AND (a.attname,a.atttypid::regtype::text) IN (
        ('admin_document_account_id','uuid'),('admin_document_key','text'),('admin_document_fingerprint','text'),
        ('admin_document_metadata','jsonb'),('admin_document_state','text'),('admin_document_media_id','text'),
        ('admin_document_claim_id','uuid'))
  )
  UNION ALL
  SELECT 'document_shape_constraint_present', EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=(SELECT oid FROM target)
      AND conname='messages_admin_document_shape' AND contype='c'
  )
  UNION ALL
  SELECT 'document_shape_constraint_validated', EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=(SELECT oid FROM target)
      AND conname='messages_admin_document_shape' AND contype='c' AND convalidated
  )
  UNION ALL
  SELECT 'account_document_unique_index_ready', EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid
    WHERE i.indrelid=(SELECT oid FROM target) AND x.relname='idx_messages_admin_document_key'
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND pg_catalog.pg_get_expr(i.indpred,i.indrelid)='(admin_document_key IS NOT NULL)'
      AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,pos)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.pos)
        = ARRAY['admin_document_account_id','admin_document_key']
  )
  UNION ALL
  SELECT 'message_guard_enabled_invoker', EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE t.tgrelid=(SELECT oid FROM target) AND t.tgname='protect_admin_document_message'
      AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=31
      AND n.nspname='public' AND p.proname='protect_admin_document_message' AND NOT p.prosecdef
  )
  UNION ALL
  SELECT 'conversation_guard_enabled_invoker', EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='conversations' AND t.tgname='protect_admin_document_conversation'
      AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=19
      AND p.proname='protect_admin_document_conversation' AND NOT p.prosecdef
  )
  UNION ALL
  SELECT 'service_role_select_insert_update', COALESCE((
    SELECT has_table_privilege('service_role',oid,'SELECT') AND has_table_privilege('service_role',oid,'INSERT')
      AND has_table_privilege('service_role',oid,'UPDATE') FROM target
  ),false)
)
SELECT check_name,passed FROM checks ORDER BY check_name;
ROLLBACK;
