import { matchesDirectPreparedSession } from './prepare-direct-session.ts';
import { directTaskWorkspace, readDirectTaskWorktreePath } from './direct-task-workspace.ts';
import type { Space } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { DirectTaskExecutionRepository } from '../../storage/repositories/direct-task-execution-repository.ts';
import { SessionRepository } from '../../storage/repositories/session-repository.ts';
import { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
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
  getTaskWorktreePath: (spaceId: string, taskId: string) => string | null;
}
export interface DirectTaskQueryState {
  space: Space | null;
  stopRequested: boolean;
  worktreePath: string | null;
}

export function directQuerySessionId(input: DirectTaskQueryAdmissionInput): string {
  return input.sessionId;
}

export function loadDirectTaskQueryState(
  identity: DirectTaskWorkerIdentity,
  getSpace: DirectTaskQueryLookups['getSpace'],
  isStopRequested: DirectTaskQueryLookups['isStopRequested'],
  getTaskWorktreePath: DirectTaskQueryLookups['getTaskWorktreePath']
): DirectTaskQueryState {
  return {
    space: getSpace(identity.spaceId),
    stopRequested: isStopRequested(identity.attemptId, identity.sessionId),
    worktreePath: getTaskWorktreePath(identity.spaceId, identity.taskId),
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
      workspacePath: directTaskWorkspace(state.space, evidence.task, state.worktreePath),
    }) ||
    state.stopRequested
  )
    return { reason: null };
  return { value: identity };
}

export interface RunningDirectQuery {
  identity: DirectTaskWorkerIdentity;
  evidence: DirectTaskWorkerEvidence;
  queryState: DirectTaskQueryState;
}

export function admitRunningDirectQuery(
  lookups: DirectTaskQueryLookups,
  sessionId: string,
  expected?: DirectTaskQueryAdmissionInput
): { value: RunningDirectQuery } | { reason: null } {
  const evidence = loadDirectTaskWorkerEvidence(
    sessionId,
    lookups.getSession,
    lookups.getTask,
    lookups.getActiveAttempt
  );
  const worker = requireDirectTaskWorkerIdentity(sessionId, evidence);
  if ('reason' in worker) return worker;
  const queryState = loadDirectTaskQueryState(
    worker.value,
    lookups.getSpace,
    lookups.isStopRequested,
    lookups.getTaskWorktreePath
  );
  const running = requireRunningDirectTaskQuery(
    expected ?? worker.value,
    worker.value,
    evidence,
    queryState
  );
  return 'reason' in running
    ? running
    : { value: { identity: running.value, evidence, queryState } };
}

export function databaseDirectTaskQueryLookups(db: Database): DirectTaskQueryLookups {
  const sessions = new SessionRepository(db);
  const tasks = new SpaceTaskRepository(db);
  const spaces = new SpaceRepository(db);
  const attempts = new DirectTaskExecutionRepository(db);
  return {
    getSession: (id) => sessions.getSession(id),
    getTask: (id) => tasks.getTask(id),
    getActiveAttempt: (id) => attempts.getActive(id),
    getSpace: (id) => spaces.getSpace(id),
    isStopRequested: (attemptId, sessionId) => attempts.isStopRequested(attemptId, sessionId),
    getTaskWorktreePath: readDirectTaskWorktreePath(db),
  };
}

export function createDirectTaskQueryAdmission(lookups: DirectTaskQueryLookups) {
  return (superpipe({ lookups })('admit-running-direct-task-query') as PipelineAPI)
    .input('input')
    .pipe(directQuerySessionId, ['input'], 'sessionId')
    .pipe(admitRunningDirectQuery, ['lookups', 'sessionId', 'input'], 'result:identity')
    .pipe((running: RunningDirectQuery) => running.identity, 'identity', 'identity')
    .end('identity') as (input: DirectTaskQueryAdmissionInput) => DirectTaskWorkerIdentity | null;
}

export function createDatabaseDirectTaskQueryAdmission(db: Database) {
  return createDirectTaskQueryAdmission(databaseDirectTaskQueryLookups(db));
}
