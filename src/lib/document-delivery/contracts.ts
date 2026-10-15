import { createHash } from 'node:crypto';

export const MAX_DOCUMENT_BYTES = 3_000_000;
export const MAX_REQUEST_BYTES = 4_030_000;
export const DOCUMENT_KINDS = ['quotation', 'proforma', 'tax'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const FIELD_NAMES = ['customerName', 'documentNumber', 'documentDate', 'project', 'amount', 'validUntil', 'orderReference'] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export class DocumentDeliveryError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
  }
}
export interface DocumentPolicy {
  kind: DocumentKind;
  name: string;
  language: string;
  metaTemplateId: string;
  bodyText: string;
  fields: FieldName[];
}
export interface DocumentInput {
  kind: DocumentKind;
  documentNumber: string;
  to: string;
  consentConfirmed: true;
  paymentReceivedConfirmed?: true;
  fields: Partial<Record<FieldName, string>>;
  pdfBase64: string;
  revision?: number;
}
export interface PreparedDocument extends DocumentInput {
  pdf: Buffer;
  pdfSha256: string;
  filename: string;
  key: string;
  fingerprint: string;
  parameters: string[];
  renderedBody: string;
}

// Exact snapshots and explicit variable maps, never guessed from sample values.
// Missing or malformed configuration fails closed; disabled mode reads nothing else.
export function documentConfiguration(env: Record<string,string|undefined> = process.env): { accountId: string; policies: DocumentPolicy[] } | null {
  if (env.ENABLE_ADMIN_DOCUMENT_DELIVERY !== 'true') return null;
  try {
    const accountId = env.ADMIN_DOCUMENT_DELIVERY_ACCOUNT_ID ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId)) throw new Error();
    const policies: unknown = JSON.parse(env.ADMIN_DOCUMENT_DELIVERY_TEMPLATES ?? '');
    if (!Array.isArray(policies) || !policies.length || policies.length > 3) throw new Error();
    const kinds = new Set<string>();
    for (const raw of policies) {
      if (!raw || typeof raw !== 'object') throw new Error();
      const p = raw as DocumentPolicy;
      if (Object.keys(p).some(k => !['kind', 'name', 'language', 'metaTemplateId', 'bodyText', 'fields'].includes(k)) ||
          !DOCUMENT_KINDS.includes(p.kind) || kinds.has(p.kind) || !/^[a-z0-9_]{1,100}$/.test(p.name) ||
          !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(p.language) || !/^\d{1,40}$/.test(p.metaTemplateId) ||
          typeof p.bodyText !== 'string' || p.bodyText.length > 4096 || !Array.isArray(p.fields) ||
          p.fields.length > 10 || p.fields.some(f => !FIELD_NAMES.includes(f)) || new Set(p.fields).size !== p.fields.length) throw new Error();
      const indices = [...new Set([...p.bodyText.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a,b) => a-b);
      if (!p.fields.length || indices.length !== p.fields.length || indices.some((n, i) => n !== i+1) ||
          /\{\{(?!\d+\}\})/.test(p.bodyText) || !p.fields.includes('customerName') || !p.fields.includes('documentNumber')) throw new Error();
      // Require document-specific wording. Tax delivery is NOT proof of payment.
      if (p.kind === 'quotation' && (!/quotation/i.test(p.bodyText) || /tax invoice|proforma/i.test(p.bodyText))) throw new Error();
      if (p.kind === 'proforma' && !/proforma invoice/i.test(p.bodyText)) throw new Error();
      if (p.kind === 'tax' && (!/tax invoice/i.test(p.bodyText) || /proforma/i.test(p.bodyText))) throw new Error();
      kinds.add(p.kind);
    }
    return { accountId, policies: policies as DocumentPolicy[] };
  } catch {
    throw new DocumentDeliveryError('document_configuration_invalid', 503);
  }
}

// A manual invoice does not prove payment. Keep the approved wording, but require
// an explicit operator attestation for any tax template containing payment claims.
export function requiresPaymentConfirmation(policy: Pick<DocumentPolicy, 'kind' | 'bodyText'>): boolean {
  return policy.kind === 'tax' && /payment|paid|receipt|received|settled/i.test(policy.bodyText);
}

export function prepareDocument(value: unknown, policy: DocumentPolicy): PreparedDocument {
  const fail = () => { throw new DocumentDeliveryError('invalid_document_request', 400); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as DocumentInput;
  if (Object.keys(input).some(k => !['kind','documentNumber','to','consentConfirmed','paymentReceivedConfirmed','fields','pdfBase64','revision'].includes(k)) ||
      input.kind !== policy.kind || input.consentConfirmed !== true || !/^\+[1-9]\d{6,14}$/.test(input.to ?? '') ||
      (input.paymentReceivedConfirmed !== undefined && input.paymentReceivedConfirmed !== true) ||
      (requiresPaymentConfirmation(policy) && input.paymentReceivedConfirmed !== true) ||
      (input.kind === 'quotation' ? !Number.isSafeInteger(input.revision) || input.revision! < 1 || input.revision! > 2147483647 : input.revision !== undefined) ||
      typeof input.documentNumber !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,39}$/.test(input.documentNumber) ||
      !input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields) ||
      Object.keys(input.fields).some(k => !policy.fields.includes(k as FieldName)) ||
      policy.fields.some(f => typeof input.fields[f] !== 'string' || !input.fields[f]?.trim() || input.fields[f]!.length > 300 || /[\u0000-\u001f\u007f]/.test(input.fields[f]!)) ||
      input.fields.documentNumber !== input.documentNumber) return fail();
  if (typeof input.pdfBase64 !== 'string' || input.pdfBase64.length > Math.ceil(MAX_DOCUMENT_BYTES/3)*4 ||
      input.pdfBase64.length % 4 || /[^A-Za-z0-9+/=]/.test(input.pdfBase64)) return fail();
  const pdf = Buffer.from(input.pdfBase64, 'base64');
  if (pdf.length < 8 || pdf.length > MAX_DOCUMENT_BYTES || pdf.toString('base64') !== input.pdfBase64 || pdf.toString('ascii',0,5) !== '%PDF-') return fail();
  const parameters = policy.fields.map(f => input.fields[f]!);
  const pdfSha256 = sha256(pdf);
  const key = sha256(JSON.stringify([input.kind, input.documentNumber.toUpperCase(), input.to, input.revision ?? null]));
  const fingerprintParts: unknown[] = [input.kind, input.documentNumber, input.to, input.revision ?? null, pdfSha256, policy, parameters];
  // Preserve existing fingerprints for every previously supported document.
  if (requiresPaymentConfirmation(policy)) fingerprintParts.push({paymentReceivedConfirmed:true});
  const fingerprint = sha256(JSON.stringify(fingerprintParts));
  const filename = `${input.documentNumber.replace(/[^A-Za-z0-9-]/g,'-')}-${input.kind}.pdf`;
  const renderedBody = policy.bodyText.replace(/\{\{(\d+)\}\}/g, (_, n: string) => parameters[Number(n)-1]);
  return { ...input, pdf, pdfSha256, key, fingerprint, filename, parameters, renderedBody };
}
