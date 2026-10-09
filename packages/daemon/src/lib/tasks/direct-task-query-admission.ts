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

function expectedRunningQuery(
  expected: DirectTaskQueryAdmissionInput | undefined,
  identity: DirectTaskWorkerIdentity
): DirectTaskQueryAdmissionInput {
  return expected ?? identity;
}

function runningDirectQuery(
  identity: DirectTaskWorkerIdentity,
  evidence: DirectTaskWorkerEvidence,
  queryState: DirectTaskQueryState
): RunningDirectQuery {
  return { identity, evidence, queryState };
}

export function requireRunningDirectQuery(
  running: RunningDirectQuery | null
): { value: RunningDirectQuery } | { reason: null } {
  return running ? { value: running } : { reason: null };
}

export function createRunningDirectQueryReader(lookups: DirectTaskQueryLookups) {
  return (superpipe({ ...lookups })('read-running-direct-query') as PipelineAPI)
    .input(['sessionId', 'expected'])
    .pipe(
      loadDirectTaskWorkerEvidence,
      ['sessionId', 'getSession', 'getTask', 'getActiveAttempt'],
      'evidence'
    )
    .pipe(requireDirectTaskWorkerIdentity, ['sessionId', 'evidence'], 'result:running')
    .pipe(
      loadDirectTaskQueryState,
      ['running', 'getSpace', 'isStopRequested', 'getTaskWorktreePath'],
      'queryState'
    )
    .pipe(expectedRunningQuery, ['expected', 'running'], 'admission')
    .pipe(
      requireRunningDirectTaskQuery,
      ['admission', 'running', 'evidence', 'queryState'],
      'result:running'
    )
    .pipe(runningDirectQuery, ['running', 'evidence', 'queryState'], 'running')
    .end('running') as (
    sessionId: string,
    expected?: DirectTaskQueryAdmissionInput
  ) => RunningDirectQuery | null;
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
  const readRunning = createRunningDirectQueryReader(lookups);
  return (superpipe({})('admit-running-direct-task-query') as PipelineAPI)
    .input('input')
    .pipe(directQuerySessionId, ['input'], 'sessionId')
    .pipe(readRunning, ['sessionId', 'input'], 'running')
    .pipe(requireRunningDirectQuery, 'running', 'result:identity')
    .pipe((running: RunningDirectQuery) => running.identity, 'identity', 'identity')
    .end('identity') as (input: DirectTaskQueryAdmissionInput) => DirectTaskWorkerIdentity | null;
}

export function createDatabaseDirectTaskQueryAdmission(db: Database) {
  return createDirectTaskQueryAdmission(databaseDirectTaskQueryLookups(db));
}
