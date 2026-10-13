import type { SupabaseClient } from '@supabase/supabase-js';
import { DocumentDeliveryError } from './contracts';
import type { ClaimStore, DocumentJob } from './queue';

export class SupabaseDocumentClaims implements ClaimStore {
  constructor(private readonly db: SupabaseClient, private readonly accountId: string) {}
  async claim(job: DocumentJob, claimId: string) {
    if (job.accountId !== this.accountId) throw new DocumentDeliveryError('forbidden',403);
    const {data,error} = await this.db.from('messages').update({admin_document_claim_id:claimId})
      .eq('admin_document_account_id',this.accountId).eq('id',job.deliveryId)
      .eq('admin_document_fingerprint',job.fingerprint).eq('admin_document_state','reserved')
      .is('admin_document_claim_id',null).select('id').maybeSingle();
    if (error) throw new DocumentDeliveryError('document_storage_unavailable',503);
    return !!data;
  }
}
