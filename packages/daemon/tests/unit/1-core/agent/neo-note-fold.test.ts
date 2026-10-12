import { describe, expect, test } from 'bun:test';
import { isNeoFoldableNote } from '../../../../src/lib/neo/ask-origin';
import {
  NEO_NOTE_FOLD_LIMIT,
  NEO_NOTE_FOLD_SEPARATOR,
  planNeoNoteFold,
} from '../../../../src/lib/agent/neo-note-fold';

const note = (uuid: string, key: string | null = 'ask-a', content = `note ${uuid}`) => ({
  uuid,
  content,
  system: true,
  key,
});

describe('planNeoNoteFold', () => {
  test('folds the pending notes for the same ask into the head note, in queue order', () => {
    expect(planNeoNoteFold(note('n1'), [note('n1'), note('n2'), note('n3')])).toEqual({
      content: ['note n1', 'note n2', 'note n3'].join(NEO_NOTE_FOLD_SEPARATOR),
      uuids: ['n1', 'n2', 'n3'],
    });
  });

  test('leaves human messages, notes for other asks and non-text notes for their own turns', () => {
    expect(
      planNeoNoteFold(note('n1'), [
        { ...note('h1'), system: false },
        note('n2', 'ask-b'),
        { ...note('n3'), content: [{ type: 'text', text: 'blocks' }] },
        note('n4'),
      ])
    ).toEqual({
      content: ['note n1', 'note n4'].join(NEO_NOTE_FOLD_SEPARATOR),
      uuids: ['n1', 'n4'],
    });
    expect(planNeoNoteFold(note('n1', null), [note('n2', null), note('n3')]).uuids).toEqual([
      'n1',
      'n2',
    ]);
  });

  test('folds a note queued twice only once', () => {
    expect(planNeoNoteFold(note('n1'), [note('n2'), note('n2'), note('n1')]).uuids).toEqual([
      'n1',
      'n2',
    ]);
  });

  test('never folds into a human message, and caps one fold', () => {
    const human = { ...note('h1'), system: false, content: 'hi' };
    expect(planNeoNoteFold(human, [note('n1')])).toEqual({ content: 'hi', uuids: ['h1'] });
    const many = Array.from({ length: 20 }, (_, index) => note(`n${index + 2}`));
    expect(planNeoNoteFold(note('n1'), many).uuids).toHaveLength(NEO_NOTE_FOLD_LIMIT);
  });
});

describe('isNeoFoldableNote', () => {
  test.each([
    ['neo-ask-evidence:a1:x', true],
    ['w1:stall:1700', true],
    ['w1:needs-you:1700', true],
    ['neo-session-notices:1:k', true],
    ['neo-card-pr:w1:abc', true],
    ['neo-nudge:m1', false],
    ['neo-consult:c1:request', false],
    ['neo-forward:m1:0', false],
    ['neo-ask-answer:a1:i1:5', false],
    ['w1:return', false],
  ])('%s folds: %s', (id, foldable) => {
    expect(isNeoFoldableNote(id)).toBe(foldable);
  });
});
