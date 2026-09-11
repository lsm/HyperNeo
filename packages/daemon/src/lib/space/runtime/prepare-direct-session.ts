import type { Session, Space, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { resolveTaskWorkspace } from './spawn-slot-resolution.ts';
import { AgentSession } from '../../agent/agent-session.ts';
import type { SessionManager } from '../../session/session-manager.ts';
import type { Database } from '../../../storage/database.ts';
import type {
  DirectTaskAttempt,
  DirectTaskExecutionRepository,
} from '../../../storage/repositories/direct-task-execution-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';

export interface DirectSessionPreparationDependencies {
  attempts: Pick<
    DirectTaskExecutionRepository,
    'get' | 'getActive' | 'isSelected' | 'isStopRequested'
  >;
  tasks: Pick<SpaceTaskRepository, 'getTask'>;
  getSpace: (spaceId: string) => Space | null;
  db: Pick<Database, 'getSession' | 'createSession'>;
  sessionManager: Pick<
    SessionManager,
    'getCachedSession' | 'getSessionForControl' | 'unregisterSession'
  >;
  defaultModel: string;
}
interface DirectPreparation {
  attempt: DirectTaskAttempt;
  task: SpaceTask;
  workspacePath: string;
}
export type PreparedDirectSession = { attempt: DirectTaskAttempt; session: AgentSession };
type PreparationFailure =
  | 'direct_attempt_unavailable'
  | 'direct_session_conflict'
  | 'direct_session_unavailable';

export function requireReservedDirectTask(
  attempt: DirectTaskAttempt | null,
  active: DirectTaskAttempt | null,
  selected: boolean,
  task: SpaceTask | null,
  space: Space | null,
  stopRequested = false
): { value: DirectPreparation } | { reason: PreparationFailure } {
  return attempt &&
    attempt.phase === 'reserved' &&
    active?.id === attempt.id &&
    active.sessionId === attempt.sessionId &&
    active.generation === attempt.generation &&
    selected &&
    !stopRequested &&
    task?.id === attempt.taskId &&
    task.status === 'open' &&
    !task.archivedAt &&
    !task.workflowRunId &&
    space?.id === task.spaceId
    ? { value: { attempt, task, workspacePath: resolveTaskWorkspace(space, task) } }
    : { reason: 'direct_attempt_unavailable' };
}

export function matchesDirectPreparedSession(
  session: Session,
  candidate: DirectPreparation
): boolean {
  return session.status === 'active' && matchesDirectSessionIdentity(session, candidate);
}

function matchesDirectSessionIdentity(session: Session, candidate: DirectPreparation): boolean {
  return (
    session.id === candidate.attempt.sessionId &&
    session.type === 'worker' &&
    session.context?.taskId === candidate.task.id &&
    session.context.spaceId === candidate.task.spaceId &&
    session.workspacePath === candidate.workspacePath &&
    !session.config.coordinatorMode
  );
}

function readPreparation(
  attempts: DirectSessionPreparationDependencies['attempts'],
  tasks: DirectSessionPreparationDependencies['tasks'],
  getSpace: DirectSessionPreparationDependencies['getSpace'],
  attemptId: string
) {
  const attempt = attempts.get(attemptId);
  const task = attempt ? tasks.getTask(attempt.taskId) : null;
  return requireReservedDirectTask(
    attempt,
    attempt ? attempts.getActive(attempt.taskId) : null,
    !!attempt && attempts.isSelected(attempt.taskId),
    task,
    task?.spaceId ? getSpace(task.spaceId) : null,
    !!attempt && attempts.isStopRequested(attempt.id, attempt.sessionId)
  );
}

async function prepareDormantSession(
  attempts: DirectSessionPreparationDependencies['attempts'],
  tasks: DirectSessionPreparationDependencies['tasks'],
  getSpace: DirectSessionPreparationDependencies['getSpace'],
  db: DirectSessionPreparationDependencies['db'],
  sessionManager: DirectSessionPreparationDependencies['sessionManager'],
  defaultModel: string,
  candidate: DirectPreparation
): Promise<{ value: PreparedDirectSession } | { reason: PreparationFailure }> {
  const admission = readPreparation(attempts, tasks, getSpace, candidate.attempt.id);
  if ('reason' in admission) return admission;
  const id = candidate.attempt.sessionId;
  const existing = db.getSession(id);
  if (existing && !matchesDirectPreparedSession(existing, candidate))
    return { reason: 'direct_session_conflict' };
  if (!existing)
    db.createSession(
      AgentSession.createSessionFromInit(
        {
          sessionId: id,
          title: candidate.task.title,
          workspacePath: candidate.workspacePath,
          type: 'worker',
          context: { spaceId: candidate.task.spaceId, taskId: candidate.task.id },
        },
        defaultModel
      )
    );
  const cached = sessionManager.getCachedSession(id);
  const session = await sessionManager.getSessionForControl(id);
  if (!session) return { reason: 'direct_session_unavailable' };
  const current = readPreparation(attempts, tasks, getSpace, candidate.attempt.id);
  const persisted = db.getSession(id);
  const valid =
    persisted !== null &&
    matchesDirectPreparedSession(persisted, candidate) &&
    'value' in current &&
    current.value.attempt.sessionId === id &&
    current.value.attempt.generation === candidate.attempt.generation &&
    matchesDirectPreparedSession(session.getSessionData(), current.value);
  if (!valid || session.isQueryActiveOrStarting()) {
    if (
      session !== cached &&
      matchesDirectSessionIdentity(session.getSessionData(), candidate) &&
      !session.isQueryActiveOrStarting()
    ) {
      await sessionManager.unregisterSession(id, session);
      await session.cleanup();
    }
    return { reason: 'direct_attempt_unavailable' };
  }
  return { value: { attempt: current.value.attempt, session } };
}

export function createDormantDirectSessionPreparer(
  dependencies: DirectSessionPreparationDependencies
) {
  return (superpipe({ ...dependencies })('prepare-dormant-direct-session') as PipelineAPI)
    .input('attemptId')
    .pipe(readPreparation, ['attempts', 'tasks', 'getSpace', 'attemptId'], 'result:prepared')
    .pipe((candidate: DirectPreparation) => candidate, 'prepared', 'candidate')
    .pipe(
      prepareDormantSession,
      ['attempts', 'tasks', 'getSpace', 'db', 'sessionManager', 'defaultModel', 'candidate'],
      'result:prepared'
    )
    .endAsync('prepared') as (
    attemptId: string
  ) => Promise<PreparedDirectSession | PreparationFailure>;
}
