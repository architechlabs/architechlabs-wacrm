import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('WABA template sync migration', () => {
  it('adopts unassigned legacy rows and preserves languages and other WABAs', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated;
        CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000002'::uuid $$;
        CREATE FUNCTION public.is_account_member(uuid, text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
        CREATE TABLE whatsapp_config(id uuid primary key, account_id uuid, waba_id text, is_default boolean);
        CREATE TABLE message_templates(id uuid primary key default gen_random_uuid(), account_id uuid, user_id uuid, waba_id text, name text, language text, category text, status text, header_type text, header_content text, header_handle text, body_text text, footer_text text, buttons jsonb, sample_values jsonb, quality_score text, meta_template_id text, meta_components jsonb, updated_at timestamptz);
        CREATE UNIQUE INDEX message_templates_user_name_language_key ON message_templates(user_id,name,language);
        INSERT INTO whatsapp_config VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','1055269280554939',true), ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','other-waba',false);
        INSERT INTO message_templates(account_id,user_id,name,language,body_text) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','project_consultation','en','Old text');
        INSERT INTO message_templates(account_id,user_id,waba_id,name,language,meta_template_id) VALUES
          ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','other-waba','welcome_greeting','en','other-meta-id');
      `);
      await db.exec(await readFile('supabase/migrations/055_template_sync_legacy.sql', 'utf8'));
      const config = '00000000-0000-0000-0000-000000000003';
      const sql = 'SELECT * FROM public.sync_waba_template($1::uuid, $2::jsonb)';
      const row = (name: string, language: string, id: string) => JSON.stringify({ name, language, category: 'Marketing', status: 'APPROVED', body_text: 'Hello', meta_template_id: id, meta_components: [{ type: 'BODY', text: 'Hello' }] });
      expect((await db.query<{ was_inserted: boolean }>(sql, [config, row('welcome_greeting', 'en', 'meta-en')])).rows[0].was_inserted).toBe(true);
      expect((await db.query<{ was_inserted: boolean }>(sql, [config, row('welcome_greeting', 'en', 'meta-en')])).rows[0].was_inserted).toBe(false);
      expect((await db.query<{ was_inserted: boolean }>(sql, [config, row('project_consultation', 'en', 'meta-project')])).rows[0].was_inserted).toBe(false);
      expect((await db.query<{ was_inserted: boolean }>(sql, [config, row('welcome_greeting', 'en_US', 'meta-us')])).rows[0].was_inserted).toBe(true);
      const rows = (await db.query<{ language: string; waba_id: string; meta_template_id: string; whatsapp_config_id: string }>("SELECT language,waba_id,meta_template_id,whatsapp_config_id FROM message_templates WHERE name='welcome_greeting' AND waba_id='1055269280554939' ORDER BY language")).rows;
      expect(rows).toEqual([{ language:'en',waba_id:'1055269280554939',meta_template_id:'meta-en',whatsapp_config_id:config }, { language:'en_US',waba_id:'1055269280554939',meta_template_id:'meta-us',whatsapp_config_id:config }]);
      expect((await db.query<{ meta_template_id: string }>("SELECT meta_template_id FROM message_templates WHERE name='welcome_greeting' AND waba_id='other-waba'")).rows[0].meta_template_id).toBe('other-meta-id');
      expect((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM message_templates WHERE name='welcome_greeting' AND language='en'")).rows[0].count).toBe(2);
    } finally { await db.close(); }
  });
});
