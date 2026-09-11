import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { requireDirectTaskWorkerIdentity } from './direct-task-worker-identity.ts';
import { requireRunningDirectTaskQuery } from './direct-task-query-admission.ts';
import { createHash } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../../storage/reactive-database.ts';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../../storage/repositories/direct-task-execution-repository.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { assertValidTaskTransition } from '../../tasks/transitions.ts';
import { buildCustomAgentTaskMessage } from '../agents/custom-agent.ts';
import { resolveTaskWorkspace } from './spawn-slot-resolution.ts';
import {
  readPreparation,
  prepareDormantSession,
  type DirectSessionPreparationDependencies,
  type PreparedDirectSession,
} from './prepare-direct-session.ts';
import {
  readDirectKickoffIntent,
  recordDirectKickoffAtomically,
  type DirectKickoffResult,
} from './direct-kickoff-intent.ts';
import {
  activateDirectAttemptAtomically,
  type DirectAttemptActivationResult,
} from './activate-direct-attempt.ts';

export interface DirectTaskStartInput {
  taskId: string;
  requestKey: string;
}
export type DirectTaskStartResult =
  | { started: true; attempt: DirectTaskAttempt }
  | { started: false; reason: string };

function claimDirectStart(
  db: Database,
  reactiveDb: ReactiveDatabase | undefined,
  input: DirectTaskStartInput
): { value: DirectTaskAttempt } | { reason: DirectTaskStartResult } {
  const unavailable = { reason: { started: false as const, reason: 'direct_start_unavailable' } };
  if (!input.requestKey.trim()) return unavailable;
  const id = createHash('sha256')
    .update(JSON.stringify([input.taskId, input.requestKey]))
    .digest('hex');
  const attemptId = `direct-${id}`;
  const sessionId = `${attemptId}:session`;
  reactiveDb?.beginTransaction();
  try {
    const result = db.transaction(() => {
      const attempts = new DirectTaskExecutionRepository(db);
      const tasks = new SpaceTaskRepository(db, reactiveDb);
      const task = tasks.getTask(input.taskId);
      const space = task ? new SpaceRepository(db).getSpace(task.spaceId) : null;
      if (
        !task ||
        task.workflowRunId ||
        task.archivedAt ||
        space?.status !== 'active' ||
        space.paused ||
        space.stopped
      )
        return unavailable;
      const active = attempts.getActive(task.id);
      if (
        active &&
        (active.id !== attemptId ||
          active.sessionId !== sessionId ||
          attempts.isStopRequested(active.id, sessionId))
      )
        return unavailable;
      if (active?.phase === 'running') {
        const evidence = {
          session: new SessionRepository(db).getSession(sessionId),
          task,
          attempt: active,
        };
        const identity = requireDirectTaskWorkerIdentity(sessionId, evidence);
        if (
          'reason' in identity ||
          'reason' in
            requireRunningDirectTaskQuery(identity.value, identity.value, evidence, {
              space,
              stopRequested: false,
            })
        )
          return unavailable;
        const kickoff = readDirectKickoffIntent(db, active.id);
        if (
          kickoff?.to.kind !== 'session' ||
          kickoff.to.sessionId !== sessionId ||
          !db
            .prepare('SELECT 1 FROM direct_task_kickoff_dispatches WHERE attempt_id = ?')
            .get(active.id)
        )
          return unavailable;
        return { reason: { started: true as const, attempt: active } };
      }
      if (
        !['draft', 'open'].includes(task.status) ||
        task.taskAgentSessionId ||
        attempts.get(attemptId)?.phase === 'stopped'
      )
        return unavailable;
      if (!attempts.select(task.id)) return unavailable;
      if (task.status === 'draft') {
        assertValidTaskTransition('draft', 'open');
        if (!tasks.updateTask(task.id, { status: 'open' }, 'draft'))
          throw new Error('Direct start lost draft publication');
      }
      const attempt = attempts.claim(task.id, attemptId, sessionId);
      if (!attempt) throw new Error('Direct start lost its atomic claim');
      return { value: attempt };
    }, 'immediate')();
    reactiveDb?.commitTransaction();
    return result;
  } catch (error) {
    reactiveDb?.abortTransaction();
    throw error;
  }
}

function requireStartStage<T>(
  result: { value: T } | { reason: string },
  db: Database,
  input: DirectTaskStartInput
): { value: T } | { reason: DirectTaskStartResult } {
  return 'value' in result
    ? result
    : { reason: alreadyStarted(db, input) ?? { started: false, reason: result.reason } };
}

function alreadyStarted(db: Database, input: DirectTaskStartInput): DirectTaskStartResult | null {
  const active = new DirectTaskExecutionRepository(db).getActive(input.taskId);
  if (active?.phase !== 'running') return null;
  const outcome = claimDirectStart(db, undefined, input);
  return 'reason' in outcome && outcome.reason.started ? outcome.reason : null;
}

function kickoffInput(db: Database, prepared: PreparedDirectSession) {
  const { attempt } = prepared;
  const existing = readDirectKickoffIntent(db, attempt.id);
  const tasks = new SpaceTaskRepository(db);
  const task = tasks.getTask(attempt.taskId);
  const space = task ? new SpaceRepository(db).getSpace(task.spaceId) : null;
  if (!task || !space) throw new Error('Direct start task disappeared during preparation');
  return {
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    message: existing?.message ?? {
      type: 'user' as const,
      message: {
        content: buildCustomAgentTaskMessage({
          task,
          space,
          workspacePath: resolveTaskWorkspace(space, task),
        }),
      },
      parent_tool_use_id: null,
    },
  };
}
function requireRecorded(
  result: DirectKickoffResult,
  db: Database,
  input: DirectTaskStartInput
): { value: true } | { reason: DirectTaskStartResult } {
  return result.recorded
    ? { value: true }
    : { reason: alreadyStarted(db, input) ?? { started: false, reason: result.reason } };
}
function startResult(
  result: DirectAttemptActivationResult,
  db: Database,
  input: DirectTaskStartInput
): DirectTaskStartResult {
  return result.activated
    ? { started: true, attempt: result.attempt }
    : (alreadyStarted(db, input) ?? { started: false, reason: result.reason });
}

export function createDirectTaskStarter(dependencies: {
  db: Database;
  reactiveDb?: ReactiveDatabase;
  sessionDb: DirectSessionPreparationDependencies['db'];
  sessionManager: DirectSessionPreparationDependencies['sessionManager'];
  defaultModel: string;
}) {
  const { db, reactiveDb, sessionDb, sessionManager, defaultModel } = dependencies;
  const attempts = new DirectTaskExecutionRepository(db);
  const tasks = new SpaceTaskRepository(db);
  const spaces = new SpaceRepository(db);
  return (
    superpipe({
      db,
      reactiveDb,
      sessionDb,
      sessionManager,
      defaultModel,
      attempts,
      tasks,
      getSpace: (id: string) => spaces.getSpace(id),
      enqueueKickoff: true,
    })('start-direct-task') as PipelineAPI
  )
    .input('input')
    .pipe(claimDirectStart, ['db', 'reactiveDb', 'input'], 'result:start')
    .pipe((attempt: DirectTaskAttempt) => attempt.id, 'start', 'attemptId')
    .pipe(readPreparation, ['attempts', 'tasks', 'getSpace', 'attemptId'], 'preparation')
    .pipe(requireStartStage, ['preparation', 'db', 'input'], 'result:start')
    .pipe(
      prepareDormantSession,
      ['attempts', 'tasks', 'getSpace', 'sessionDb', 'sessionManager', 'defaultModel', 'start'],
      'preparation'
    )
    .pipe(requireStartStage, ['preparation', 'db', 'input'], 'result:start')
    .pipe(kickoffInput, ['db', 'start'], 'kickoff')
    .pipe(recordDirectKickoffAtomically, ['db', 'kickoff'], 'recorded')
    .pipe(requireRecorded, ['recorded', 'db', 'input'], 'result:start')
    .pipe(
      activateDirectAttemptAtomically,
      ['db', 'reactiveDb', 'kickoff', 'enqueueKickoff'],
      'activation'
    )
    .pipe(startResult, ['activation', 'db', 'input'], 'start')
    .endAsync('start') as (input: DirectTaskStartInput) => Promise<DirectTaskStartResult>;
}
