import { describe, expect, test } from 'bun:test';
import type { Session, SpaceTask } from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { DirectTaskAttempt } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  classifyStopTarget,
  requireStopProofRecorded,
  requireStopSessionOrProof,
  requireStopWorkerIdentity,
  requireVerifiableStopTarget,
  requiresLiveStopProof,
} from '../../../../src/lib/tasks/stop-direct-attempt';

type State = Parameters<typeof classifyStopTarget>[0];
const attempt = (extra: Partial<DirectTaskAttempt> = {}) =>
  ({
    id: 'a1',
    taskId: 't1',
    sessionId: 'w',
    generation: 2,
    phase: 'running',
    ...extra,
  }) as DirectTaskAttempt;
const state = (extra: Partial<State> = {}): State => ({
  current: attempt(),
  stopRequested: true,
  recorded: null,
  loading: false,
  ...extra,
});
const unavailable = { reason: { stopped: false as const, reason: 'unavailable' as const } };
const unverified = { reason: { stopped: false as const, reason: 'unverified' as const } };

describe('requiresLiveStopProof', () => {
  test.each([
    ['a reserved attempt', attempt({ phase: 'reserved' }), null, false],
    ['a running attempt without proof', attempt(), null, true],
    ['proof from another generation', attempt(), { token: 'p', generation: 1 }, true],
    ['proof without a token', attempt(), { token: null, generation: 2 }, true],
    ['proof for this generation', attempt(), { token: 'p', generation: 2 }, false],
  ] as const)('%s', (_label, target, recorded, expected) => {
    expect(requiresLiveStopProof(target, recorded)).toBe(expected);
  });
});

describe('classifyStopTarget', () => {
  test.each([
    ['a missing attempt', state({ current: null }), 'unavailable'],
    ['another session', state({ current: attempt({ sessionId: 'x' }) }), 'unavailable'],
    ['another generation', state({ current: attempt({ generation: 3 }) }), 'unavailable'],
    ['a stopped attempt', state({ current: attempt({ phase: 'stopped' }) }), 'unavailable'],
    ['no stop request', state({ stopRequested: false }), 'unavailable'],
    ['a loading session', state({ loading: true }), 'loading'],
    ['a stop to verify', state(), 'verifiable'],
  ] as const)('%s → %s', (_label, current, expected) => {
    expect(classifyStopTarget(current, attempt())).toBe(expected);
  });
});

describe('requireVerifiableStopTarget', () => {
  test('rejects unavailable targets, defers loading ones and admits the current attempt', () => {
    const current = state();
    expect(requireVerifiableStopTarget('unavailable', current)).toEqual(unavailable);
    expect(requireVerifiableStopTarget('verifiable', state({ current: null }))).toEqual(
      unavailable
    );
    expect(requireVerifiableStopTarget('loading', current)).toEqual(unverified);
    expect(requireVerifiableStopTarget('verifiable', current)).toEqual({
      value: current.current!,
    });
  });
});

describe('requireStopSessionOrProof', () => {
  test('needs a live session only when live proof is required', () => {
    const current = attempt();
    const session = {} as AgentSession;
    expect(requireStopSessionOrProof(null, true, current)).toEqual(unverified);
    expect(requireStopSessionOrProof(null, false, current)).toEqual({ value: current });
    expect(requireStopSessionOrProof(session, true, current)).toEqual({ value: current });
  });
});

describe('requireStopWorkerIdentity', () => {
  const current = attempt();
  const evidence = (extra: { attempt?: DirectTaskAttempt; session?: Partial<Session> } = {}) => ({
    session: {
      id: 'w',
      type: 'worker',
      status: 'active',
      context: { taskId: 't1', spaceId: 's1' },
      ...extra.session,
    } as Session,
    task: { id: 't1', spaceId: 's1', taskAgentSessionId: 'w' } as SpaceTask,
    attempt: extra.attempt ?? current,
  });

  test('admits a stop without a session to prove', () => {
    expect(requireStopWorkerIdentity(null, current)).toEqual({ value: current });
  });

  test('admits the attempt worker and rejects a foreign session or attempt', () => {
    expect(requireStopWorkerIdentity(evidence(), current)).toEqual({ value: current });
    expect(
      requireStopWorkerIdentity(evidence({ attempt: attempt({ id: 'a2' }) }), current)
    ).toEqual(unverified);
    expect(
      requireStopWorkerIdentity(
        evidence({ session: { context: { taskId: 'other', spaceId: 's1' } } }),
        current
      )
    ).toEqual(unverified);
  });
});

describe('requireStopProofRecorded', () => {
  test('passes the token once its proof is recorded and refuses a lost one', () => {
    const plan = { token: 'p', record: true };
    expect(requireStopProofRecorded(plan, 'recorded')).toEqual({ value: 'p' });
    expect(requireStopProofRecorded(plan, 'lost')).toEqual(unavailable);
  });
});
