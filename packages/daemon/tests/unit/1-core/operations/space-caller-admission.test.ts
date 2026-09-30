import { describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { admitSpaceCaller } from '../../../../src/lib/operations/space-caller-admission';
import type { OperationCaller } from '../../../../src/lib/operations/registry';

const SPACE = 'space-1';
const OTHER_SPACE = 'space-2';

const readOnly = { readOnly: true };

function mcpCaller(overrides: Partial<OperationCaller> = {}): OperationCaller {
  return { source: 'mcp', sessionId: 'session-1', ...overrides };
}

function activeSession(spaceId: string): Session {
  return { id: 'session-1', status: 'active' } as Session;
}

describe('admitSpaceCaller — Neo', () => {
  test('names any Space it asks for', () => {
    const caller = mcpCaller({ role: 'neo' });

    expect(admitSpaceCaller(caller, SPACE, readOnly)).toEqual({ value: SPACE });
    expect(admitSpaceCaller(caller, OTHER_SPACE, readOnly)).toEqual({ value: OTHER_SPACE });
  });

  test('names a Space for a mutation without a session in it', () => {
    const caller = mcpCaller({ role: 'neo', spaceId: undefined });

    expect(admitSpaceCaller(caller, OTHER_SPACE, { readOnly: false })).toEqual({
      value: OTHER_SPACE,
    });
  });

  test('names a Space it has no session for at all', () => {
    const caller = mcpCaller({ role: 'neo', sessionId: undefined });

    expect(admitSpaceCaller(caller, OTHER_SPACE, { readOnly: false })).toEqual({
      value: OTHER_SPACE,
    });
  });

  test('still requires a Space to be named', () => {
    const caller = mcpCaller({ role: 'neo' });

    expect(admitSpaceCaller(caller, undefined, readOnly)).toEqual({
      reason: 'space_scope_required',
    });
  });
});

describe('admitSpaceCaller — scoped MCP callers are unchanged', () => {
  test('inherits its own Space when none is requested', () => {
    const caller = mcpCaller({ spaceId: SPACE, role: 'long_term_agent' });

    expect(admitSpaceCaller(caller, undefined, readOnly)).toEqual({ value: SPACE });
  });

  test('accepts a request for its own Space', () => {
    const caller = mcpCaller({ spaceId: SPACE, role: 'long_term_agent' });

    expect(admitSpaceCaller(caller, SPACE, readOnly)).toEqual({ value: SPACE });
  });

  test('rejects a request for another Space', () => {
    const caller = mcpCaller({ spaceId: SPACE, role: 'long_term_agent' });

    expect(admitSpaceCaller(caller, OTHER_SPACE, readOnly)).toEqual({ reason: 'space_mismatch' });
  });

  test('rejects a caller with no Space scope', () => {
    expect(admitSpaceCaller(mcpCaller({ role: 'universal_read' }), SPACE, readOnly)).toEqual({
      reason: 'space_scope_required',
    });
  });

  test('a mutation needs an active session inside the Space', () => {
    const caller = mcpCaller({ spaceId: SPACE, role: 'long_term_agent' });
    const admission = {
      readOnly: false,
      getSession: () => activeSession(SPACE),
      sessionSpaceId: (session: Session) => (session.status === 'active' ? SPACE : undefined),
    };

    expect(admitSpaceCaller(caller, SPACE, admission)).toEqual({ value: SPACE });
    expect(admitSpaceCaller(caller, SPACE, { ...admission, getSession: () => null })).toEqual({
      reason: 'denied',
    });
    expect(
      admitSpaceCaller(caller, SPACE, {
        readOnly: false,
        getSession: () => ({ id: 'session-1', status: 'ended' }) as Session,
        sessionSpaceId: () => SPACE,
      })
    ).toEqual({ reason: 'denied' });
    expect(
      admitSpaceCaller(caller, SPACE, {
        readOnly: false,
        getSession: () => activeSession(SPACE),
        sessionSpaceId: () => OTHER_SPACE,
      })
    ).toEqual({ reason: 'denied' });
  });
});

describe('admitSpaceCaller — non-MCP callers', () => {
  test('must name a Space', () => {
    const caller: OperationCaller = { source: 'rpc', principal: 'local' };

    expect(admitSpaceCaller(caller, SPACE, readOnly)).toEqual({ value: SPACE });
    expect(admitSpaceCaller(caller, undefined, readOnly)).toEqual({
      reason: 'space_scope_required',
    });
  });
});
