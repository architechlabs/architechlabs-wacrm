// Offline preparation only. No dotenv loading, secret access, API or database calls.
import { readFile } from 'node:fs/promises';

async function main() {
  const args = process.argv.slice(2);
  let accountId = process.env.ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID;
  let templates = process.env.ADMIN_DOCUMENT_DELIVERY_TEMPLATES;
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw new Error('invalid_arguments');
    if (args[i] === '--account-id') accountId = args[i + 1];
    else if (args[i] === '--templates') templates = await readFile(args[i + 1], 'utf8');
    else throw new Error('invalid_arguments');
  }
  if (process.env.ENABLE_ADMIN_DOCUMENT_DELIVERY === 'true') {
    throw new Error('keep_delivery_disabled_during_preparation');
  }
  if (!accountId || !templates) throw new Error('account_or_template_configuration_missing');
  // Transform ONLY this fixed, trusted repository module in memory. Never execute
  // a user-supplied file. This keeps the offline helper compatible with CI's Node 20
  // without changing process.env, importing routes or requiring experimental flags.
  const contractsUrl = new URL('../src/lib/document-delivery/contracts.ts', import.meta.url);
  const ts = (await import('typescript')).default;
  const { outputText } = ts.transpileModule(await readFile(contractsUrl, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const { documentConfiguration } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  const config = documentConfiguration({
    ENABLE_ADMIN_DOCUMENT_DELIVERY: 'true',
    ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID: accountId,
    ADMIN_DOCUMENT_DELIVERY_TEMPLATES: templates,
  });
  console.log(JSON.stringify({
    mode: 'offline_only',
    configurationValid: true,
    kinds: config.policies.map(policy => policy.kind),
    liveTemplateApprovalVerified: false,
    accountMembershipVerified: false,
    databaseVerified: false,
    timingVerified: false,
    activationReady: false,
  }));
}

main().catch(error => {
  const allowed = new Set([
    'invalid_arguments', 'keep_delivery_disabled_during_preparation',
    'account_or_template_configuration_missing', 'document_configuration_invalid',
  ]);
  const code = allowed.has(error?.message) ? error.message : 'configuration_read_failed';
  // Never echo input values, file paths, error stacks, template text or credentials.
  console.log(JSON.stringify({ mode: 'offline_only', configurationValid: false, code, activationReady: false }));
  process.exitCode = 1;
});
