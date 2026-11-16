import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('atomic broadcast contact creation', () => {
  it('reuses formatted contacts, creates missing contacts, and rolls back on failure', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE whatsapp_config(id uuid primary key, account_id uuid);
        CREATE TABLE broadcasts(id uuid primary key default gen_random_uuid(), account_id uuid, user_id uuid, name text, template_name text, template_language text, total_recipients int, whatsapp_config_id uuid, idempotency_key text, status text);
        CREATE UNIQUE INDEX broadcasts_key ON broadcasts(account_id,idempotency_key);
        CREATE TABLE contacts(id uuid primary key default gen_random_uuid(), account_id uuid, user_id uuid, whatsapp_config_id uuid, phone text, name text, phone_normalized text GENERATED ALWAYS AS (regexp_replace(phone, '[^0-9]', '', 'g')) STORED);
        CREATE UNIQUE INDEX line_phone ON contacts(account_id, whatsapp_config_id, phone_normalized) WHERE phone_normalized <> '' AND whatsapp_config_id IS NOT NULL;
        CREATE TABLE broadcast_recipients(id uuid primary key default gen_random_uuid(), broadcast_id uuid, contact_id uuid, phone_e164 text, template_params jsonb CHECK (template_params <> '["FAIL"]'::jsonb), status text);
      `);
      await db.exec(await readFile('supabase/migrations/052_atomic_broadcast_contacts.sql', 'utf8'));
      const account = '00000000-0000-0000-0000-000000000001';
      const user = '00000000-0000-0000-0000-000000000002';
      const line = '00000000-0000-0000-0000-000000000003';
      await db.query('INSERT INTO whatsapp_config VALUES ($1,$2)', [line, account]);
      await db.query('INSERT INTO contacts(account_id,user_id,whatsapp_config_id,phone,name) VALUES($1,$2,$3,$4,$5)', [account,user,line,'+91 99999 99999','Existing name']);
      const sql = 'SELECT * FROM create_broadcast_with_contacts($1,$2,$3,$4,$5,$6::jsonb,$7,$8)';
      const input = JSON.stringify([{ phone:'919999999999',params:['Alice'] },{ phone:'918888888888',params:[] }]);
      const first = await db.query(sql,[account,user,'Campaign','welcome','en',input,line,'key-1']);
      expect(first.rows).toHaveLength(2);
      expect((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM contacts')).rows[0].count).toBe(2);
      expect((await db.query<{ name: string }>("SELECT name FROM contacts WHERE phone_normalized='919999999999'")).rows[0].name).toBe('Existing name');
      expect((await db.query(sql,[account,user,'Next','welcome','en',input,line,'key-2'])).rows).toHaveLength(2);
      const invalid = JSON.stringify([{ phone:'917777777777',params:['FAIL'] }]);
      await expect(db.query(sql,[account,user,'Fail','welcome','en',invalid,line,'key-3'])).rejects.toThrow();
      expect((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM contacts WHERE phone_normalized='917777777777'")).rows[0].count).toBe(0);
      expect((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM broadcasts WHERE idempotency_key='key-3'")).rows[0].count).toBe(0);
    } finally { await db.close(); }
  });
});
