-- Read-only production inventory. No contact, message or token values are returned.
SELECT jsonb_build_object(
  'columns', COALESCE((
    SELECT jsonb_object_agg(table_name, names ORDER BY table_name)
    FROM (
      SELECT table_name, jsonb_agg(column_name ORDER BY ordinal_position) AS names
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN
        ('whatsapp_config','broadcasts','broadcast_recipients','messages','conversations','contacts','message_templates')
      GROUP BY table_name
    ) c
  ), '{}'::jsonb),
  'functions', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'name', p.proname, 'arguments', pg_get_function_identity_arguments(p.oid),
      'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'service_role_execute', has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) ORDER BY p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN
      ('get_inbox_awaiting_reply','create_broadcast_with_contacts','claim_broadcast_recipient','create_broadcast_idempotent')
  ), '[]'::jsonb),
  'indexes', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('table', tablename, 'name', indexname, 'definition', indexdef) ORDER BY indexname)
    FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('broadcasts','broadcast_recipients','contacts','messages','message_templates')
  ), '[]'::jsonb),
  'policies', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('table', tablename, 'name', policyname, 'command', cmd,
      'roles', roles, 'using', qual, 'check', with_check) ORDER BY tablename, policyname)
    FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('broadcasts','broadcast_recipients')
  ), '[]'::jsonb),
  'constraints', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('table', c.relname, 'name', con.conname,
      'definition', pg_get_constraintdef(con.oid)) ORDER BY c.relname, con.conname)
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('broadcasts','broadcast_recipients')
  ), '[]'::jsonb)
) AS broadcast_schema;
