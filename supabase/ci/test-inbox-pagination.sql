\set ON_ERROR_STOP on

-- Behavioral and tenant-isolation contract for migration 043.
-- Everything runs in one transaction and is rolled back, so the test leaves
-- the local database exactly as it found it.
BEGIN;

CREATE FUNCTION pg_temp.assert_true(condition BOOLEAN, message TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF condition IS NOT TRUE THEN
    RAISE EXCEPTION 'Inbox pagination assertion failed: %', message;
  END IF;
END;
$$;

-- The linked production schema grants authenticated SELECT on these tables.
-- Fresh local migrations run as postgres, whose local default ACL omits that
-- grant. Mirror production inside this rollback-only transaction so the
-- SECURITY INVOKER tests exercise RLS rather than failing at the table ACL.
GRANT SELECT ON TABLE
  public.conversations,
  public.contacts,
  public.contact_tags,
  public.tags
TO authenticated;

-- Two authenticated users produce two independent accounts via the normal
-- signup trigger. Their fixed UUIDs make cursor and tenant assertions clear.
INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'authenticated',
    'authenticated',
    'phase2b-a@example.invalid',
    'local-test-only',
    NOW(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Phase 2B Account A"}',
    NOW(),
    NOW()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'bbbbbbbb-0000-0000-0000-000000000001',
    'authenticated',
    'authenticated',
    'phase2b-b@example.invalid',
    'local-test-only',
    NOW(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Phase 2B Account B"}',
    NOW(),
    NOW()
  );

SELECT pg_temp.assert_true(
  (SELECT COUNT(*) FROM public.profiles
   WHERE user_id IN (
     'aaaaaaaa-0000-0000-0000-000000000001',
     'bbbbbbbb-0000-0000-0000-000000000001'
   )) = 2,
  'signup fixtures must create both profiles'
);

SELECT set_config(
  'phase2b.account_a',
  (SELECT account_id::TEXT FROM public.profiles
   WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  true
);
SELECT set_config(
  'phase2b.account_b',
  (SELECT account_id::TEXT FROM public.profiles
   WHERE user_id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  true
);

INSERT INTO public.tags (id, user_id, account_id, name, color)
SELECT fixture.id,
       'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
       current_setting('phase2b.account_a')::UUID,
       fixture.name,
       fixture.color
FROM (VALUES
  ('40000000-0000-0000-0000-000000000001'::UUID, 'Red', '#ff0000'),
  ('40000000-0000-0000-0000-000000000002'::UUID, 'Blue', '#0000ff'),
  ('40000000-0000-0000-0000-000000000003'::UUID, 'Green', '#00ff00')
) AS fixture(id, name, color);

INSERT INTO public.contacts (
  id,
  user_id,
  account_id,
  phone,
  name,
  email,
  company,
  avatar_url
)
SELECT fixture.id,
       'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
       current_setting('phase2b.account_a')::UUID,
       fixture.phone,
       fixture.name,
       fixture.email,
       fixture.company,
       fixture.avatar_url
FROM (VALUES
  ('10000000-0000-0000-0000-000000000001'::UUID, '+15550001', 'Alice', 'alice@example.invalid', ' Acme ', 'https://example.invalid/alice.png'),
  ('10000000-0000-0000-0000-000000000002'::UUID, '+15550002', 'Percent%Person', NULL, 'Beta', NULL),
  ('10000000-0000-0000-0000-000000000003'::UUID, '+15550003', 'Under_score', NULL, '   ', NULL),
  ('10000000-0000-0000-0000-000000000004'::UUID, '+15550004', 'Preview Person', NULL, NULL, NULL),
  ('10000000-0000-0000-0000-000000000005'::UUID, '+15550005', 'MixedCase', NULL, 'Acme', NULL),
  ('10000000-0000-0000-0000-000000000006'::UUID, '+15550006', 'Null One', NULL, 'Gamma', NULL),
  ('10000000-0000-0000-0000-000000000007'::UUID, '+15550007', 'Null Two', NULL, 'Gamma', NULL),
  ('10000000-0000-0000-0000-000000000008'::UUID, '+15550008', 'Null Three', NULL, 'Delta', NULL)
) AS fixture(id, phone, name, email, company, avatar_url);

INSERT INTO public.conversations (
  id,
  user_id,
  account_id,
  contact_id,
  status,
  assigned_agent_id,
  last_message_text,
  last_message_at,
  unread_count,
  ai_autoreply_disabled,
  ai_handoff_summary
)
SELECT fixture.id,
       'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
       current_setting('phase2b.account_a')::UUID,
       fixture.contact_id,
       fixture.status,
       fixture.assigned_agent_id,
       fixture.last_message_text,
       fixture.last_message_at,
       fixture.unread_count,
       fixture.ai_autoreply_disabled,
       fixture.ai_handoff_summary
FROM (VALUES
  ('20000000-0000-0000-0000-000000000008'::UUID, '10000000-0000-0000-0000-000000000001'::UUID, 'open',    'aaaaaaaa-0000-0000-0000-000000000001'::UUID, 'Latest hello',    '2026-01-04 12:00:00+00'::TIMESTAMPTZ, 2, true,  'Human handoff'),
  ('20000000-0000-0000-0000-000000000007'::UUID, '10000000-0000-0000-0000-000000000002'::UUID, 'pending', NULL::UUID, 'Percent message', '2026-01-04 12:00:00+00'::TIMESTAMPTZ, 0, false, NULL),
  ('20000000-0000-0000-0000-000000000006'::UUID, '10000000-0000-0000-0000-000000000003'::UUID, 'closed',  NULL::UUID, 'Underscore message', '2026-01-03 12:00:00+00'::TIMESTAMPTZ, 0, false, NULL),
  ('20000000-0000-0000-0000-000000000005'::UUID, '10000000-0000-0000-0000-000000000004'::UUID, 'open',    NULL::UUID, 'Needle Preview',  '2026-01-02 12:00:00+00'::TIMESTAMPTZ, 1, false, NULL),
  ('20000000-0000-0000-0000-000000000004'::UUID, '10000000-0000-0000-0000-000000000005'::UUID, 'pending', NULL::UUID, 'Mixed case message', '2026-01-01 12:00:00+00'::TIMESTAMPTZ, 0, false, NULL),
  ('20000000-0000-0000-0000-000000000003'::UUID, '10000000-0000-0000-0000-000000000008'::UUID, 'closed',  NULL::UUID, NULL, NULL::TIMESTAMPTZ, 0, false, NULL),
  ('20000000-0000-0000-0000-000000000002'::UUID, '10000000-0000-0000-0000-000000000007'::UUID, 'open',    NULL::UUID, NULL, NULL::TIMESTAMPTZ, 0, false, NULL),
  ('20000000-0000-0000-0000-000000000001'::UUID, '10000000-0000-0000-0000-000000000006'::UUID, 'pending', NULL::UUID, NULL, NULL::TIMESTAMPTZ, 0, false, NULL)
) AS fixture(
  id,
  contact_id,
  status,
  assigned_agent_id,
  last_message_text,
  last_message_at,
  unread_count,
  ai_autoreply_disabled,
  ai_handoff_summary
);

INSERT INTO public.contact_tags (id, contact_id, tag_id)
VALUES
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002'),
  ('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003');

-- A single foreign-account conversation is enough to prove RLS, explicit
-- account scoping, company-option isolation, and hostile cursor handling.
INSERT INTO public.contacts (
  id, user_id, account_id, phone, name, company
)
VALUES (
  '30000000-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  current_setting('phase2b.account_b')::UUID,
  '+16660001',
  'Foreign Account Contact',
  'ForeignCo'
);

INSERT INTO public.conversations (
  id, user_id, account_id, contact_id, status, last_message_text,
  last_message_at, unread_count
)
VALUES (
  '30000000-0000-0000-0000-000000000002',
  'bbbbbbbb-0000-0000-0000-000000000001',
  current_setting('phase2b.account_b')::UUID,
  '30000000-0000-0000-0000-000000000001',
  'open',
  'Foreign message',
  '2030-01-01 00:00:00+00',
  1
);


-- Account A: pagination, filtering, nested payload, and tenant isolation.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-0000-0000-0000-000000000001',
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
  account_a UUID := current_setting('phase2b.account_a')::UUID;
  account_b UUID := current_setting('phase2b.account_b')::UUID;
  page_one JSONB;
  page_two JSONB;
  page_three JSONB;
  filtered JSONB;
  ids_one TEXT[];
  ids_two TEXT[];
  ids_three TEXT[];
  all_ids TEXT[];
  companies TEXT[];
  object_keys TEXT[];
  contact_keys TEXT[];
  tag_keys TEXT[];
  distinct_count INTEGER;
  rejected BOOLEAN;
BEGIN
  page_one := public.get_inbox_conversations_page(account_a, 3);
  PERFORM pg_temp.assert_true(
    jsonb_array_length(page_one->'items') = 3,
    'first page must retain exactly page_size rows'
  );
  PERFORM pg_temp.assert_true(
    (page_one->>'has_more')::BOOLEAN,
    'page_size + 1 lookahead must set has_more'
  );

  SELECT array_agg(item->>'id' ORDER BY ordinal)
  INTO ids_one
  FROM jsonb_array_elements(page_one->'items') WITH ORDINALITY AS rows(item, ordinal);

  PERFORM pg_temp.assert_true(
    ids_one = ARRAY[
      '20000000-0000-0000-0000-000000000008',
      '20000000-0000-0000-0000-000000000007',
      '20000000-0000-0000-0000-000000000006'
    ],
    'duplicate timestamps must use id DESC as the tie-breaker'
  );
  PERFORM pg_temp.assert_true(
    page_one->'next_cursor'->>'id' = '20000000-0000-0000-0000-000000000006',
    'next_cursor must come from the last retained row, not lookahead'
  );

  page_two := public.get_inbox_conversations_page(
    account_a,
    3,
    (page_one->'next_cursor'->>'last_message_at')::TIMESTAMPTZ,
    (page_one->'next_cursor'->>'id')::UUID
  );
  SELECT array_agg(item->>'id' ORDER BY ordinal)
  INTO ids_two
  FROM jsonb_array_elements(page_two->'items') WITH ORDINALITY AS rows(item, ordinal);

  PERFORM pg_temp.assert_true(
    ids_two = ARRAY[
      '20000000-0000-0000-0000-000000000005',
      '20000000-0000-0000-0000-000000000004',
      '20000000-0000-0000-0000-000000000003'
    ],
    'second page must transition from non-NULL timestamps into NULL rows'
  );
  PERFORM pg_temp.assert_true(
    page_two->'next_cursor'->'last_message_at' = 'null'::JSONB,
    'transition page cursor must preserve a NULL timestamp'
  );

  page_three := public.get_inbox_conversations_page(
    account_a,
    3,
    NULL,
    (page_two->'next_cursor'->>'id')::UUID
  );
  SELECT array_agg(item->>'id' ORDER BY ordinal)
  INTO ids_three
  FROM jsonb_array_elements(page_three->'items') WITH ORDINALITY AS rows(item, ordinal);

  PERFORM pg_temp.assert_true(
    ids_three = ARRAY[
      '20000000-0000-0000-0000-000000000002',
      '20000000-0000-0000-0000-000000000001'
    ],
    'NULL cursor branch must continue through multiple NULL rows by id DESC'
  );
  PERFORM pg_temp.assert_true(
    NOT (page_three->>'has_more')::BOOLEAN
    AND page_three->'next_cursor' = 'null'::JSONB,
    'final all-NULL page must have has_more false and no cursor'
  );

  all_ids := ids_one || ids_two || ids_three;
  SELECT COUNT(DISTINCT id) INTO distinct_count FROM unnest(all_ids) AS ids(id);
  PERFORM pg_temp.assert_true(
    array_length(all_ids, 1) = 8 AND distinct_count = 8,
    'three pages must have no skipped or duplicate conversations'
  );

  -- Explicit response shape: no conversation.*, contact.*, or tag.* leakage.
  SELECT array_agg(key ORDER BY key)
  INTO object_keys
  FROM jsonb_object_keys(page_one->'items'->0) AS keys(key);
  PERFORM pg_temp.assert_true(
    object_keys = ARRAY[
      'ai_autoreply_disabled',
      'ai_handoff_summary',
      'assigned_agent_id',
      'contact',
      'id',
      'last_message_at',
      'last_message_text',
      'status',
      'unread_count'
    ],
    'conversation payload must contain only audited fields'
  );

  SELECT array_agg(key ORDER BY key)
  INTO contact_keys
  FROM jsonb_object_keys(page_one->'items'->0->'contact') AS keys(key);
  PERFORM pg_temp.assert_true(
    contact_keys = ARRAY[
      'avatar_url', 'company', 'email', 'id', 'name', 'phone', 'tags'
    ],
    'contact payload must contain only audited fields'
  );

  SELECT array_agg(key ORDER BY key)
  INTO tag_keys
  FROM jsonb_object_keys(page_one->'items'->0->'contact'->'tags'->0) AS keys(key);
  PERFORM pg_temp.assert_true(
    tag_keys = ARRAY['color', 'id', 'name'],
    'tag payload must contain only audited fields'
  );

  -- Search uses the raw nonblank string and literal substring semantics.
  filtered := public.get_inbox_conversations_page(account_a, p_search => 'Alice');
  PERFORM pg_temp.assert_true(jsonb_array_length(filtered->'items') = 1, 'search by name');

  filtered := public.get_inbox_conversations_page(account_a, p_search => '50001');
  PERFORM pg_temp.assert_true(jsonb_array_length(filtered->'items') = 1, 'search by phone');

  filtered := public.get_inbox_conversations_page(account_a, p_search => 'Needle');
  PERFORM pg_temp.assert_true(jsonb_array_length(filtered->'items') = 1, 'search by preview');

  filtered := public.get_inbox_conversations_page(account_a, p_search => 'aLiCe');
  PERFORM pg_temp.assert_true(jsonb_array_length(filtered->'items') = 1, 'case-insensitive search');

  filtered := public.get_inbox_conversations_page(account_a, p_search => '%');
  PERFORM pg_temp.assert_true(
    jsonb_array_length(filtered->'items') = 1
    AND filtered->'items'->0->'contact'->>'name' = 'Percent%Person',
    'percent must be a literal character, not a wildcard'
  );

  filtered := public.get_inbox_conversations_page(account_a, p_search => '_');
  PERFORM pg_temp.assert_true(
    jsonb_array_length(filtered->'items') = 1
    AND filtered->'items'->0->'contact'->>'name' = 'Under_score',
    'underscore must be a literal character, not a wildcard'
  );

  filtered := public.get_inbox_conversations_page(account_a, p_search => ' Alice ');
  PERFORM pg_temp.assert_true(
    jsonb_array_length(filtered->'items') = 0,
    'leading/trailing spaces must remain part of a nonblank search string'
  );

  filtered := public.get_inbox_conversations_page(account_a, p_search => '');
  PERFORM pg_temp.assert_true(jsonb_array_length(filtered->'items') = 8, 'empty search is inactive');

  filtered := public.get_inbox_conversations_page(account_a, p_search => '   ');
  PERFORM pg_temp.assert_true(jsonb_array_length(filtered->'items') = 8, 'spaces-only search is inactive');

  filtered := public.get_inbox_conversations_page(account_a, p_filter => 'unread');
  PERFORM pg_temp.assert_true(jsonb_array_length(filtered->'items') = 2, 'unread means unread_count > 0');

  filtered := public.get_inbox_conversations_page(account_a, p_filter => 'open');
  PERFORM pg_temp.assert_true(jsonb_array_length(filtered->'items') = 3, 'open status filter');

  filtered := public.get_inbox_conversations_page(account_a, p_filter => 'pending');
  PERFORM pg_temp.assert_true(jsonb_array_length(filtered->'items') = 3, 'pending status filter');

  filtered := public.get_inbox_conversations_page(account_a, p_filter => 'closed');
  PERFORM pg_temp.assert_true(jsonb_array_length(filtered->'items') = 2, 'closed status filter');

  filtered := public.get_inbox_conversations_page(
    account_a,
    p_tag_ids => ARRAY[
      '40000000-0000-0000-0000-000000000001'::UUID,
      '40000000-0000-0000-0000-000000000003'::UUID
    ]
  );
  PERFORM pg_temp.assert_true(
    jsonb_array_length(filtered->'items') = 2,
    'selected tags must use ANY/OR semantics'
  );
  PERFORM pg_temp.assert_true(
    jsonb_array_length(filtered->'items'->0->'contact'->'tags') = 2
    AND filtered->'items'->0->'contact'->'tags'->0->>'name' = 'Blue'
    AND filtered->'items'->0->'contact'->'tags'->1->>'name' = 'Red',
    'matching by one tag must still return the complete deterministic tag list'
  );

  filtered := public.get_inbox_conversations_page(account_a, p_company => 'Acme');
  PERFORM pg_temp.assert_true(
    jsonb_array_length(filtered->'items') = 2,
    'company filter must compare the trimmed stored value exactly'
  );

  SELECT array_agg(company ORDER BY company COLLATE "C")
  INTO companies
  FROM public.get_inbox_company_options(account_a);
  PERFORM pg_temp.assert_true(
    companies = ARRAY['Acme', 'Beta', 'Delta', 'Gamma'],
    'company options must be account-wide, distinct, trimmed, ordered, and nonblank'
  );

  SELECT COUNT(*) INTO distinct_count
  FROM public.conversations
  WHERE account_id = account_b;
  PERFORM pg_temp.assert_true(
    distinct_count = 0,
    'RLS must hide foreign-account conversations from an authenticated member'
  );

  rejected := false;
  BEGIN
    PERFORM public.get_inbox_conversations_page(account_b);
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'non-member account RPC must be rejected');

  filtered := public.get_inbox_conversations_page(
    account_a,
    40,
    '2030-01-01 00:00:00+00',
    '30000000-0000-0000-0000-000000000002'
  );
  PERFORM pg_temp.assert_true(
    NOT jsonb_path_exists(
      filtered,
      '$.items[*] ? (@.id == "30000000-0000-0000-0000-000000000002")'
    ),
    'a foreign cursor value must never cross the explicit account boundary'
  );
END;
$$;

RESET ROLE;


-- Account B is independently readable by its own authenticated member.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  'bbbbbbbb-0000-0000-0000-000000000001',
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
  account_b UUID := current_setting('phase2b.account_b')::UUID;
  result JSONB;
BEGIN
  result := public.get_inbox_conversations_page(account_b);
  PERFORM pg_temp.assert_true(
    jsonb_array_length(result->'items') = 1
    AND result->'items'->0->>'id' = '30000000-0000-0000-0000-000000000002',
    'normal authenticated account member must succeed'
  );
END;
$$;

RESET ROLE;


-- ACL, not a service credential or RLS bypass, rejects anonymous execution.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', 'anon', true);

DO $$
DECLARE
  rejected BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM public.get_inbox_conversations_page(
      current_setting('phase2b.account_a')::UUID
    );
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'anonymous execution must be rejected');
END;
$$;

RESET ROLE;


-- A filtered 105-row fixture proves default, invalid, and maximum page-size
-- behavior without disturbing the precise cursor fixtures above.
INSERT INTO public.contacts (id, user_id, account_id, phone, name)
SELECT md5('phase2b-clamp-contact-' || fixture_number)::UUID,
       'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
       current_setting('phase2b.account_a')::UUID,
       '+1999' || lpad(fixture_number::TEXT, 6, '0'),
       'ClampFixture ' || fixture_number
FROM generate_series(1, 105) AS fixture(fixture_number);

INSERT INTO public.conversations (
  id,
  user_id,
  account_id,
  contact_id,
  status,
  last_message_text,
  last_message_at,
  unread_count
)
SELECT md5('phase2b-clamp-conversation-' || fixture_number)::UUID,
       'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
       current_setting('phase2b.account_a')::UUID,
       md5('phase2b-clamp-contact-' || fixture_number)::UUID,
       'open',
       'Clamp page-size fixture',
       '2025-01-01 00:00:00+00'::TIMESTAMPTZ + fixture_number * INTERVAL '1 second',
       0
FROM generate_series(1, 105) AS fixture(fixture_number);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-0000-0000-0000-000000000001',
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
  account_a UUID := current_setting('phase2b.account_a')::UUID;
  result JSONB;
  rejected BOOLEAN;
BEGIN
  result := public.get_inbox_conversations_page(
    account_a,
    p_search => 'ClampFixture'
  );
  PERFORM pg_temp.assert_true(
    jsonb_array_length(result->'items') = 40
    AND (result->>'has_more')::BOOLEAN,
    'omitted page size must default to 40 with lookahead'
  );

  result := public.get_inbox_conversations_page(
    account_a,
    1000,
    p_search => 'ClampFixture'
  );
  PERFORM pg_temp.assert_true(
    jsonb_array_length(result->'items') = 100
    AND (result->>'has_more')::BOOLEAN,
    'positive page size must be capped at 100'
  );

  result := public.get_inbox_conversations_page(
    account_a,
    0,
    p_search => 'ClampFixture'
  );
  PERFORM pg_temp.assert_true(
    jsonb_array_length(result->'items') = 40,
    'zero page size must safely fall back to 40'
  );

  result := public.get_inbox_conversations_page(
    account_a,
    -5,
    p_search => 'ClampFixture'
  );
  PERFORM pg_temp.assert_true(
    jsonb_array_length(result->'items') = 40,
    'negative page size must safely fall back to 40'
  );

  rejected := false;
  BEGIN
    PERFORM public.get_inbox_conversations_page(
      account_a,
      p_cursor_last_message_at => NOW()
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(
    rejected,
    'timestamp cursor without cursor_id must be rejected'
  );

  rejected := false;
  BEGIN
    PERFORM public.get_inbox_conversations_page(
      account_a,
      p_filter => 'not-a-real-filter'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'unsupported filter must be rejected');
END;
$$;

RESET ROLE;
ROLLBACK;
