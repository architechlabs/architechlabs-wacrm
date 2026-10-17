-- ============================================================
-- 047_multi_whatsapp_numbers
--
-- One workspace can hold many WhatsApp numbers (the business's own
-- lines and client lines onboarded as a tech provider). Chats,
-- contacts, templates, and broadcasts stay tied to the line they
-- belong to. A workspace that already has one number is unchanged:
-- that row becomes the default and every existing contact,
-- conversation, template, and broadcast is backfilled onto it.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS display_phone_number TEXT,
  ADD COLUMN IF NOT EXISTS verified_name TEXT,
  ADD COLUMN IF NOT EXISTS is_on_biz_app BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_source_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_source_check
  CHECK (source IN ('manual', 'embedded_signup'));

UPDATE whatsapp_config SET is_default = TRUE WHERE NOT is_default;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_default
  ON whatsapp_config (account_id)
  WHERE is_default;

-- ------------------------------------------------------------
-- Conversations: one thread per line, not per account.
-- ON DELETE RESTRICT keeps history attached to the number. The app
-- marks a number disconnected instead of deleting it when chats exist.
-- ------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_whatsapp_config_id_fkey'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_whatsapp_config_id_fkey
      FOREIGN KEY (whatsapp_config_id) REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
  END IF;
END $$;

UPDATE conversations AS c
SET whatsapp_config_id = w.id
FROM whatsapp_config AS w
WHERE c.account_id = w.account_id
  AND w.is_default
  AND c.whatsapp_config_id IS NULL;

DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_line_contact
  ON conversations (account_id, whatsapp_config_id, contact_id)
  WHERE whatsapp_config_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_unassigned
  ON conversations (account_id, contact_id)
  WHERE whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON conversations (whatsapp_config_id);

-- ------------------------------------------------------------
-- Contacts: the same phone can exist once per line.
-- ------------------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contacts_whatsapp_config_id_fkey'
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_whatsapp_config_id_fkey
      FOREIGN KEY (whatsapp_config_id) REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
  END IF;
END $$;

UPDATE contacts AS c
SET whatsapp_config_id = w.id
FROM whatsapp_config AS w
WHERE c.account_id = w.account_id
  AND w.is_default
  AND c.whatsapp_config_id IS NULL;

DROP INDEX IF EXISTS idx_contacts_account_phone_normalized;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_line_phone
  ON contacts (account_id, whatsapp_config_id, phone_normalized)
  WHERE phone_normalized <> '' AND whatsapp_config_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_phone_unassigned
  ON contacts (account_id, phone_normalized)
  WHERE phone_normalized <> '' AND whatsapp_config_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_config
  ON contacts (whatsapp_config_id);

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS waba_id TEXT;

UPDATE message_templates AS t
SET waba_id = w.waba_id
FROM whatsapp_config AS w
WHERE t.account_id = w.account_id
  AND w.is_default
  AND t.waba_id IS NULL
  AND w.waba_id IS NOT NULL;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'broadcasts_whatsapp_config_id_fkey'
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_whatsapp_config_id_fkey
      FOREIGN KEY (whatsapp_config_id) REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
  END IF;
END $$;

UPDATE broadcasts AS b
SET whatsapp_config_id = w.id
FROM whatsapp_config AS w
WHERE b.account_id = w.account_id
  AND w.is_default
  AND b.whatsapp_config_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_broadcasts_whatsapp_config
  ON broadcasts (whatsapp_config_id);

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_type_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive', 'unsupported', 'sticker'
  ));

-- ------------------------------------------------------------
-- Inbox page: optional line filter. NULL keeps the previous
-- "every conversation in the account" behaviour for existing callers.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_inbox_conversations_page(
  UUID, INTEGER, TIMESTAMPTZ, UUID, TEXT, TEXT, UUID[], TEXT
);

CREATE OR REPLACE FUNCTION public.get_inbox_conversations_page(
  p_account_id UUID,
  p_page_size INTEGER DEFAULT 40,
  p_cursor_last_message_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id UUID DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_filter TEXT DEFAULT 'all',
  p_tag_ids UUID[] DEFAULT '{}',
  p_company TEXT DEFAULT NULL,
  p_whatsapp_config_id UUID DEFAULT NULL
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

  IF p_cursor_id IS NULL AND p_cursor_last_message_at IS NOT NULL THEN
    RAISE EXCEPTION 'cursor_id is required when cursor timestamp is present'
      USING ERRCODE = '22023';
  END IF;

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
      c.whatsapp_config_id,
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
        p_whatsapp_config_id IS NULL
        OR c.whatsapp_config_id = p_whatsapp_config_id
      )
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
        'whatsapp_config_id', retained.whatsapp_config_id,
        'contact', jsonb_build_object(
          'id', retained.contact_id,
          'phone', retained.contact_phone,
          'name', retained.contact_name,
          'email', retained.contact_email,
          'company', retained.contact_company,
          'avatar_url', retained.contact_avatar_url,
          'tags', COALESCE(tags_by_contact.tags, '[]'::jsonb)
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
  UUID, INTEGER, TIMESTAMPTZ, UUID, TEXT, TEXT, UUID[], TEXT, UUID
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_inbox_conversations_page(
  UUID, INTEGER, TIMESTAMPTZ, UUID, TEXT, TEXT, UUID[], TEXT, UUID
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inbox_conversations_page(
  UUID, INTEGER, TIMESTAMPTZ, UUID, TEXT, TEXT, UUID[], TEXT, UUID
) TO authenticated;

DROP FUNCTION IF EXISTS public.get_inbox_company_options(UUID);

CREATE OR REPLACE FUNCTION public.get_inbox_company_options(
  p_account_id UUID,
  p_whatsapp_config_id UUID DEFAULT NULL
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
      AND (p_whatsapp_config_id IS NULL OR contact.whatsapp_config_id = p_whatsapp_config_id)
      AND contact.company IS NOT NULL
      AND BTRIM(contact.company) <> ''
      AND EXISTS (
        SELECT 1
        FROM public.conversations AS conversation
        WHERE conversation.account_id = p_account_id
          AND conversation.contact_id = contact.id
          AND (
            p_whatsapp_config_id IS NULL
            OR conversation.whatsapp_config_id = p_whatsapp_config_id
          )
      )
  ) AS company_names
  ORDER BY company_names.company COLLATE "C";
END;
$$;

ALTER FUNCTION public.get_inbox_company_options(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_inbox_company_options(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inbox_company_options(UUID, UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0,
  p_whatsapp_config_id UUID DEFAULT NULL
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (p_whatsapp_config_id IS NULL OR c.whatsapp_config_id = p_whatsapp_config_id)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB[],
  p_whatsapp_config_id UUID DEFAULT NULL
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients, whatsapp_config_id
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients, p_whatsapp_config_id
  )
  RETURNING id INTO v_broadcast_id;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    RETURNING id, contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID
) TO service_role;
