import { describe, expect, test } from 'bun:test';
import { readRecordableTurns } from '../../../../src/lib/neo/turn-recording.ts';

const completed = (value: unknown) => ({ kind: 'completed' as const, value });

describe('readRecordableTurns', () => {
  test('an adapter with no turn reader has nothing to record', () => {
    expect(
      readRecordableTurns(completed({ ok: false, reason: 'unsupported', detail: 'No.' }))
    ).toEqual([]);
  });

  test('a failed read is reported, not taken for an empty page', () => {
    expect(() =>
      readRecordableTurns(completed({ ok: false, reason: 'unreachable', detail: 'Down.' }))
    ).toThrow('unreachable: Down.');
    expect(() =>
      readRecordableTurns({ kind: 'failed', code: 'execution_failed', message: 'Bad row.' })
    ).toThrow('Bad row.');
  });
});
