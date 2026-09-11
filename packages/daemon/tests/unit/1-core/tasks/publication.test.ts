import { expect, test } from 'bun:test';
import { publishTask, requireDraftTask } from '../../../../src/lib/tasks/publication.ts';

test.each(['draft', 'open', 'done', 'cancelled', 'archived', undefined])(
  'publication admission for %s',
  async (status) => {
    expect(requireDraftTask(status)).toEqual(
      status === 'draft' ? { value: 'publish' } : { reason: 'not_draft' }
    );
    let publications = 0;
    const task = { status: 'open' };
    const result = await publishTask(
      async () => status,
      async () => {
        publications++;
        return task;
      }
    );
    expect(result).toBe(status === 'draft' ? task : 'not_draft');
    expect(publications).toBe(status === 'draft' ? 1 : 0);
  }
);
