import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/check-admin-document-config.mjs', import.meta.url));
const policy = {
  kind: 'quotation', name: 'quotation_pdf', language: 'en_US', metaTemplateId: '123',
  bodyText: 'Dear {{1}}, quotation {{2}} is attached.', fields: ['customerName', 'documentNumber'],
};
const base = {
  ENABLE_ADMIN_DOCUMENT_DELIVERY: 'false',
  ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID: '11111111-1111-4111-8111-111111111111',
  ADMIN_DOCUMENT_DELIVERY_TEMPLATES: JSON.stringify([policy]),
  PRIVATE_TEST_VALUE: 'synthetic-secret-never-print',
};
function check(changes: Record<string, string | undefined> = {}, args: string[] = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...base, ...changes }, encoding: 'utf8', timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain(base.PRIVATE_TEST_VALUE);
  expect(result.stdout).not.toContain(base.ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID);
  expect(result.stdout).not.toContain('Dear');
  return { status: result.status, data: JSON.parse(result.stdout) };
}

// Several bounded subprocesses per test; compiler startup can exceed Vitest's
// 5-second default on Windows/Node 20. Each child still has its own 10-second cap.
describe('offline document configuration preflight', { timeout: 30_000 }, () => {
  it('validates using the runtime parser but never claims live readiness', () => {
    const { status, data } = check();
    expect(status).toBe(0);
    expect(data).toEqual({
      mode: 'offline_only', configurationValid: true, kinds: ['quotation'],
      liveTemplateApprovalVerified: false, accountMembershipVerified: false,
      databaseVerified: false, timingVerified: false, activationReady: false,
    });
  });
  it('blocks enabled preparation, missing account, invalid JSON and placeholder IDs', () => {
    for (const changes of [
      { ENABLE_ADMIN_DOCUMENT_DELIVERY: 'true' },
      { ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID: '' },
      { ADMIN_DOCUMENT_DELIVERY_TEMPLATES: 'synthetic-secret-never-print' },
      { ADMIN_DOCUMENT_DELIVERY_TEMPLATES: JSON.stringify([{ ...policy, metaTemplateId: 'REPLACE_ME' }]) },
    ]) {
      const { status, data } = check(changes);
      expect(status).toBe(1);
      expect(data.configurationValid).toBe(false);
      expect(data.activationReady).toBe(false);
    }
  });
  it('rejects payment-received tax wording and a quotation reused for proforma', () => {
    for (const p of [
      { ...policy, kind: 'tax', bodyText: 'Dear {{1}}, payment received for tax invoice {{2}}.' },
      { ...policy, kind: 'proforma' },
    ]) expect(check({ ADMIN_DOCUMENT_DELIVERY_TEMPLATES: JSON.stringify([p]) }).status).toBe(1);
  });
  it('does not expose unknown arguments or inaccessible paths', () => {
    expect(check({}, ['--api-key', base.PRIVATE_TEST_VALUE]).data.code).toBe('invalid_arguments');
    expect(check({}, ['--templates', 'missing-synthetic-config.json']).data.code).toBe('configuration_read_failed');
  });
  it('keeps new invoice drafts unconfigured, neutral and explicitly mapped', () => {
    const draft = JSON.parse(readFileSync(new URL('../../../docs/admin-document-delivery/invoice-template-drafts.json', import.meta.url), 'utf8'));
    expect(draft.status).toBe('DRAFTS_FOR_META_APPROVAL_ONLY_NOT_RUNTIME_CONFIGURATION');
    expect(draft.category).toBe('UTILITY');
    expect(draft.headerFormat).toBe('DOCUMENT');
    expect(draft.buttons).toEqual([]);
    for (const d of draft.drafts) {
      expect(d.metaTemplateId).toBeUndefined();
      const reviewedFixture = { kind: d.kind, name: d.suggestedName, bodyText: d.bodyText,
        fields: d.fields, language: draft.language, metaTemplateId: '123' };
      expect(check({ ADMIN_DOCUMENT_DELIVERY_TEMPLATES: JSON.stringify([reviewedFixture]) }).status).toBe(0);
    }
    expect(check({ ADMIN_DOCUMENT_DELIVERY_TEMPLATES: JSON.stringify(draft) }).status).toBe(1);
  });
});
