import { describe, expect, test } from 'bun:test';
import { adoptOwnedNeoTarget, ownedLookupSessionId } from '../../../../src/lib/neo/operations.ts';

const ref = { adapter: 'space', id: 'task-1' };

describe('ownedLookupSessionId', () => {
  test.each([
    ['a bare target session', { targetSessionId: 's1' }, 's1'],
    ['no target session', {}, null],
    ['a target with explicit work', { targetSessionId: 's1', work: { verb: 'send', ref } }, null],
    ['a target with an agent', { targetSessionId: 's1', targetAgent: { id: 'a' } }, null],
  ] as const)('%s', (_label, input, expected) => {
    expect(ownedLookupSessionId(input as Parameters<typeof ownedLookupSessionId>[0])).toBe(
      expected
    );
  });
});

describe('adoptOwnedNeoTarget', () => {
  test('turns a bare target session into a send to the owning work', () => {
    const adopted = adoptOwnedNeoTarget<Parameters<typeof ownedLookupSessionId>[0]>(
      { targetSessionId: 's1' },
      { ref }
    );
    expect(adopted).toEqual({ targetSessionId: undefined, work: { verb: 'send', ref } });
  });

  test('leaves the input alone without an owner or with explicit work', () => {
    const input = { targetSessionId: 's1' };
    expect(adoptOwnedNeoTarget(input, { ref: null })).toBe(input);
    const explicit = { targetSessionId: 's1', work: { verb: 'send' as const, ref } };
    expect(adoptOwnedNeoTarget(explicit, { ref })).toBe(explicit);
  });
});
