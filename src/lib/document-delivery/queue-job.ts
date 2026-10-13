import { DocumentDeliveryError } from './contracts';

// Kept separate from PDF parsing/encryption so the metadata-only consumer Worker
// does not bundle the PDF engine or require access to document storage.
export const JOB_TTL_MS = 60 * 60 * 1000;
export interface DocumentJob {
  version: 1;
  accountId: string;
  deliveryId: string;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function parseDocumentJob(value: unknown): DocumentJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DocumentDeliveryError('invalid_document_job',400);
  const j = value as DocumentJob;
  if (Object.keys(j).length !== 6 || Object.keys(j).some(k => !['version','accountId','deliveryId','fingerprint','createdAt','expiresAt'].includes(k)) ||
      j.version !== 1 || !uuid.test(j.accountId) || !uuid.test(j.deliveryId) || !/^[0-9a-f]{64}$/u.test(j.fingerprint) ||
      !Number.isSafeInteger(j.createdAt) || j.createdAt < 0 || !Number.isSafeInteger(j.expiresAt) || j.expiresAt - j.createdAt !== JOB_TTL_MS) {
    throw new DocumentDeliveryError('invalid_document_job',400);
  }
  return j;
}
export function documentObjectKey(job: DocumentJob) {
  parseDocumentJob(job);
  return `admin-document-jobs/v1/${job.accountId}/${job.deliveryId}/${job.fingerprint}`;
}
