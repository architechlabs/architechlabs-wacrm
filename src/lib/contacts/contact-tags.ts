import type { Tag } from '@/types';

export type ContactTagSummary = Pick<Tag, 'id' | 'name' | 'color'>;

export interface ContactTagSummaryRow {
  contact_id: string;
  tag: ContactTagSummary | ContactTagSummary[] | null;
}

/** Groups the nested contact_tags -> tags projection for list rendering. */
export function groupContactTags(
  rows: readonly ContactTagSummaryRow[] | null
): Record<string, ContactTagSummary[]> {
  const grouped: Record<string, ContactTagSummary[]> = {};

  for (const row of rows ?? []) {
    const tag = Array.isArray(row.tag) ? row.tag[0] : row.tag;
    if (!tag) continue;
    (grouped[row.contact_id] ??= []).push(tag);
  }

  return grouped;
}
