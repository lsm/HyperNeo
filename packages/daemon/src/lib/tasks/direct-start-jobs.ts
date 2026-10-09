import type { JobQueueProcessor } from '../../storage/job-queue-processor.ts';
import { isTerminalTaskStatus } from './status-preparation.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import {
  createDirectAttemptStopper,
  type DirectAttemptStopDependencies,
} from './stop-direct-attempt.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { ReactiveDatabase } from '../../storage/reactive-database.ts';
import type { JobQueueRepository, Job } from '../../storage/repositories/job-queue-repository.ts';
import {
  DirectTaskExecutionRepository,
  type DirectTaskAttempt,
} from '../../storage/repositories/direct-task-execution-repository.ts';
import type { SpaceTask } from '@hyperneo/shared';
import {
  createDirectTaskStarter,
  claimDirectStart,
  directTaskStartIdentity,
  type DirectTaskStartInput,
  type DirectTaskStartResult,
} from './start-direct-task.ts';
import { DIRECT_TASK_PARK_BUDGET, decideParkAdmission, parkAdmissionInput } from './park-budget.ts';
import {
  DIRECT_TASK_START,
  readDirectStartRequest,
  reviveDirectStartJob,
} from './direct-start-request.ts';
import { Logger } from '../logger.ts';

const log = new Logger('DirectStartJobs');
import { DIRECT_ACTIVATION_WAITS } from './activate-direct-attempt.ts';

export type DirectStartAcknowledgement =
  | { accepted: true; jobId: string | null }
  | { accepted: false; reason: string };
export function acknowledgeDirectStart(
  db: Database,
  claim: ReturnType<typeof claimDirectStart>
): DirectStartAcknowledgement {
  if ('reason' in claim && !claim.reason.started)
    return { accepted: false, reason: claim.reason.reason };
  const attempt =
    'value' in claim
      ? claim.value
      : (claim.reason as Extract<DirectTaskStartResult, { started: true }>).attempt;
  return { accepted: true, jobId: readDirectStartRequest(db, attempt.id)?.jobId ?? null };
}
export function createDirectStartRequester(deps: {
  db: Database;
  reactiveDb?: ReactiveDatabase;
  jobQueue: JobQueueRepository;
  onTaskReopened?: (id: string) => void;
  onTaskAttemptChanged?: (id: string) => void;
}) {
  return (superpipe({ ...deps })('request-direct-task-start') as PipelineAPI)
    .input('input')
    .pipe(
      claimDirectStart,
      ['db', 'reactiveDb', 'input', 'onTaskReopened', 'jobQueue', 'onTaskAttemptChanged'],
      'claim'
    )
    .pipe(acknowledgeDirectStart, ['db', 'claim'], 'result')
    .end('result') as (input: DirectTaskStartInput) => DirectStartAcknowledgement;
}
type StartJobResult = DirectTaskStartResult & { parked?: string };
type DirectStartRequest = NonNullable<ReturnType<typeof readDirectStartRequest>>;
type LinkedStart = { request: DirectStartRequest; attempt: DirectTaskAttempt };
const superseded = { started: false as const, reason: 'superseded' };

interface LinkedStartEvidence {
  attemptId: string | null;
  request: ReturnType<typeof readDirectStartRequest>;
  attempt: DirectTaskAttempt | null;
  activeId: string | null;
}

function readLinkedStart(
  db: Database,
  attempts: DirectTaskExecutionRepository,
  job: Job
): LinkedStartEvidence {
  const attemptId =
    job.queue === DIRECT_TASK_START && typeof job.payload.attemptId === 'string'
      ? job.payload.attemptId
      : null;
  const attempt = attemptId ? attempts.get(attemptId) : null;
  return {
    attemptId,
    request: attemptId ? readDirectStartRequest(db, attemptId) : null,
    attempt,
    activeId: attempt ? (attempts.getActive(attempt.taskId)?.id ?? null) : null,
  };
}

export function requireLinkedStart(
  evidence: LinkedStartEvidence,
  job: Pick<Job, 'id'>
): { value: LinkedStart } | { reason: StartJobResult } {
  const { attemptId, request, attempt } = evidence;
  if (!attemptId) return { reason: { started: false, reason: 'unlinked_job' } };
  if (
    !request ||
    request.jobId !== job.id ||
    !attempt ||
    request.input.taskId !== attempt.taskId ||
    directTaskStartIdentity(request.input).attemptId !== attempt.id ||
    evidence.activeId !== attempt.id
  )
    return { reason: superseded };
  return { value: { request, attempt } };
}

export function requireStartNotFinished(
  result: DirectTaskStartResult
): { value: Extract<DirectTaskStartResult, { started: false }> } | { reason: StartJobResult } {
  return result.started ? { reason: result } : { value: result };
}

interface StartFollowUpEvidence {
  current: DirectTaskAttempt | null;
  task: SpaceTask | null;
  spaceActive: boolean;
  lifecycleGeneration: number | null;
  retiring: boolean;
  stopRequested: boolean;
}

function readStartFollowUp(
  db: Database,
  attempts: DirectTaskExecutionRepository,
  tasks: SpaceTaskRepository,
  linked: LinkedStart
): StartFollowUpEvidence {
  const { attempt } = linked;
  const task = tasks.getTask(attempt.taskId);
  const space = task ? new SpaceRepository(db).getSpace(task.spaceId) : null;
  return {
    current: attempts.getActive(attempt.taskId),
    task,
    spaceActive: space?.status === 'active',
    lifecycleGeneration: task ? tasks.getLifecycleGeneration(task.id) : null,
    retiring: attempts.isRetiringStopRequested(attempt.id, attempt.sessionId),
    stopRequested: attempts.isStopRequested(attempt.id, attempt.sessionId),
  };
}

type StartFollowUp =
  | { kind: 'retire'; current: DirectTaskAttempt }
  | { kind: 'requeue'; cleanup: boolean };

export function decideStartFollowUp(
  evidence: StartFollowUpEvidence,
  linked: LinkedStart
): { value: StartFollowUp } | { reason: StartJobResult } {
  const { current, task } = evidence;
  if (current?.id !== linked.attempt.id) return { reason: superseded };
  const terminal =
    !task ||
    !evidence.spaceActive ||
    !!task.workflowRunId ||
    task.archivedAt != null ||
    isTerminalTaskStatus(task.status) ||
    task.status === 'archived' ||
    evidence.lifecycleGeneration !==
      linked.request.lifecycleGeneration + (current.phase === 'running' ? 1 : 0);
  if (terminal || evidence.retiring)
    return current.phase === 'reserved'
      ? { value: { kind: 'retire', current } }
      : { reason: superseded };
  return evidence.stopRequested
    ? { reason: superseded }
    : { value: { kind: 'requeue', cleanup: false } };
}

async function retireStartReservation(
  stop: ReturnType<typeof createDirectAttemptStopper>,
  attempts: DirectTaskExecutionRepository,
  followUp: StartFollowUp,
  linked: LinkedStart,
  onTaskAttemptChanged: ((taskId: string) => void) | undefined
): Promise<{ value: StartFollowUp } | { reason: StartJobResult }> {
  if (followUp.kind !== 'retire') return { value: followUp };
  const { current } = followUp;
  const stopped = await stop({
    attemptId: current.id,
    sessionId: current.sessionId,
    outcome: 'start_superseded',
  });
  if (stopped.stopped) onTaskAttemptChanged?.(linked.attempt.taskId);
  return stopped.stopped || attempts.getActive(linked.attempt.taskId)?.id !== linked.attempt.id
    ? { reason: superseded }
    : { value: { kind: 'requeue', cleanup: true } };
}

type StartRequeue =
  | { kind: 'wait'; claimToken: string; runAt: number }
  | { kind: 'park'; claimToken: string; runAt: number; parked: string };

export function decideStartRequeue(
  job: Job,
  result: Extract<DirectTaskStartResult, { started: false }>,
  followUp: StartFollowUp,
  now: number
): StartRequeue {
  if (!job.claimToken) throw new Error(`Direct start remains unavailable: ${result.reason}`);
  const cleanup = followUp.kind === 'requeue' && followUp.cleanup;
  if (!cleanup && DIRECT_ACTIVATION_WAITS.has(result.reason))
    return { kind: 'wait', claimToken: job.claimToken, runAt: now + 30_000 };
  const admission = decideParkAdmission(parkAdmissionInput(job, DIRECT_TASK_PARK_BUDGET, now));
  if ('reason' in admission)
    throw new Error(`Direct start remains unavailable: ${admission.reason}`);
  return {
    kind: 'park',
    claimToken: job.claimToken,
    runAt: now + 30_000,
    parked: cleanup ? 'direct_start_cleanup_unverified' : 'direct_start_not_ready',
  };
}

function requeueStartJob(
  jobs: Pick<JobQueueRepository, 'requeueParked' | 'requeueWaiting'>,
  job: Job,
  result: Extract<DirectTaskStartResult, { started: false }>,
  requeue: StartRequeue
): StartJobResult {
  const requeued =
    requeue.kind === 'wait'
      ? jobs.requeueWaiting(job.id, requeue.runAt, requeue.claimToken)
      : jobs.requeueParked(job.id, requeue.runAt, requeue.claimToken);
  if (!requeued) return { started: false, reason: 'superseded_claim' };
  return { ...result, parked: requeue.kind === 'wait' ? result.reason : requeue.parked };
}

export function createDirectStartJobHandler(
  db: Database,
  start: (input: DirectTaskStartInput) => Promise<DirectTaskStartResult>,
  jobs: Pick<JobQueueRepository, 'requeueParked' | 'requeueWaiting'>,
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  onTaskAttemptChanged?: (taskId: string) => void
) {
  const attempts = new DirectTaskExecutionRepository(db);
  const tasks = new SpaceTaskRepository(db);
  const stop = createDirectAttemptStopper({ attempts, tasks, sessionManager });
  return (
    superpipe({ db, attempts, tasks, stop, jobs, start, onTaskAttemptChanged })(
      'run-direct-start-job'
    ) as PipelineAPI
  )
    .input('job')
    .pipe(readLinkedStart, ['db', 'attempts', 'job'], 'linkedEvidence')
    .pipe(requireLinkedStart, ['linkedEvidence', 'job'], 'result:outcome')
    .pipe((linked: LinkedStart) => linked, 'outcome', 'linked')
    .pipe(
      (run: typeof start, linked: LinkedStart) => run(linked.request.input),
      ['start', 'linked'],
      'started'
    )
    .pipe(requireStartNotFinished, 'started', 'result:outcome')
    .pipe((result: DirectTaskStartResult) => result, 'outcome', 'result')
    .pipe(readStartFollowUp, ['db', 'attempts', 'tasks', 'linked'], 'followUpEvidence')
    .pipe(decideStartFollowUp, ['followUpEvidence', 'linked'], 'result:outcome')
    .pipe(
      retireStartReservation,
      ['stop', 'attempts', 'outcome', 'linked', 'onTaskAttemptChanged'],
      'result:outcome'
    )
    .pipe((followUp: StartFollowUp) => followUp, 'outcome', 'followUp')
    .pipe(Date.now, undefined, 'now')
    .pipe(decideStartRequeue, ['job', 'result', 'followUp', 'now'], 'requeue')
    .pipe(requeueStartJob, ['jobs', 'job', 'result', 'requeue'], 'outcome')
    .endAsync('outcome') as (job: Job) => Promise<StartJobResult>;
}

type DeadStartReservation = { attemptId: string; sessionId: string; taskId: string };
export type DeadStartOutcome = 'not_reserved' | 'retired' | 'revived';

export function requireDeadStartReservation(
  db: Database,
  job: Job
): { value: DeadStartReservation } | { reason: DeadStartOutcome } {
  const attemptId = job.payload.attemptId;
  if (job.queue !== DIRECT_TASK_START || typeof attemptId !== 'string')
    return { reason: 'not_reserved' };
  const attempt = new DirectTaskExecutionRepository(db).get(attemptId);
  if (attempt?.phase !== 'reserved' || readDirectStartRequest(db, attemptId)?.jobId !== job.id)
    return { reason: 'not_reserved' };
  return { value: { attemptId, sessionId: attempt.sessionId, taskId: attempt.taskId } };
}

async function stopDeadReservation(
  stop: ReturnType<typeof createDirectAttemptStopper>,
  reservation: DeadStartReservation
): Promise<boolean> {
  const stopped = await stop({
    attemptId: reservation.attemptId,
    sessionId: reservation.sessionId,
    outcome: 'start_superseded',
  });
  return stopped.stopped;
}

export function settleDeadStart(
  db: Database,
  jobs: Pick<JobQueueRepository, 'enqueue'>,
  reservation: DeadStartReservation,
  stopped: boolean,
  onTaskAttemptChanged?: (taskId: string) => void
): DeadStartOutcome {
  if (stopped) {
    onTaskAttemptChanged?.(reservation.taskId);
    return 'retired';
  }
  reviveDirectStartJob(db, jobs, reservation.attemptId);
  return 'revived';
}

export function createDirectStartDeadHandler(
  db: Database,
  jobs: Pick<JobQueueRepository, 'enqueue'>,
  sessionManager: DirectAttemptStopDependencies['sessionManager'],
  onTaskAttemptChanged?: (taskId: string) => void
) {
  const stop = createDirectAttemptStopper({
    attempts: new DirectTaskExecutionRepository(db),
    tasks: new SpaceTaskRepository(db),
    sessionManager,
  });
  return (
    superpipe({ db, jobs, stop, onTaskAttemptChanged })('retire-dead-direct-start') as PipelineAPI
  )
    .input('job')
    .pipe(requireDeadStartReservation, ['db', 'job'], 'result:outcome')
    .pipe((reservation: DeadStartReservation) => reservation, 'outcome', 'reservation')
    .pipe(stopDeadReservation, ['stop', 'reservation'], 'stopped')
    .pipe(
      settleDeadStart,
      ['db', 'jobs', 'reservation', 'stopped', 'onTaskAttemptChanged'],
      'outcome'
    )
    .endAsync('outcome') as (job: Job) => Promise<DeadStartOutcome>;
}

export function registerDirectStartJobs(
  deps: Parameters<typeof createDirectTaskStarter>[0] & {
    sessionManager: DirectAttemptStopDependencies['sessionManager'];
    jobQueue: JobQueueRepository;
    jobProcessor: Pick<JobQueueProcessor, 'register'>;
  }
): void {
  const retire = createDirectStartDeadHandler(
    deps.db,
    deps.jobQueue,
    deps.sessionManager,
    deps.onTaskClaimed
  );
  deps.jobProcessor.register(
    DIRECT_TASK_START,
    createDirectStartJobHandler(
      deps.db,
      createDirectTaskStarter(deps),
      deps.jobQueue,
      deps.sessionManager,
      deps.onTaskClaimed
    ),
    {
      onDead: (job) => {
        retire(job).catch((error: unknown) =>
          log.warn('Failed to retire a dead direct start reservation:', error)
        );
      },
    }
  );
}
