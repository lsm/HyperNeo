import { describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { Session } from '@hyperneo/shared';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { createSetSessionParentOperation } from '../../../../src/lib/session/parent-operation.ts';

const session = (id: string, fields: Partial<Session> = {}) =>
  ({ id, status: 'active', parentSessionId: null, ...fields }) as Session;

function setup(sessions: Session[], spaceIds: Record<string, string> = {}) {
  const byId = new Map(sessions.map((item) => [item.id, item]));
  const setParent = vi.fn();
  const operation = createSetSessionParentOperation({
    getSession: (id) => byId.get(id) ?? null,
    listChildren: (id) => sessions.filter((item) => item.parentSessionId === id),
    sessionSpaceId: (item) => spaceIds[item.id],
    setParent,
  });
  const run = (input: { sessionId: string; parentSessionId: string | null }, source = 'rpc') =>
    operation.execute(input, { source } as OperationCaller);
  return { run, setParent };
}

describe('session.parent.set', () => {
  test('moves a top-level chat under another and back to the top level', async () => {
    const { run, setParent } = setup([session('a'), session('b')]);
    expect(await run({ sessionId: 'a', parentSessionId: 'b' })).toEqual({
      accepted: true,
      sessionId: 'a',
      parentSessionId: 'b',
    });
    expect(await run({ sessionId: 'a', parentSessionId: null })).toMatchObject({
      accepted: true,
      parentSessionId: null,
    });
    expect(setParent.mock.calls).toEqual([
      ['a', 'b'],
      ['a', null],
    ]);
  });

  test.each([
    ['caller_denied', { sessionId: 'a', parentSessionId: 'b' }, 'mcp'],
    ['session_not_found', { sessionId: 'missing', parentSessionId: 'b' }, 'rpc'],
    ['parent_not_found', { sessionId: 'a', parentSessionId: 'missing' }, 'rpc'],
    ['self_parent', { sessionId: 'a', parentSessionId: 'a' }, 'rpc'],
    ['parent_is_child', { sessionId: 'a', parentSessionId: 'child' }, 'rpc'],
    ['has_children', { sessionId: 'b', parentSessionId: 'a' }, 'rpc'],
    ['unsupported_session', { sessionId: 'neo:root', parentSessionId: 'a' }, 'rpc'],
    ['unsupported_session', { sessionId: 'a', parentSessionId: 'space-chat' }, 'rpc'],
  ] as const)('rejects %s', async (reason, input, source) => {
    const { run, setParent } = setup(
      [
        session('a'),
        session('b'),
        session('child', { parentSessionId: 'b' }),
        session('neo:root'),
        session('space-chat'),
      ],
      { 'space-chat': 'space-1' }
    );
    expect(await run(input, source)).toMatchObject({ accepted: false, reason });
    expect(setParent).not.toHaveBeenCalled();
  });
});
