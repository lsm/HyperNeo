import { describe, expect, test } from 'bun:test';
import type { SessionResolutionDeps } from '../../../../src/lib/session-resolution/deps';
import { ensureSession } from '../../../../src/lib/session-resolution/ensure-session';
import {
  agentSessionIdOf,
  type FindTarget,
  type SessionTarget,
} from '../../../../src/lib/session-resolution/target';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session';
import {
  coordinatorLongHorizonAgentId,
  coordinatorSessionId,
} from '../../../../src/storage/repositories/space-long-horizon-agent-repository';

const deps = {} as SessionResolutionDeps;

describe('session-resolution skeleton stubs', () => {
  test('ensureSession throws its exact message', () => {
    const target: SessionTarget = { kind: 'session', sessionId: 'sess-1' };
    expect(() => ensureSession(target, deps)).toThrow(
      'session-resolution: ensureSession not implemented'
    );
  });
});

describe('session-resolution type assignment tests', () => {
  test('new types accept their literal shapes', () => {
    const sessionTarget: SessionTarget = { kind: 'session', sessionId: 's' };
    const agentTarget: SessionTarget = { kind: 'agent', spaceId: 'sp', agentId: 'ag' };
    const workerTarget: SessionTarget = { kind: 'worker', taskId: 't', agentName: 'a' };
    const findTarget: FindTarget = { kind: 'agent', spaceId: 'sp', agentId: 'ag' };

    expect([sessionTarget, agentTarget, workerTarget, findTarget]).toHaveLength(4);
  });
});

describe('agentSessionIdOf', () => {
  test('coordinator agentId reuses coordinatorSessionId', () => {
    const spaceId = 'space-1';
    expect(agentSessionIdOf(spaceId, 'coordinator')).toBe(coordinatorSessionId(spaceId));
  });

  test('coordinator long-horizon agentId reuses coordinatorSessionId', () => {
    const spaceId = 'space-1';
    expect(agentSessionIdOf(spaceId, coordinatorLongHorizonAgentId(spaceId))).toBe(
      coordinatorSessionId(spaceId)
    );
  });

  test('non-coordinator agentId reuses longTermAgentSessionId', () => {
    const spaceId = 'space-1';
    const agentId = 'agent-1';
    expect(agentSessionIdOf(spaceId, agentId)).toBe(longTermAgentSessionId(spaceId, agentId));
  });

  test('noncanonical coordinator agentId reuses coordinatorSessionId', () => {
    const spaceId = 'space-1';
    const agentId = 'coordinator-alt';
    expect(agentSessionIdOf(spaceId, agentId, agentId)).toBe(coordinatorSessionId(spaceId));
  });
});
