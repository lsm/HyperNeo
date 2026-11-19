import { describe, expect, test } from 'bun:test';
import { reviewedWorkerOwnership } from '../../../../src/lib/neo/worker-ownership-apply.ts';

describe('reviewedWorkerOwnership', () => {
  test('only selects reviewed, unclaimed start bindings without protected uses', () => {
    const ids = ['start', 'weak', 'claimed', 'send', 'adopt', 'bind', 'named', 'released'];
    const rows = ids.map((id) => ({
      adapter: 'hyperneo',
      id,
      startedAt: 1,
      claimedBy: id === 'claimed' ? 'todo' : null,
      releasedAt: id === 'released' ? 2 : null,
      role: null,
    }));
    const touches = ids
      .filter((id) => id !== 'weak')
      .map((id) => ({
        adapter: 'hyperneo',
        id,
        verb: ['send', 'adopt', 'bind'].includes(id) ? id : 'start',
        humanNamed: id === 'named',
      }));
    const reviewed = ids.map((id) => ({ adapter: 'hyperneo', id }));
    expect(reviewedWorkerOwnership(rows, touches, reviewed)).toEqual([
      { adapter: 'hyperneo', id: 'start' },
    ]);
  });
});
