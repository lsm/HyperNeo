import { describe, expect, test } from 'bun:test';
import {
  NO_CALLER_SCOPE,
  resolveCallerIdentity,
  resolveTransportCallerIdentity,
  type CallerScopeResolver,
} from '../../../../src/lib/operations/caller';

const scoped: CallerScopeResolver = (sessionId) =>
  sessionId === 'agent-1'
    ? { spaceId: 'space-1', role: 'workflow_worker', agentId: 'agent-id-1', agentName: 'coder' }
    : null;

describe('resolveCallerIdentity — agent door', () => {
  test('always carries the agent session id, even when no scope resolves', () => {
    expect(resolveCallerIdentity(NO_CALLER_SCOPE, 'agent-9')).toEqual({ sessionId: 'agent-9' });
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

describe('resolveTransportCallerIdentity — human door', () => {
  test('carries nothing when the transport session has no scope', () => {
    expect(resolveTransportCallerIdentity(NO_CALLER_SCOPE, 'global')).toEqual({});
    expect(resolveTransportCallerIdentity(scoped, 'global')).toEqual({});
    expect(resolveTransportCallerIdentity(scoped, undefined)).toEqual({});
  });

  test('asserts the session id only when it resolves to a known scope', () => {
    expect(resolveTransportCallerIdentity(scoped, 'agent-1')).toEqual({
      sessionId: 'agent-1',
      spaceId: 'space-1',
      role: 'workflow_worker',
      agentId: 'agent-id-1',
      agentName: 'coder',
    });
  });
});
