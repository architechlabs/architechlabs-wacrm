import { describe, expect, it } from 'vitest';
import { groupContactTags } from './contact-tags';

describe('groupContactTags', () => {
  it('hydrates contact tags without depending on the separate filter tag map', () => {
    expect(
      groupContactTags([
        {
          contact_id: 'contact-a',
          tag: { id: 'tag-a', name: 'Lead', color: '#123456' },
        },
        {
          contact_id: 'contact-a',
          tag: [{ id: 'tag-b', name: 'Priority', color: '#654321' }],
        },
        { contact_id: 'contact-b', tag: null },
      ])
    ).toEqual({
      'contact-a': [
        { id: 'tag-a', name: 'Lead', color: '#123456' },
        { id: 'tag-b', name: 'Priority', color: '#654321' },
      ],
    });
  });
});
