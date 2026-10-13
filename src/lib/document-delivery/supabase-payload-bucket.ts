import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DocumentDeliveryError } from './contracts';
import { MAX_ENCRYPTED_PAYLOAD_BYTES, type PrivateBucket } from './queue-payloads';

export const DOCUMENT_PAYLOAD_BUCKET = 'admin-document-payloads';
const objectPath = /^admin-document-jobs\/v1\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f]{64}$/u;
const retentionMs = 24 * 60 * 60 * 1000;

/** Server-only temporary encrypted files in the existing Supabase project. */
export class SupabasePayloadBucket implements PrivateBucket {
  constructor(private readonly db: SupabaseClient) {}

  async verifyPrivate() {
    const { data, error } = await this.db.storage.getBucket(DOCUMENT_PAYLOAD_BUCKET);
    if (error || !data || data.public !== false ||
        Number(data.file_size_limit) !== MAX_ENCRYPTED_PAYLOAD_BYTES ||
        data.allowed_mime_types?.length !== 1 || data.allowed_mime_types[0] !== 'application/octet-stream') {
      throw new DocumentDeliveryError('document_queue_configuration_invalid', 503);
    }
  }

  private files() { return this.db.storage.from(DOCUMENT_PAYLOAD_BUCKET); }
  private checkPath(key: string) {
    if (!objectPath.test(key)) throw new DocumentDeliveryError('invalid_document_request', 400);
  }

  async put(key: string, value: Uint8Array, options: Parameters<PrivateBucket['put']>[2]) {
    this.checkPath(key);
    if (options.onlyIf.etagDoesNotMatch !== '*' || value.length > MAX_ENCRYPTED_PAYLOAD_BYTES) {
      throw new DocumentDeliveryError('invalid_document_request', 400);
    }
    const { data, error } = await this.files().upload(key, value, {
      upsert: false, contentType: 'application/octet-stream', cacheControl: '0',
      metadata: options.customMetadata,
    });
    if (error || !data) throw new DocumentDeliveryError('document_payload_unavailable', 503);
    return data;
  }

  async get(key: string) {
    this.checkPath(key);
    const { data, error } = await this.files().download(key);
    if (error || !data || data.size > MAX_ENCRYPTED_PAYLOAD_BYTES) {
      throw new DocumentDeliveryError('document_payload_unavailable', 503);
    }
    return { size: data.size, body: data.stream() };
  }

  async delete(key: string) {
    this.checkPath(key);
    const { error } = await this.files().remove([key]);
    if (error) throw new DocumentDeliveryError('document_payload_unavailable', 503);
  }

  // Called hourly through the private worker binding. Process oldest objects
  // first; a bounded batch leaves any backlog for the next scheduled run.
  async removeExpired(now = Date.now()) {
    const { data, error } = await this.files().listV2({
      prefix: 'admin-document-jobs/v1/', with_delimiter: false, limit: 100,
      sortBy: { column: 'created_at', order: 'asc' },
    });
    if (error || !data) throw new DocumentDeliveryError('document_payload_unavailable', 503);
    const paths = data.objects.filter(row => {
      const created = Date.parse(row.created_at);
      return Number.isFinite(created) && created <= now - retentionMs;
    }).map(row => row.key ?? row.name);
    for (const path of paths) this.checkPath(path);
    if (paths.length) {
      const { error: removeError } = await this.files().remove(paths);
      if (removeError) throw new DocumentDeliveryError('document_payload_unavailable', 503);
    }
    return paths.length;
  }
}

export async function privateSupabasePayloadBucket() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, {
      ...init, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(init?.signal ? [init.signal] : [])]),
    }) },
  });
  const bucket = new SupabasePayloadBucket(db);
  await bucket.verifyPrivate();
  return bucket;
}
