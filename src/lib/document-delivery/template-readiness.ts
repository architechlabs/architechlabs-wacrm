import type { DocumentPolicy } from './contracts';
import { DocumentMetaClient } from './meta';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveWhatsAppConfig } from '@/lib/whatsapp/resolve-config';
import { DocumentDeliveryError } from './contracts';

// Recheck Meta at the point of use. A local "approved" template record can be
// stale after an edit, and a TEXT header cannot accept our PDF parameter.
async function configuredClient(accountId: string): Promise<DocumentMetaClient> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId)) throw new DocumentDeliveryError('document_configuration_invalid',503);
  const data = await resolveWhatsAppConfig(supabaseAdmin(), { accountId }).catch(() => null);
  if (!data?.waba_id) throw new DocumentDeliveryError('whatsapp_not_configured', 503);
  return new DocumentMetaClient(data.phone_number_id, decrypt(data.access_token), data.waba_id);
}
export async function verifyConfiguredDocumentTemplate(accountId: string, policy: DocumentPolicy): Promise<void> {
  await (await configuredClient(accountId)).verifyTemplate(policy);
}

export async function inspectConfiguredDocumentTemplates(accountId: string) {
  const client = await configuredClient(accountId);
  // Fixed allowlist: this cannot inspect arbitrary businesses/templates supplied
  // by a caller. Inspection neither saves template records nor enables sending.
  return Promise.all(['quotation_pdf','proforma_invoice_pdf','tax_invoice_pdf'].map(async name => {
    try { return {name,template:await client.inspectTemplate(name,'en_US')}; }
    catch (error) { return {name,code:error instanceof DocumentDeliveryError ? error.code : 'template_lookup_unavailable'}; }
  }));
}
