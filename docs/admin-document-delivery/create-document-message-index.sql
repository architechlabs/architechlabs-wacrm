-- REVIEW ONLY: run as a SINGLE standalone statement, outside any transaction,
-- after migration 046. Staging first; production needs backup + release approval.
-- CONCURRENTLY avoids blocking ordinary inbox writes during the historical scan.
-- Do not use IF NOT EXISTS: an invalid/wrong existing index must not be ignored.
-- If interrupted, inspect pg_index; do not blindly drop/recreate anything.
CREATE UNIQUE INDEX CONCURRENTLY idx_messages_admin_document_key
  ON public.messages (admin_document_account_id, admin_document_key)
  WHERE admin_document_key IS NOT NULL;
