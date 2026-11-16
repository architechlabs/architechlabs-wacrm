import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('broadcast claim migration', () => {
  it('atomically rejects duplicate launches and skips STOP contacts', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE broadcasts (id uuid primary key default gen_random_uuid(), account_id uuid, user_id uuid, name text, template_name text, template_language text, total_recipients int, whatsapp_config_id uuid, status text);
        CREATE TABLE contacts (id uuid primary key, account_id uuid, phone_normalized text);
        CREATE TABLE broadcast_recipients (id uuid primary key default gen_random_uuid(), broadcast_id uuid, contact_id uuid, template_params jsonb, status text, whatsapp_message_id text, error_message text);
        CREATE TABLE tags (id uuid primary key, name text);
        CREATE TABLE contact_tags (contact_id uuid, tag_id uuid);
        CREATE TABLE conversations (id uuid primary key, contact_id uuid, account_id uuid);
        CREATE TABLE messages (conversation_id uuid, sender_type text, content_text text);
      `);
      await db.exec(await readFile('supabase/migrations/050_broadcast_claims.sql', 'utf8'));
      const account = '00000000-0000-0000-0000-000000000001';
      const user = '00000000-0000-0000-0000-000000000002';
      const contact = '00000000-0000-0000-0000-000000000003';
      const conversation = '00000000-0000-0000-0000-000000000004';
      await db.query('INSERT INTO contacts VALUES ($1,$2,$3)', [contact, account, '919999999999']);
      const args = [account, user, 'Campaign', 'hello', 'en', [contact], ['+919999999999'], ['[]'], null, 'launch-key'];
      const sql = 'SELECT * FROM create_broadcast_idempotent($1,$2,$3,$4,$5,$6::uuid[],$7::text[],$8::jsonb[],$9,$10)';
      const created = await db.query<{ broadcast_id: string; recipient_id: string }>(sql, args);
      await expect(db.query(sql, args)).rejects.toThrow();
      await db.query('INSERT INTO conversations VALUES ($1,$2,$3)', [conversation, contact, account]);
      await db.query("INSERT INTO messages VALUES ($1,'customer',' STOP ')", [conversation]);
      const row = created.rows[0];
      const claim = await db.query<{ claim: string }>('SELECT claim_broadcast_recipient($1,$2,$3) AS claim', [account, row.broadcast_id, row.recipient_id]);
      expect(claim.rows[0].claim).toBe('skipped_opt_out');
      const again = await db.query<{ claim: string }>('SELECT claim_broadcast_recipient($1,$2,$3) AS claim', [account, row.broadcast_id, row.recipient_id]);
      expect(again.rows[0].claim).toBe('unavailable');
      const otherContact = '00000000-0000-0000-0000-000000000005';
      await db.query('INSERT INTO contacts VALUES ($1,$2,$3)', [otherContact, account, '918888888888']);
      const other = await db.query<{ broadcast_id: string; recipient_id: string }>(sql,
        [account, user, 'Other', 'hello', 'en', [otherContact], ['+918888888888'], ['[]'], null, 'another-key']);
      const second = other.rows[0];
      const firstClaim = await db.query<{ claim: string }>('SELECT claim_broadcast_recipient($1,$2,$3) AS claim', [account, second.broadcast_id, second.recipient_id]);
      const secondClaim = await db.query<{ claim: string }>('SELECT claim_broadcast_recipient($1,$2,$3) AS claim', [account, second.broadcast_id, second.recipient_id]);
      expect(firstClaim.rows[0].claim).toBe('claimed');
      expect(secondClaim.rows[0].claim).toBe('unavailable');
    } finally { await db.close(); }
  });
});
