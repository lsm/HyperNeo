import { describe, expect, test } from 'bun:test';
import { requireNeoProjectSaveId } from '../../../../src/lib/neo/operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';

const caller: OperationCaller = { source: 'mcp', sessionId: 'root', role: 'neo' };

describe('requireNeoProjectSaveId', () => {
  test('a create omits the id, and an update names it', () => {
    expect(requireNeoProjectSaveId({ expectedRevision: 0 }, false, caller)).toEqual({
      value: caller,
    });
    expect(requireNeoProjectSaveId({ id: 'club', expectedRevision: 2 }, true, caller)).toEqual({
      value: caller,
    });
  });

  test('refuses a named create, a holder create and an update without an id', () => {
    for (const [input, holder, reason] of [
      [{ id: 'club', expectedRevision: 0 }, false, 'Omit id'],
      [{ expectedRevision: 0 }, true, 'own project'],
      [{ expectedRevision: 1 }, false, 'Pass the id'],
    ] as const)
      expect(requireNeoProjectSaveId(input, holder, caller)).toEqual({
        reason: { ok: false, reason: expect.stringContaining(reason) },
      });
  });
});
