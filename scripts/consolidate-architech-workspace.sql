-- One-time: single Architech Labs workspace (Connectly-style).
-- Canonical account holds WhatsApp, inbox, contacts, templates.
-- Run only against nthvtmzvmjiowvjgitmv with service role / SQL editor.

BEGIN;

-- Canonical workspace (already has whatsapp_config + inbox data).
UPDATE accounts
SET name = 'Architech Labs'
WHERE id = '90e47f37-19d5-4fb8-94f8-8c2df7599f7e';

-- Duplicate default pipeline on Amit's solo account (0 deals); main account already has Sales Pipeline.
DELETE FROM pipelines
WHERE id = '820491b0-d0d4-42aa-b62e-b5d38a98ad05'
  AND account_id = '79e32e8b-87f4-4861-9f86-d0013806e556';

-- Move Architech team into the shared account (shared inbox admins; roby stays owner).
UPDATE profiles
SET
  account_id = '90e47f37-19d5-4fb8-94f8-8c2df7599f7e',
  account_role = 'admin'
WHERE email IN ('aradhya.singh@architechlabs.in', 'amit@architechlabs.in');

-- Drop empty per-user accounts (no profiles left).
DELETE FROM accounts
WHERE id IN (
  '50d3c47a-0ebf-451b-a392-7dd49a366ba9',
  '79e32e8b-87f4-4861-9f86-d0013806e556'
)
  AND NOT EXISTS (
    SELECT 1 FROM profiles p WHERE p.account_id = accounts.id
  );

COMMIT;
