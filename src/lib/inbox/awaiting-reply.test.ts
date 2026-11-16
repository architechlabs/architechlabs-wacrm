import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('unanswered conversations', () => {
  it('shows only the selected number when the latest accepted message has waited 24 hours', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated;
        CREATE TABLE conversations (id uuid primary key, whatsapp_config_id uuid);
        CREATE TABLE messages (id uuid primary key default gen_random_uuid(), conversation_id uuid, sender_type text, status text, created_at timestamptz);
      `);
      await db.exec(await readFile('supabase/migrations/051_inbox_awaiting_reply.sql', 'utf8'));
      await db.exec(`
        INSERT INTO conversations VALUES
          ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
          ('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001'),
          ('00000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001'),
          ('00000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002');
        INSERT INTO messages(conversation_id, sender_type, status, created_at) VALUES
          ('00000000-0000-0000-0000-000000000001','agent','sent', now() - interval '25 hours'),
          ('00000000-0000-0000-0000-000000000002','agent','sent', now() - interval '30 hours'),
          ('00000000-0000-0000-0000-000000000002','customer','delivered', now() - interval '1 hour'),
          ('00000000-0000-0000-0000-000000000003','agent','sent', now() - interval '23 hours'),
          ('00000000-0000-0000-0000-000000000004','agent','sent', now() - interval '30 hours');
      `);
      const query = "SELECT conversation_id FROM get_inbox_awaiting_reply('10000000-0000-0000-0000-000000000001')";
      expect((await db.query<{ conversation_id: string }>(query)).rows.map((row) => row.conversation_id))
        .toEqual(['00000000-0000-0000-0000-000000000001']);
      await db.exec("INSERT INTO messages(conversation_id, sender_type, status, created_at) VALUES ('00000000-0000-0000-0000-000000000001','customer','delivered',now())");
      expect((await db.query(query)).rows).toEqual([]);
    } finally { await db.close(); }
  });
});
