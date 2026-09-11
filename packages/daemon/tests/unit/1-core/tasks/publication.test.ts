import { expect, test } from 'bun:test';
import { decideTaskPublication, requireDraftTask } from '../../../../src/lib/tasks/publication.ts';

test.each(['draft', 'open', 'done', 'cancelled', 'archived', undefined])(
  'publication admission for %s',
  (status) => {
    expect(requireDraftTask(status)).toEqual(
      status === 'draft' ? { value: 'publish' } : { reason: 'not_draft' }
    );
    expect(decideTaskPublication(status)).toBe(status === 'draft' ? 'publish' : 'not_draft');
  }
);
