import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('queue broadcast reservation SQL', () => {
  it('claims and reserves atomically and refuses a second claim', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE broadcasts(id uuid primary key,account_id uuid,whatsapp_config_id uuid,user_id uuid,template_name text,delivery_paused_at timestamptz,delivery_pause_reason text,status text default 'sending',delivery_locked_at timestamptz,updated_at timestamptz);
        CREATE TABLE broadcast_recipients(id uuid primary key,broadcast_id uuid,contact_id uuid,status text,send_started_at timestamptz,whatsapp_message_id text,sent_at timestamptz,error_message text,error_code int,delivery_outcome text);
        CREATE TABLE conversations(id uuid primary key default gen_random_uuid(),account_id uuid,user_id uuid,contact_id uuid,whatsapp_config_id uuid,created_at timestamptz default now(),last_message_text text,last_message_at timestamptz,updated_at timestamptz);
        CREATE UNIQUE INDEX conversations_once ON conversations(account_id,whatsapp_config_id,contact_id);
        CREATE TABLE messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,sender_type text,content_type text,content_text text,template_name text,status text,broadcast_id uuid,message_id text,failure_code integer,failure_reason text);
        CREATE FUNCTION public.claim_broadcast_recipient(uuid,uuid,uuid) RETURNS text LANGUAGE plpgsql AS $$ BEGIN UPDATE broadcast_recipients SET send_started_at=now() WHERE id=$3 AND status='pending' AND send_started_at IS NULL AND whatsapp_message_id IS NULL; IF FOUND THEN RETURN 'claimed'; END IF; RETURN 'unavailable'; END $$;
        INSERT INTO broadcasts(id,account_id,whatsapp_config_id,user_id,template_name) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','welcome');
        INSERT INTO broadcast_recipients(id,broadcast_id,contact_id,status) VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000006','pending');
      `);
      await db.exec(await readFile('supabase/migrations/058_broadcast_queue.sql', 'utf8'));
      const args = ['00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005'];
      const query = 'SELECT * FROM broadcast_claim_and_reserve($1,$2,$3,$4)';
      const first = (await db.query<{ outcome: string; message_id: string }>(query, [...args, 'Hello'])).rows[0];
      expect(first.outcome).toBe('claimed');
      expect((await db.query<{ outcome: string }>(query, [...args, 'Hello'])).rows[0].outcome).toBe('unavailable');
      await db.query('SELECT broadcast_finish_recipient($1,$2,$3,$4,$5,$6,$7)', [...args, first.message_id, 'wamid.example', null, null]);
      expect((await db.query<{ status: string; message_id: string }>('SELECT status,message_id FROM messages')).rows[0]).toEqual({ status: 'sent', message_id: 'wamid.example' });
      await db.exec("INSERT INTO broadcast_recipients(id,broadcast_id,contact_id,status,send_started_at) VALUES ('00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000006','pending',now()-interval '11 minutes'), ('00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000006','pending',NULL)");
      await db.exec("UPDATE broadcasts SET delivery_locked_at=now()");
      expect((await db.query('SELECT * FROM sweep_broadcast_queue()')).rows).toHaveLength(0);
      await db.exec("UPDATE broadcasts SET delivery_locked_at=now()-interval '3 minutes'");
      expect((await db.query('SELECT * FROM sweep_broadcast_queue()')).rows).toHaveLength(1);
      expect((await db.query<{ delivery_outcome: string }>("SELECT delivery_outcome FROM broadcast_recipients WHERE id='00000000-0000-0000-0000-000000000007'")).rows[0].delivery_outcome).toBe('in_progress_or_unknown');
      const nextArgs = [args[0], args[1], '00000000-0000-0000-0000-000000000008'];
      const next = (await db.query<{ message_id: string }>(query, [...nextArgs, 'Hello'])).rows[0];
      await db.query('SELECT broadcast_finish_recipient($1,$2,$3,$4,$5,$6,$7)', [...nextArgs, next.message_id, null, 131049, 'Recipient restricted']);
      expect((await db.query<{ error_code: number; status: string }>("SELECT error_code,status FROM broadcast_recipients WHERE id='00000000-0000-0000-0000-000000000008'")).rows[0]).toEqual({ error_code: 131049, status: 'failed' });
      expect((await db.query<{ delivery_paused_at: string | null }>('SELECT delivery_paused_at FROM broadcasts')).rows[0].delivery_paused_at).toBeNull();
    } finally { await db.close(); }
  });
});
