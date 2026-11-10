import { describe, expect, test } from 'bun:test';
import {
  PLAIN_SESSION_SCOPE,
  resolveCallerIdentity,
  type CallerScopeResolver,
} from '../../../../src/lib/operations/caller';

const scoped: CallerScopeResolver = (sessionId) =>
  sessionId === 'agent-1'
    ? { spaceId: 'space-1', role: 'workflow_worker', agentId: 'agent-id-1', agentName: 'coder' }
    : null;

describe('resolveCallerIdentity — agent door', () => {
  test('always carries the agent session id, even when no scope resolves', () => {
    expect(resolveCallerIdentity(PLAIN_SESSION_SCOPE, 'agent-9')).toEqual({
      sessionId: 'agent-9',
      role: 'universal_read',
    });
    expect(resolveCallerIdentity(scoped, 'agent-9')).toEqual({ sessionId: 'agent-9' });
  });

  test('merges resolved scope beside the session id', () => {
    expect(resolveCallerIdentity(scoped, 'agent-1')).toEqual({
      sessionId: 'agent-1',
      spaceId: 'space-1',
      role: 'workflow_worker',
      agentId: 'agent-id-1',
      agentName: 'coder',
    });
  });
});
