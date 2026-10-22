import { describe, expect, test } from 'bun:test';
import { neoSnapshotRevision } from '../../../../src/lib/neo/operations.ts';

describe('neoSnapshotRevision', () => {
  const at = (checkedAt: number | null, label = 'Running') => ({
    ok: true,
    cards: [{ workId: 'w', label, checkedAt }],
  });

  test('a fresh check time alone keeps the rev, so a re-read still answers unchanged', () => {
    const first = neoSnapshotRevision(at(1), undefined, undefined);
    if (!('rev' in first)) throw new Error('expected a rev');
    expect(neoSnapshotRevision(at(2), first.rev, undefined)).toMatchObject({
      unchanged: true,
      note: expect.stringMatching(/another snapshot read does not wait for them\.$/),
    });
    expect(neoSnapshotRevision(at(2, 'Needs you'), first.rev, undefined)).not.toHaveProperty(
      'unchanged'
    );
  });
});
