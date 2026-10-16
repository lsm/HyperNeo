import { describe, expect, test } from 'bun:test';
import {
  neoControlFailure,
  neoControlFailureForRef,
} from '../../../../src/lib/neo/control-failure';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke';

const completed = (value: unknown): OperationOutcome => ({ kind: 'completed', value });
const ref = { adapter: 'claude-desktop', id: 'local_one' };
const row = {
  workId: 'w1',
  ref,
  operation: 'stop' as const,
  reason: 'unsupported' as const,
  detail: 'Open Desktop.',
  at: 1,
};

describe('neoControlFailure', () => {
  test.each(['stop', 'withdraw'] as const)(
    'requires an explicit successful %s result',
    (operation) => {
      const key = operation === 'stop' ? 'stopped' : 'withdrawn';
      expect(
        neoControlFailure(operation, completed({ ok: true, value: { [key]: true } }), 5)
      ).toBeNull();
      expect(
        neoControlFailure(operation, completed({ ok: true, value: { [key]: false } }), 5)
      ).toMatchObject({ operation, reason: 'unavailable', at: 5 });
      expect(neoControlFailure(operation, completed({ ok: true, value: {} }), 5)).not.toBeNull();
    }
  );
  test('preserves unsupported separately from an unavailable control channel', () => {
    for (const reason of ['unsupported', 'unreachable', 'busy']) {
      expect(
        neoControlFailure('stop', completed({ ok: false, reason, detail: 'Cannot stop.' }), 5)
      ).toEqual({
        operation: 'stop',
        reason: reason === 'unsupported' ? 'unsupported' : 'unavailable',
        detail: 'Cannot stop.',
        at: 5,
      });
    }
  });
  test('never interprets a failed or malformed operation as stopped', () => {
    expect(
      neoControlFailure(
        'stop',
        { kind: 'failed', code: 'execution_failed', message: 'Connection lost.' },
        5
      )
    ).toMatchObject({ reason: 'unavailable', detail: 'Connection lost.' });
    for (const value of [null, { stopped: true }, { ok: true, value: { stopped: 'true' } }]) {
      expect(neoControlFailure('stop', completed(value), 5)).toMatchObject({
        reason: 'unavailable',
      });
    }
  });
});

describe('neoControlFailureForRef', () => {
  test('returns only a fact about this card and exact current execution target', () => {
    expect(neoControlFailureForRef([row], 'w1', ref)).toEqual({
      operation: 'stop',
      reason: 'unsupported',
      detail: row.detail,
      at: 1,
    });
    for (const target of [
      null,
      { ...ref, id: 'replacement' },
      { ...ref, adapter: 'codex-desktop' },
      { ...ref, daemon: 'remote' },
    ]) {
      expect(neoControlFailureForRef([row], 'w1', target)).toBeNull();
    }
    expect(neoControlFailureForRef([row], 'other', ref)).toBeNull();
  });
  test('uses the most recent applicable failure without mutating its input', () => {
    const newer = { ...row, operation: 'withdraw' as const, at: 2 };
    const rows = [row, newer];
    expect(neoControlFailureForRef(rows, 'w1', ref)?.operation).toBe('withdraw');
    expect(rows).toEqual([row, newer]);
  });
});
