import { describe, expect, test } from 'bun:test';
import {
  adoptNeoRefTarget,
  adoptOwnedNeoTarget,
  ownedLookupSessionId,
} from '../../../../src/lib/neo/operations.ts';

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

describe('adoptNeoRefTarget', () => {
  test('a Claude session id from work.find becomes a send to that session', () => {
    expect(adoptNeoRefTarget({ targetSessionId: 'local_bc37a8ae' })).toEqual({
      targetSessionId: undefined,
      work: { verb: 'send', ref: { adapter: 'claude-desktop', id: 'local_bc37a8ae' } },
    });
  });
  test('a HyperNeo session id, or a proposal that already names work, is left alone', () => {
    expect(adoptNeoRefTarget({ targetSessionId: 'project' })).toEqual({
      targetSessionId: 'project',
    });
    const work = { verb: 'send' as const, ref: { adapter: 'codex-desktop', id: 't1' } };
    expect(adoptNeoRefTarget({ targetSessionId: 'local_x', work })).toEqual({
      targetSessionId: 'local_x',
      work,
    });
  });
});
