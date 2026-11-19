import { describe, expect, test } from 'bun:test';
import { reviewedWorkerOwnership } from '../../../../src/lib/neo/worker-ownership-apply.ts';

describe('reviewedWorkerOwnership', () => {
  test('only selects reviewed, unclaimed start bindings without protected uses', () => {
    const ids = ['start', 'weak', 'claimed', 'live', 'send', 'adopt', 'bind', 'named', 'released'];
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
        live: id === 'live',
      }));
    const reviewed = ids.map((id) => ({ adapter: 'hyperneo', id }));
    expect(reviewedWorkerOwnership(rows, touches, reviewed)).toEqual({
      selected: [{ adapter: 'hyperneo', id: 'start' }],
      skipped: [
        { adapter: 'hyperneo', id: 'weak', reason: 'weak' },
        { adapter: 'hyperneo', id: 'claimed', reason: 'claimed' },
        { adapter: 'hyperneo', id: 'live', reason: 'live' },
      ],
      invalid: ['send', 'adopt', 'bind', 'named', 'released'].map((id) => ({
        adapter: 'hyperneo',
        id,
      })),
    });
  });
});
