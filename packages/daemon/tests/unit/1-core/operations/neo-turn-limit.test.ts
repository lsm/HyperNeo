import { describe, expect, test } from 'bun:test';
import { neoTurnLimitNote, planNeoTurnLimitNote } from '../../../../src/lib/neo/turn-limit.ts';

const result = (uuid: string, subtype: string, timestamp: string) => ({ uuid, subtype, timestamp });

describe('planNeoTurnLimitNote', () => {
  const cut = [
    result('r2', 'error_max_turns', '2026-10-12T15:02:06.000Z'),
    result('r1', 'success', '2026-10-12T14:56:50.000Z'),
  ];

  test('plans one note for a turn that hit its limit, over the window since the previous turn', () => {
    expect(planNeoTurnLimitNote(cut, () => false)).toEqual({
      resultUuid: 'r2',
      since: Date.parse('2026-10-12T14:56:50.000Z'),
      until: Date.parse('2026-10-12T15:02:06.000Z'),
    });
  });

  test('stays quiet for a finished turn, a first turn, or a cut-off turn its own note started', () => {
    expect(planNeoTurnLimitNote([result('r2', 'success', cut[0].timestamp)], () => false)).toBe(
      null
    );
    expect(planNeoTurnLimitNote([cut[0]], () => false)).toBe(null);
    expect(planNeoTurnLimitNote(cut, () => true)).toBe(null);
  });
});

describe('neoTurnLimitNote', () => {
  test('lists what the cut-off turn created so it is continued, not reopened', () => {
    const note = neoTurnLimitNote(
      [{ id: 'da9506d1', title: 'Fix settle-path', requestKey: 'root:guard', status: 'open' }],
      [{ id: 'w1', title: 'Guard it', requestKey: 'root:guard-card', status: 'proposed' }]
    );
    expect(note).toContain('- ask da9506d1 "Fix settle-path" (open, requestKey root:guard)');
    expect(note).toContain('- card w1 "Guard it" (proposed, requestKey root:guard-card)');
    expect(note).toContain('never open or propose them again under a new requestKey');
  });
});
