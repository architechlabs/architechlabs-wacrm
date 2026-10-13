-- SUPERSEDED: historical diagnostic for the abandoned separate-outbox design.
-- Use verify-inbox-document-schema-read-only.sql for the current implementation.
-- A missing outbox is expected; do NOT apply migration 045 to fix these results.
-- Run only in the intended Supabase project's SQL editor as a database admin.
-- Diagnostic only: no row contents, customer data or credentials are returned.
-- Does not apply migration 045. A missing table yields failed checks, not DDL.
BEGIN TRANSACTION READ ONLY;

WITH target AS (
  SELECT c.oid, c.relrowsecurity
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'admin_document_deliveries'
    AND c.relkind = 'r'
), checks AS (
  SELECT 'outbox_table_exists' AS check_name, EXISTS (SELECT 1 FROM target) AS passed
  UNION ALL
  SELECT 'row_level_security_enabled', COALESCE((SELECT relrowsecurity FROM target), false)
  UNION ALL
  SELECT 'unique_account_delivery_key', EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint k
    WHERE k.conrelid = (SELECT oid FROM target) AND k.contype = 'u'
      AND ARRAY(
        SELECT a.attname::text
        FROM unnest(k.conkey) WITH ORDINALITY AS cols(attnum, position)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = cols.attnum
        ORDER BY cols.position
      ) = ARRAY['account_id', 'delivery_key']
  )
  UNION ALL
  SELECT 'no_anon_table_privileges', COALESCE((
    SELECT NOT has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') FROM target
  ), false)
  UNION ALL
  SELECT 'no_authenticated_table_privileges', COALESCE((
    SELECT NOT has_table_privilege('authenticated', oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') FROM target
  ), false)
  UNION ALL
  SELECT 'service_role_select_insert_update', COALESCE((
    SELECT has_table_privilege('service_role', oid, 'SELECT')
       AND has_table_privilege('service_role', oid, 'INSERT')
       AND has_table_privilege('service_role', oid, 'UPDATE') FROM target
  ), false)
)
SELECT check_name, passed FROM checks ORDER BY check_name;

ROLLBACK;
