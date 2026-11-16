import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('external message log migration', () => {
  it('inserts once, links only a pending recipient and preserves a newer conversation', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE conversations(id uuid primary key, account_id uuid, contact_id uuid, whatsapp_config_id uuid, last_message_text text, last_message_at timestamptz, updated_at timestamptz);
        CREATE TABLE broadcasts(id uuid primary key, account_id uuid, whatsapp_config_id uuid);
        CREATE TABLE messages(id uuid primary key default gen_random_uuid(), conversation_id uuid, sender_type text, content_type text, content_text text, template_name text, message_id text, status text, created_at timestamptz, failure_code int, broadcast_id uuid);
        CREATE TABLE broadcast_recipients(id uuid primary key default gen_random_uuid(), broadcast_id uuid, contact_id uuid, status text, whatsapp_message_id text, sent_at timestamptz, delivered_at timestamptz, read_at timestamptz, error_code int);
        INSERT INTO conversations VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000002','newer','2030-01-01',now());
        INSERT INTO broadcasts VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
        INSERT INTO broadcast_recipients(broadcast_id,contact_id,status) VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000004','pending');
      `);
      await db.exec(await readFile('supabase/migrations/056_external_message_log.sql', 'utf8'));
      const params = ['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','wamid.test','template','Hello Alice','welcome','sent','2026-01-01T00:00:00Z',null,'00000000-0000-0000-0000-000000000005'];
      const query = 'SELECT * FROM log_external_message($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)';
      const first = await db.query<{ message_id: string; duplicate: boolean }>(query, params);
      expect(first.rows[0].duplicate).toBe(false);
      const second = await db.query<{ message_id: string; duplicate: boolean }>(query, params);
      expect(second.rows[0]).toMatchObject({ message_id: first.rows[0].message_id, duplicate: true });
      expect((await db.query<{ status: string; whatsapp_message_id: string }>('SELECT status,whatsapp_message_id FROM broadcast_recipients')).rows[0]).toEqual({ status: 'sent', whatsapp_message_id: 'wamid.test' });
      expect((await db.query<{ last_message_text: string }>('SELECT last_message_text FROM conversations')).rows[0].last_message_text).toBe('newer');
      params[4] = 'wamid.second';
      await db.query(query, params);
      expect((await db.query<{ whatsapp_message_id: string }>('SELECT whatsapp_message_id FROM broadcast_recipients')).rows[0].whatsapp_message_id).toBe('wamid.test');
    } finally { await db.close(); }
  });

  it('refuses to add a unique index if existing IDs are duplicated', async () => {
    const db = new PGlite();
    try {
      await db.exec("CREATE TABLE messages(message_id text); INSERT INTO messages VALUES ('wamid.same'),('wamid.same')");
      await expect(db.exec(await readFile('supabase/migrations/056_external_message_log.sql', 'utf8'))).rejects.toThrow('Duplicate message_id');
      expect((await db.query('SELECT message_id FROM messages')).rows).toHaveLength(2);
    } finally { await db.close(); }
  });
});
