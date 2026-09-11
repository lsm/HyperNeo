import { matchesDirectPreparedSession } from './prepare-direct-session.ts';
import { resolveTaskWorkspace } from './spawn-slot-resolution.ts';
import type { Space } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import {
  loadDirectTaskWorkerEvidence,
  requireDirectTaskWorkerIdentity,
  type DirectTaskWorkerEvidence,
  type DirectTaskWorkerIdentity,
  type DirectTaskWorkerLookups,
} from './direct-task-worker-identity.ts';

export interface DirectTaskQueryAdmissionInput {
  sessionId: string;
  attemptId: string;
  generation: number;
}
export interface DirectTaskQueryLookups extends DirectTaskWorkerLookups {
  getSpace: (spaceId: string) => Space | null;
  isStopRequested: (attemptId: string, sessionId: string) => boolean;
}
export interface DirectTaskQueryState {
  space: Space | null;
  stopRequested: boolean;
}

function directQuerySessionId(input: DirectTaskQueryAdmissionInput): string {
  return input.sessionId;
}

function loadDirectTaskQueryState(
  identity: DirectTaskWorkerIdentity,
  getSpace: DirectTaskQueryLookups['getSpace'],
  isStopRequested: DirectTaskQueryLookups['isStopRequested']
): DirectTaskQueryState {
  return {
    space: getSpace(identity.spaceId),
    stopRequested: isStopRequested(identity.attemptId, identity.sessionId),
  };
}

export function requireRunningDirectTaskQuery(
  input: DirectTaskQueryAdmissionInput,
  identity: DirectTaskWorkerIdentity,
  evidence: DirectTaskWorkerEvidence,
  state: DirectTaskQueryState
): { value: DirectTaskWorkerIdentity } | { reason: null } {
  if (
    identity.sessionId !== input.sessionId ||
    identity.attemptId !== input.attemptId ||
    identity.generation !== input.generation ||
    identity.phase !== 'running' ||
    evidence.task?.status !== 'in_progress' ||
    evidence.task.archivedAt != null ||
    evidence.task.taskAgentSessionId !== input.sessionId ||
    state.space?.id !== identity.spaceId ||
    state.space.status !== 'active' ||
    state.space.paused ||
    state.space.stopped ||
    !evidence.session ||
    !evidence.attempt ||
    !matchesDirectPreparedSession(evidence.session, {
      attempt: evidence.attempt,
      task: evidence.task,
      workspacePath: resolveTaskWorkspace(state.space, evidence.task),
    }) ||
    state.stopRequested
  )
    return { reason: null };
  return { value: identity };
}

export function createDirectTaskQueryAdmission(lookups: DirectTaskQueryLookups) {
  return (superpipe({ ...lookups })('admit-running-direct-task-query') as PipelineAPI)
    .input('input')
    .pipe(directQuerySessionId, ['input'], 'sessionId')
    .pipe(
      loadDirectTaskWorkerEvidence,
      ['sessionId', 'getSession', 'getTask', 'getActiveAttempt'],
      'evidence'
    )
    .pipe(requireDirectTaskWorkerIdentity, ['sessionId', 'evidence'], 'result:identity')
    .pipe(loadDirectTaskQueryState, ['identity', 'getSpace', 'isStopRequested'], 'queryState')
    .pipe(
      requireRunningDirectTaskQuery,
      ['input', 'identity', 'evidence', 'queryState'],
      'result:identity'
    )
    .end('identity') as (input: DirectTaskQueryAdmissionInput) => DirectTaskWorkerIdentity | null;
}

export function createDatabaseDirectTaskQueryAdmission(db: Database) {
  const sessions = new SessionRepository(db);
  const tasks = new SpaceTaskRepository(db);
  const spaces = new SpaceRepository(db);
  const attempts = new DirectTaskExecutionRepository(db);
  return createDirectTaskQueryAdmission({
    getSession: (id) => sessions.getSession(id),
    getTask: (id) => tasks.getTask(id),
    getActiveAttempt: (id) => attempts.getActive(id),
    getSpace: (id) => spaces.getSpace(id),
    isStopRequested: (attemptId, sessionId) => attempts.isStopRequested(attemptId, sessionId),
  });
}
