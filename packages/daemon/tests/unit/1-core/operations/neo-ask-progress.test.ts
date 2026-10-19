import { describe, expect, test } from 'bun:test';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { neoAskProgressNote } from '../../../../src/lib/neo/ask-progress.ts';

const ask = {
  id: 'a1',
  title: 'Split the packs',
  status: 'open',
  doneItems: [
    { id: 'i1', text: 'Merged', state: 'met', removed: false },
    { id: 'i2', text: 'Deployed', state: 'pending', removed: false },
    { id: 'i3', text: 'Dropped', state: 'pending', removed: true },
  ],
} as unknown as NeoAsk;

const parts = (note: string) => ({
  head: note.slice(0, note.indexOf('\n')),
  data: JSON.parse(note.slice(note.indexOf('\n') + 1)) as Record<string, unknown>,
});

describe('neoAskProgressNote', () => {
  test.each(['an evidence note.', 'card w1 "Fix" is waiting on the user.'])(
    'one ask-progress shape for every source: %s',
    (what) => {
      const { head, data } = parts(neoAskProgressNote(ask, what, { cards: [] }));
      expect(head).toBe(`Ask progress on ask a1 "Split the packs": ${what}`);
      expect(data).toEqual({
        askId: 'a1',
        status: 'open',
        items: [
          { id: 'i1', state: 'met' },
          { id: 'i2', state: 'pending', text: 'Deployed' },
        ],
        cards: [],
      });
    }
  );

  test('carries what the source adds, and states facts with no command', () => {
    const note = neoAskProgressNote(ask, 'an evidence note.', { replacedBy: 'a2' });
    expect(parts(note).data.replacedBy).toBe('a2');
    expect(note).not.toMatch(/Tell the human|Decide now|Check each|Settle/);
  });

  test('a card with no ask reads as card progress, with only what the source adds', () => {
    const note = neoAskProgressNote(null, 'card w1 "Fix" is waiting on the user.', {
      card: { id: 'w1' },
    });
    expect(parts(note)).toEqual({
      head: 'Card progress: card w1 "Fix" is waiting on the user.',
      data: { card: { id: 'w1' } },
    });
  });
});
