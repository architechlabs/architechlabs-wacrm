-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
DECLARE
  missing_columns text;
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- Phase 2B Inbox pagination contracts (043). Keep this structural; the
  -- behavioral/security matrix lives in test-inbox-pagination.sql.
  IF to_regprocedure(
    'public.get_inbox_conversations_page(uuid,integer,timestamptz,uuid,text,text,uuid[],text,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'get_inbox_conversations_page is missing — migration 043 did not apply';
  END IF;
  IF to_regprocedure('public.get_inbox_company_options(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'get_inbox_company_options is missing — migration 043 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid IN (
      to_regprocedure(
        'public.get_inbox_conversations_page(uuid,integer,timestamptz,uuid,text,text,uuid[],text,uuid)'
      ),
      to_regprocedure('public.get_inbox_company_options(uuid,uuid)')
    )
      AND prosecdef
  ) THEN
    RAISE EXCEPTION 'Inbox pagination functions must remain SECURITY INVOKER';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.get_inbox_conversations_page(uuid,integer,timestamptz,uuid,text,text,uuid[],text,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.get_inbox_company_options(uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon must not execute Inbox pagination functions';
  END IF;

  IF NOT has_function_privilege(
    'authenticated',
    'public.get_inbox_conversations_page(uuid,integer,timestamptz,uuid,text,text,uuid[],text,uuid)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'authenticated',
    'public.get_inbox_company_options(uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must be able to execute Inbox pagination functions';
  END IF;

  -- Broadcast creation, delivery and inbox persistence depend on these
  -- columns, including when only application code changes in a PR.
  SELECT string_agg(required.table_name || '.' || required.column_name, ', ' ORDER BY required.table_name, required.column_name)
  INTO missing_columns
  FROM (VALUES
    ('broadcasts','account_id'), ('broadcasts','user_id'), ('broadcasts','name'),
    ('broadcasts','template_name'), ('broadcasts','template_language'),
    ('broadcasts','template_variables'), ('broadcasts','audience_filter'),
    ('broadcasts','whatsapp_config_id'), ('broadcasts','idempotency_key'),
    ('broadcasts','delivery_paused_at'), ('broadcasts','status'), ('broadcasts','total_recipients'),
    ('broadcasts','sent_count'), ('broadcasts','delivered_count'), ('broadcasts','read_count'),
    ('broadcasts','replied_count'), ('broadcasts','failed_count'), ('broadcasts','updated_at'),
    ('broadcast_recipients','broadcast_id'), ('broadcast_recipients','contact_id'),
    ('broadcast_recipients','phone_e164'), ('broadcast_recipients','template_params'),
    ('broadcast_recipients','status'), ('broadcast_recipients','send_started_at'),
    ('broadcast_recipients','delivery_outcome'), ('broadcast_recipients','whatsapp_message_id'),
    ('broadcast_recipients','error_message'), ('broadcast_recipients','error_code'),
    ('broadcast_recipients','sent_at'),
    ('messages','conversation_id'), ('messages','sender_type'), ('messages','content_type'),
    ('messages','content_text'), ('messages','template_name'), ('messages','status'),
    ('messages','broadcast_id'), ('messages','message_id'), ('messages','failure_code'),
    ('messages','failure_reason'), ('messages','created_at'),
    ('conversations','account_id'), ('conversations','contact_id'),
    ('conversations','whatsapp_config_id'), ('conversations','last_message_text'),
    ('conversations','last_message_at'), ('conversations','updated_at'),
    ('contacts','account_id'), ('contacts','user_id'), ('contacts','whatsapp_config_id'),
    ('contacts','phone'), ('contacts','phone_normalized'), ('contacts','name'),
    ('message_templates','account_id'), ('message_templates','waba_id'),
    ('message_templates','whatsapp_config_id'), ('message_templates','name'),
    ('message_templates','language'), ('message_templates','status'),
    ('message_templates','meta_template_id'), ('message_templates','meta_components')
  ) AS required(table_name, column_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = required.table_name
      AND c.column_name = required.column_name
  );
  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Broadcast schema is missing columns: %', missing_columns;
  END IF;

  IF to_regprocedure('public.get_inbox_awaiting_reply(uuid)') IS NULL
     OR NOT has_function_privilege('authenticated', 'public.get_inbox_awaiting_reply(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated Inbox awaiting-reply RPC is missing';
  END IF;
  IF to_regprocedure('public.create_broadcast_with_contacts(uuid,uuid,text,text,text,jsonb,uuid,text)') IS NULL
     OR NOT has_function_privilege('service_role', 'public.create_broadcast_with_contacts(uuid,uuid,text,text,text,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Broadcast contact creation RPC is missing';
  END IF;
  IF to_regprocedure('public.claim_broadcast_recipient(uuid,uuid,uuid)') IS NULL
     OR NOT has_function_privilege('service_role', 'public.claim_broadcast_recipient(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Broadcast recipient claim RPC is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.idx_broadcast_account_idempotency')
      AND i.indisunique AND i.indisvalid AND i.indisready
  ) THEN
    RAISE EXCEPTION 'Broadcast idempotency index is missing or invalid';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
