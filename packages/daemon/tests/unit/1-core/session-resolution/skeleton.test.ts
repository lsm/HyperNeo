import { describe, expect, test } from 'bun:test';
import { coordinatorSessionId } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session';
import type { SessionResolutionDeps } from '../../../../src/lib/session-resolution/deps';
import { ensureAgentSession } from '../../../../src/lib/session-resolution/ensure-agent-session';
import { ensureSession } from '../../../../src/lib/session-resolution/ensure-session';
import { ensureWorkerSession } from '../../../../src/lib/session-resolution/ensure-worker-session';
import { findSessionForTarget } from '../../../../src/lib/session-resolution/find-session-for-target';
import {
  agentSessionIdOf,
  type FindTarget,
  type SessionTarget,
  type SessionTargetAgent,
  type SessionTargetWorker,
} from '../../../../src/lib/session-resolution/target';

const deps = {} as SessionResolutionDeps;

describe('session-resolution skeleton stubs', () => {
  test('findSessionForTarget throws its exact message', () => {
    const target: FindTarget = { kind: 'session', sessionId: 'sess-1' };
    expect(() => findSessionForTarget(target, deps)).toThrow(
      'session-resolution: findSessionForTarget not implemented'
    );
  });

  test('ensureAgentSession throws its exact message', () => {
    const target: SessionTargetAgent = { kind: 'agent', spaceId: 'sp-1', agentId: 'ag-1' };
    expect(() => ensureAgentSession(target, deps)).toThrow(
      'session-resolution: ensureAgentSession not implemented'
    );
  });

  test('ensureWorkerSession throws its exact message', () => {
    const target: SessionTargetWorker = { kind: 'worker', taskId: 'task-1', agentName: 'devin' };
    expect(() => ensureWorkerSession(target, deps)).toThrow(
      'session-resolution: ensureWorkerSession not implemented'
    );
  });

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

  test('non-coordinator agentId reuses longTermAgentSessionId', () => {
    const spaceId = 'space-1';
    const agentId = 'agent-1';
    expect(agentSessionIdOf(spaceId, agentId)).toBe(longTermAgentSessionId(spaceId, agentId));
  });
});
