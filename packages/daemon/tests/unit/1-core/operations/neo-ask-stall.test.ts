import { describe, expect, test } from 'bun:test';
import { NEO_ASK_STALLED } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  NEO_ASK_STALL_QUIET_MS,
  neoAskStalledNote,
  requireNeoAskStalled,
  requireNeoAskStallUntold,
} from '../../../../src/lib/neo/ask-stall.ts';

const now = 10 * NEO_ASK_STALL_QUIET_MS;
const old = now - 2 * NEO_ASK_STALL_QUIET_MS;
const card = (id: string, status: NeoWork['status'], updatedAt = old) => ({
  id,
  title: `Card ${id}`,
  status,
  updatedAt,
});
const open = { status: 'open' as const, updatedAt: old };

describe('requireNeoAskStalled', () => {
  test.each<
    [
      string,
      typeof open | { status: 'waiting'; updatedAt: number },
      ReturnType<typeof card>[],
      boolean,
      string,
    ]
  >([
    [
      'an open ask whose cards all failed or were cancelled long ago',
      open,
      [card('a', 'failed'), card('b', 'cancelled')],
      true,
      'stalled:a:failed,b:cancelled',
    ],
    [
      'one with a card still queued',
      open,
      [card('a', 'failed'), card('b', 'queued')],
      true,
      'running',
    ],
    ['one with a reported card', open, [card('a', 'reported')], true, 'running'],
    [
      'one whose last card changed recently',
      open,
      [card('a', 'failed', now - 60_000)],
      true,
      'recent',
    ],
    ['one with no cards yet', open, [], true, 'no_cards'],
    [
      'one waiting on the human',
      { status: 'waiting', updatedAt: old },
      [card('a', 'failed')],
      true,
      'not_open',
    ],
    ['one whose Neo session is gone', open, [card('a', 'failed')], false, 'no_session'],
  ])('%s', (_label, ask, cards, session, expected) => {
    const result = requireNeoAskStalled(ask, { cards, session }, now);
    expect('value' in result ? result.value : result.reason).toBe(expected);
  });
});

describe('requireNeoAskStallUntold', () => {
  test('passes only a note Neo has not had yet', () => {
    expect(requireNeoAskStallUntold(false)).toEqual({ value: true });
    expect(requireNeoAskStallUntold(true)).toEqual({ reason: 'told' });
  });
});

describe('neoAskStalledNote', () => {
  test('names the ask, its cards, and the ask that carries the work on', () => {
    const note = neoAskStalledNote(
      { id: 'ask-1', title: 'Split the packs' },
      [card('a', 'failed')],
      'ask-2'
    );
    expect(note.startsWith(NEO_ASK_STALLED)).toBe(true);
    expect(JSON.parse(note.slice(NEO_ASK_STALLED.length + 1))).toEqual({
      askId: 'ask-1',
      title: 'Split the packs',
      cards: [{ id: 'a', title: 'Card a', status: 'failed' }],
      replacedBy: 'ask-2',
    });
    const bare = neoAskStalledNote({ id: 'ask-1', title: 'T' }, [], null);
    expect(JSON.parse(bare.slice(NEO_ASK_STALLED.length + 1))).not.toHaveProperty('replacedBy');
  });
});
