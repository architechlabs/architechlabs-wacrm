-- Whole-Inbox conversation pagination and filtering.
--
-- Both functions are SECURITY INVOKER: the authenticated caller's existing
-- RLS policies remain the primary tenant boundary. The explicit account
-- predicate and membership check are additional planner guidance and defense
-- in depth; neither function can be executed by anon.

CREATE OR REPLACE FUNCTION public.get_inbox_conversations_page(
  p_account_id UUID,
  p_page_size INTEGER DEFAULT 40,
  p_cursor_last_message_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id UUID DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_filter TEXT DEFAULT 'all',
  p_tag_ids UUID[] DEFAULT '{}',
  p_company TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_page_size INTEGER;
  v_filter TEXT := COALESCE(p_filter, 'all');
  v_response JSONB;
BEGIN
  IF auth.uid() IS NULL
     OR p_account_id IS NULL
     OR NOT public.is_account_member(p_account_id)
  THEN
    RAISE EXCEPTION 'Not authorized for this account'
      USING ERRCODE = '42501';
  END IF;

  IF v_filter NOT IN ('all', 'unread', 'open', 'pending', 'closed') THEN
    RAISE EXCEPTION 'Invalid Inbox filter: %', v_filter
      USING ERRCODE = '22023';
  END IF;

  -- A timestamp without its UUID tie-breaker is not a usable keyset cursor.
  -- A UUID with a NULL timestamp is valid: it addresses the NULLS LAST tail.
  IF p_cursor_id IS NULL AND p_cursor_last_message_at IS NOT NULL THEN
    RAISE EXCEPTION 'cursor_id is required when cursor timestamp is present'
      USING ERRCODE = '22023';
  END IF;

  -- Omitted/NULL/non-positive sizes use the product default. Positive sizes
  -- are capped so a caller cannot turn the RPC into an unbounded list query.
  v_page_size := CASE
    WHEN p_page_size IS NULL OR p_page_size <= 0 THEN 40
    ELSE LEAST(p_page_size, 100)
  END;

  WITH page_plus_one AS MATERIALIZED (
    SELECT
      c.id,
      c.status,
      c.assigned_agent_id,
      c.last_message_text,
      c.last_message_at,
      c.unread_count,
      c.ai_autoreply_disabled,
      c.ai_handoff_summary,
      contact.id AS contact_id,
      contact.phone AS contact_phone,
      contact.name AS contact_name,
      contact.email AS contact_email,
      contact.company AS contact_company,
      contact.avatar_url AS contact_avatar_url
    FROM public.conversations AS c
    JOIN public.contacts AS contact
      ON contact.id = c.contact_id
     AND contact.account_id = p_account_id
    WHERE c.account_id = p_account_id
      AND public.is_account_member(p_account_id)
      AND (
        v_filter = 'all'
        OR (v_filter = 'unread' AND c.unread_count > 0)
        OR (v_filter IN ('open', 'pending', 'closed') AND c.status = v_filter)
      )
      AND (
        p_search IS NULL
        OR p_search !~ '[^[:space:]]'
        OR STRPOS(LOWER(COALESCE(contact.name, '')), LOWER(p_search)) > 0
        OR STRPOS(LOWER(contact.phone), LOWER(p_search)) > 0
        OR STRPOS(LOWER(COALESCE(c.last_message_text, '')), LOWER(p_search)) > 0
      )
      AND (
        COALESCE(CARDINALITY(p_tag_ids), 0) = 0
        OR EXISTS (
          SELECT 1
          FROM public.contact_tags AS selected_contact_tag
          WHERE selected_contact_tag.contact_id = contact.id
            AND selected_contact_tag.tag_id = ANY(p_tag_ids)
        )
      )
      AND (
        p_company IS NULL
        OR BTRIM(contact.company) = p_company
      )
      AND (
        p_cursor_id IS NULL
        OR (
          p_cursor_last_message_at IS NOT NULL
          AND (
            c.last_message_at < p_cursor_last_message_at
            OR (
              c.last_message_at = p_cursor_last_message_at
              AND c.id < p_cursor_id
            )
            OR c.last_message_at IS NULL
          )
        )
        OR (
          p_cursor_last_message_at IS NULL
          AND c.last_message_at IS NULL
          AND c.id < p_cursor_id
        )
      )
    ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
    LIMIT v_page_size + 1
  ),
  retained AS MATERIALIZED (
    SELECT *
    FROM page_plus_one
    ORDER BY last_message_at DESC NULLS LAST, id DESC
    LIMIT v_page_size
  ),
  tag_rows AS (
    SELECT DISTINCT
      retained.contact_id,
      tag.id,
      tag.name,
      tag.color
    FROM retained
    JOIN public.contact_tags AS contact_tag_link
      ON contact_tag_link.contact_id = retained.contact_id
    JOIN public.tags AS tag
      ON tag.id = contact_tag_link.tag_id
  ),
  tags_by_contact AS (
    SELECT
      tag_rows.contact_id,
      jsonb_agg(
        jsonb_build_object(
          'id', tag_rows.id,
          'name', tag_rows.name,
          'color', tag_rows.color
        )
        ORDER BY tag_rows.name COLLATE "C", tag_rows.id
      ) AS tags
    FROM tag_rows
    GROUP BY tag_rows.contact_id
  ),
  item_rows AS (
    SELECT
      retained.last_message_at,
      retained.id,
      jsonb_build_object(
        'id', retained.id,
        'status', retained.status,
        'assigned_agent_id', retained.assigned_agent_id,
        'last_message_text', retained.last_message_text,
        'last_message_at', retained.last_message_at,
        'unread_count', retained.unread_count,
        'ai_autoreply_disabled', retained.ai_autoreply_disabled,
        'ai_handoff_summary', retained.ai_handoff_summary,
        'contact', jsonb_build_object(
          'id', retained.contact_id,
          'phone', retained.contact_phone,
          'name', retained.contact_name,
          'email', retained.contact_email,
          'company', retained.contact_company,
          'avatar_url', retained.contact_avatar_url,
          'tags', COALESCE(
            tags_by_contact.tags,
            '[]'::jsonb
          )
        )
      ) AS item
    FROM retained
    LEFT JOIN tags_by_contact
      ON tags_by_contact.contact_id = retained.contact_id
  )
  SELECT jsonb_build_object(
    'items', COALESCE(
      (
        SELECT jsonb_agg(
          item_rows.item
          ORDER BY item_rows.last_message_at DESC NULLS LAST, item_rows.id DESC
        )
        FROM item_rows
      ),
      '[]'::jsonb
    ),
    'has_more', (SELECT COUNT(*) FROM page_plus_one) > v_page_size,
    'next_cursor', CASE
      WHEN (SELECT COUNT(*) FROM page_plus_one) > v_page_size THEN
        (
          SELECT jsonb_build_object(
            'last_message_at', retained.last_message_at,
            'id', retained.id
          )
          FROM retained
          ORDER BY retained.last_message_at ASC NULLS FIRST, retained.id ASC
          LIMIT 1
        )
      ELSE NULL
    END
  )
  INTO v_response;

  RETURN v_response;
END;
$$;

ALTER FUNCTION public.get_inbox_conversations_page(
  UUID, INTEGER, TIMESTAMPTZ, UUID, TEXT, TEXT, UUID[], TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_inbox_conversations_page(
  UUID, INTEGER, TIMESTAMPTZ, UUID, TEXT, TEXT, UUID[], TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inbox_conversations_page(
  UUID, INTEGER, TIMESTAMPTZ, UUID, TEXT, TEXT, UUID[], TEXT
) TO authenticated;


CREATE OR REPLACE FUNCTION public.get_inbox_company_options(
  p_account_id UUID
)
RETURNS TABLE (company TEXT)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR p_account_id IS NULL
     OR NOT public.is_account_member(p_account_id)
  THEN
    RAISE EXCEPTION 'Not authorized for this account'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT company_names.company
  FROM (
    SELECT DISTINCT BTRIM(contact.company) AS company
    FROM public.contacts AS contact
    WHERE contact.account_id = p_account_id
      AND public.is_account_member(p_account_id)
      AND contact.company IS NOT NULL
      AND BTRIM(contact.company) <> ''
      AND EXISTS (
        SELECT 1
        FROM public.conversations AS conversation
        WHERE conversation.account_id = p_account_id
          AND conversation.contact_id = contact.id
      )
  ) AS company_names
  ORDER BY company_names.company COLLATE "C";
END;
$$;

ALTER FUNCTION public.get_inbox_company_options(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_inbox_company_options(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inbox_company_options(UUID) TO authenticated;
