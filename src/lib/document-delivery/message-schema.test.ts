import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Real in-memory PostgreSQL engine, synthetic fixture only. No Supabase/network.
const db = new PGlite();
const account = '11111111-1111-4111-8111-111111111111';
const otherAccount = '22222222-2222-4222-8222-222222222222';
const conversation = '33333333-3333-4333-8333-333333333333';
const otherConversation = '44444444-4444-4444-8444-444444444444';
const message = '55555555-5555-4555-8555-555555555555';
const key = 'a'.repeat(64);
const diagnostic = readFileSync(new URL('../../../docs/admin-document-delivery/verify-inbox-document-schema-read-only.sql', import.meta.url), 'utf8');
let missingSchemaChecks: {check_name: string; passed: boolean}[] = [];
const metadata = {
  kind: 'quotation', documentNumber: 'Q/1', revision: 1, recipient: '+919876543210',
  pdfSha256: 'b'.repeat(64), filename: 'Q-1-quotation.pdf', apiKeyId: message,
  consentConfirmedAt: '2026-10-12T00:00:00.000Z', metaTemplateId: '123', language: 'en_US',
};
async function reserve(id = message, conversationId = conversation, accountId = account) {
  return db.query(`INSERT INTO public.messages
    (id,conversation_id,sender_type,content_type,content_text,template_name,status,media_url,media_type,
     admin_document_account_id,admin_document_key,admin_document_fingerprint,admin_document_metadata,admin_document_state)
    VALUES ($1::uuid,$2::uuid,'agent','template','Synthetic quotation','quotation_pdf','sending',
      '/api/document-deliveries/' || ($1::uuid)::text || '/pdf','application/pdf',$3::uuid,$4,$5,$6::jsonb,'reserved')`,
  [id, conversationId, accountId, key, 'c'.repeat(64), JSON.stringify(metadata)]);
}

describe('document metadata protection on the existing messages table', () => {
  beforeAll(async () => {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE supabase_admin;
      CREATE TABLE public.accounts (id uuid PRIMARY KEY);
      CREATE TABLE public.conversations (id uuid PRIMARY KEY, account_id uuid REFERENCES accounts, contact_id uuid);
      CREATE TABLE public.messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid REFERENCES conversations ON DELETE CASCADE,
        sender_type text, content_type text, content_text text, template_name text, status text,
        message_id text, media_url text, media_type text, client_request_id uuid,
        failure_code integer, failure_reason text, created_at timestamptz DEFAULT now()
      );
      INSERT INTO accounts VALUES ('${account}'),('${otherAccount}');
      INSERT INTO conversations VALUES ('${conversation}','${account}',gen_random_uuid()),
        ('${otherConversation}','${otherAccount}',gen_random_uuid());
      ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
      CREATE POLICY fixture_account_messages ON messages FOR ALL USING (
        EXISTS (SELECT 1 FROM conversations c WHERE c.id=conversation_id
          AND c.account_id=current_setting('test.account_id', true)::uuid)
      ) WITH CHECK (
        EXISTS (SELECT 1 FROM conversations c WHERE c.id=conversation_id
          AND c.account_id=current_setting('test.account_id', true)::uuid)
      );
      GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon,authenticated,service_role;
    `);
    const missing = await db.exec(diagnostic);
    missingSchemaChecks = missing[1].rows as typeof missingSchemaChecks;
    await db.exec(readFileSync(new URL('../../../supabase/migrations/046_admin_document_messages.sql', import.meta.url), 'utf8'));
    await db.query(readFileSync(new URL('../../../docs/admin-document-delivery/create-document-message-index.sql', import.meta.url), 'utf8'));
    await db.exec('ALTER TABLE public.messages VALIDATE CONSTRAINT messages_admin_document_shape;');
  }, 30_000);
  beforeEach(async () => {
    await db.exec(`BEGIN; SET LOCAL "test.account_id"='${account}'; SET LOCAL ROLE service_role;`);
  });
  afterEach(async () => { await db.exec('ROLLBACK;'); });
  afterAll(async () => { await db.close(); });

  it('runs the catalog diagnostic before migration without reading missing columns', () => {
    expect(missingSchemaChecks).toHaveLength(10);
    expect(missingSchemaChecks.find(check => check.check_name === 'document_columns_present')?.passed).toBe(false);
    expect(missingSchemaChecks.find(check => check.check_name === 'account_document_unique_index_ready')?.passed).toBe(false);
  });
  it('reports the ready schema without reading delivery rows', async () => {
    // Diagnostic owns a read-only transaction; end this test's writable fixture transaction.
    await db.exec('ROLLBACK;');
    const result = await db.exec(diagnostic);
    expect(result[1].rows).toHaveLength(10);
    expect(result[1].rows.every(row => row.passed === true)).toBe(true);
  });

  it('does not create a separate outbox and preserves ordinary message insert/edit/delete', async () => {
    const tables = await db.query<{ name: string | null }>("SELECT to_regclass('public.admin_document_deliveries')::text AS name");
    expect(tables.rows[0].name).toBeNull();
    await db.exec(`SET LOCAL ROLE authenticated;
      INSERT INTO messages(id,conversation_id,content_type,status) VALUES ('${message}','${conversation}','text','sent');
      UPDATE messages SET content_text='ordinary edit',status='read' WHERE id='${message}';
      DELETE FROM messages WHERE id='${message}';`);
    expect((await db.query('SELECT id FROM messages')).rows).toEqual([]);
  });
  it('enforces account-wide uniqueness even when a second conversation is created', async () => {
    await reserve();
    const second = '66666666-6666-4666-8666-666666666666';
    await db.exec(`INSERT INTO conversations VALUES ('${second}','${account}',gen_random_uuid());`);
    await expect(reserve('77777777-7777-4777-8777-777777777777', second)).rejects.toMatchObject({ code: '23505' });
  });
  it('allows the same logical key in a different account', async () => {
    await reserve(); await reserve('77777777-7777-4777-8777-777777777777', otherConversation, otherAccount);
    expect((await db.query('SELECT id FROM messages')).rows).toHaveLength(2);
  });
  it('rejects cross-account reservations before provider work', async () => {
    await expect(reserve(message, otherConversation, account)).rejects.toThrow('document_account_mismatch');
  });
  it('fails closed if the unique index is absent', async () => {
    await db.exec('RESET ROLE; DROP INDEX public.idx_messages_admin_document_key; SET LOCAL ROLE service_role;');
    await expect(reserve()).rejects.toThrow('document_unique_index_required');
  });
  it('prevents authenticated clients from forging document reservations', async () => {
    await db.exec('SET LOCAL ROLE authenticated;');
    await expect(reserve()).rejects.toThrow('document_message_server_only');
  });
  it('keeps inbox reads account-scoped through existing RLS', async () => {
    await reserve(); await db.exec('SET LOCAL ROLE authenticated;');
    expect((await db.query('SELECT id FROM messages')).rows).toHaveLength(1);
    await db.exec(`SET LOCAL "test.account_id"='${otherAccount}';`);
    expect((await db.query('SELECT id FROM messages')).rows).toHaveLength(0);
  });
  it('prevents agents from editing document identity or status', async () => {
    await reserve(); await db.exec('SET LOCAL ROLE authenticated;');
    await expect(db.exec(`UPDATE messages SET status='read' WHERE id='${message}';`)).rejects.toThrow('document_message_server_only');
  });
  it.each([
    "admin_document_metadata=jsonb_set(admin_document_metadata,'{recipient}','\"+919876543211\"')",
    "admin_document_metadata=jsonb_set(admin_document_metadata,'{pdfSha256}','\"changed\"')",
    `conversation_id='${otherConversation}'`,
  ])('prevents service code from rewriting protected identity: %s', async (change) => {
    await reserve();
    await expect(db.exec(`UPDATE messages SET ${change} WHERE id='${message}';`)).rejects.toThrow('document_message_immutable');
  });
  it('retains the document attempt on message/conversation deletion', async () => {
    await reserve();
    await expect(db.exec(`DELETE FROM conversations WHERE id='${conversation}';`)).rejects.toThrow('document_message_retention_required');
  });
  it('does not let application roles bypass retention through TRUNCATE', async () => {
    await reserve();
    await expect(db.exec('TRUNCATE public.messages;')).rejects.toMatchObject({ code: '42501' });
  });
  it('prevents reassigning the containing conversation to another account', async () => {
    await reserve();
    await expect(db.exec(`UPDATE conversations SET account_id='${otherAccount}' WHERE id='${conversation}';`)).rejects.toThrow('document_conversation_immutable');
  });
  it('supports media persistence, atomic acceptance and existing webhook statuses', async () => {
    await reserve();
    await db.exec(`UPDATE messages SET admin_document_media_id='456' WHERE id='${message}';
      UPDATE messages SET message_id='wamid.example',admin_document_state='accepted' WHERE id='${message}';
      UPDATE messages SET status='sent' WHERE id='${message}' AND status='sending';
      UPDATE messages SET status='delivered' WHERE message_id='wamid.example';
      UPDATE messages SET status='read' WHERE message_id='wamid.example';`);
    expect((await db.query('SELECT status,admin_document_state FROM messages')).rows).toEqual([{ status: 'read', admin_document_state: 'accepted' }]);
  });
  it('atomically claims an existing message once without creating another row', async () => {
    await reserve();
    const claim = () => db.query(`UPDATE messages SET admin_document_claim_id=gen_random_uuid()
      WHERE id=$1::uuid AND admin_document_account_id=$2::uuid AND admin_document_fingerprint=$3
        AND admin_document_state='reserved' AND admin_document_claim_id IS NULL RETURNING id`,
      [message,account,'c'.repeat(64)]);
    const results=await Promise.all([claim(),claim()]);
    expect(results.map(r => r.rows.length).sort()).toEqual([0,1]);
    expect((await db.query('SELECT id FROM messages')).rows).toHaveLength(1);
  });
  it.each(['NULL',"'77777777-7777-4777-8777-777777777777'::uuid"])('cannot clear or replace a permanent claim: %s', async value => {
    await reserve(); await db.exec(`UPDATE messages SET admin_document_claim_id=gen_random_uuid() WHERE id='${message}';`);
    await expect(db.exec(`UPDATE messages SET admin_document_claim_id=${value} WHERE id='${message}';`)).rejects.toThrow('document_claim_immutable');
  });
  it('does not claim a row after uploading media', async () => {
    await reserve(); await db.exec(`UPDATE messages SET admin_document_media_id='456' WHERE id='${message}';`);
    await expect(db.exec(`UPDATE messages SET admin_document_claim_id=gen_random_uuid() WHERE id='${message}';`)).rejects.toThrow('document_claim_immutable');
  });
  it('records an uncertain send without inventing an integer Meta failure code', async () => {
    await reserve();
    await db.exec(`UPDATE messages SET admin_document_state='unknown',status='failed',failure_code=NULL,
      failure_reason='Delivery is unconfirmed. Review before any further send; no automatic retry.' WHERE id='${message}';`);
    expect((await db.query('SELECT admin_document_state,failure_code FROM messages')).rows).toEqual([{ admin_document_state: 'unknown', failure_code: null }]);
  });
  it('rejects acceptance without a persisted media ID', async () => {
    await reserve();
    await expect(db.exec(`UPDATE messages SET message_id='wamid.example',admin_document_state='accepted' WHERE id='${message}';`)).rejects.toMatchObject({ code: '23514' });
  });
  it('never permits unknown attempts to become retryable sending rows', async () => {
    await reserve();
    await db.exec(`UPDATE messages SET admin_document_state='unknown',status='failed' WHERE id='${message}';`);
    await expect(db.exec(`UPDATE messages SET status='sending' WHERE id='${message}';`)).rejects.toThrow('document_attempt_not_retryable');
  });
  it('keeps provider acknowledgement immutable once recorded', async () => {
    await reserve();
    await db.exec(`UPDATE messages SET admin_document_media_id='456',message_id='wamid.example',admin_document_state='accepted' WHERE id='${message}';`);
    await expect(db.exec(`UPDATE messages SET message_id=NULL WHERE id='${message}';`)).rejects.toThrow('document_acknowledgement_immutable');
  });
});
