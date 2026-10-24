import superpipe, { type PipelineAPI } from 'superpipe';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { parseMailboxEntry } from '../mailbox/entry.ts';
import type { Result, WorkWithdrawal } from './types.ts';

const WITHDRAWING = 'driver_input_withdrawing';
const WITHDRAWN = 'driver_input_withdrawn';

export interface OwnedInputWithdrawalDeps {
  jobs: Pick<JobQueueRepository, 'getLatestByPayload' | 'markDeadIfActive'>;
  transaction<T>(effect: () => T): T;
  messageId(sessionId: string, uuid: string): string | null;
  removeDeferred(sessionId: string, messageDbId: string, withdrawalJobId: string): Promise<boolean>;
}

type Outcome = Result<WorkWithdrawal>;
type Gate<T> = { value: T } | { reason: Outcome };
type QueuedInput = { job: Job; sessionId: string; uuid: string };

function withdrawal(queuedSubmissionId: string, withdrawn: boolean): Outcome {
  return {
    ok: true,
    value: {
      queuedSubmissionId,
      withdrawn,
      ...(!withdrawn ? { reason: 'not_queued' as const } : {}),
    },
  };
}

export function requireOwnedQueuedInput(
  job: Job | null,
  sessionId: string,
  queuedSubmissionId: string,
  from: string
): Gate<QueuedInput> {
  const entry = job ? parseMailboxEntry(job.payload) : null;
  if (
    !job ||
    job.queue !== 'mailbox' ||
    !entry ||
    entry.id !== queuedSubmissionId ||
    entry.to.kind !== 'session' ||
    entry.to.sessionId !== sessionId ||
    entry.origin !== from ||
    entry.deliveryMode !== 'defer' ||
    !entry.messageUuid
  )
    return { reason: withdrawal(queuedSubmissionId, false) };
  if (job.status === 'dead' && job.error === WITHDRAWN)
    return { reason: withdrawal(queuedSubmissionId, true) };
  return job.status === 'pending' ||
    job.status === 'completed' ||
    (job.status === 'dead' && job.error === WITHDRAWING)
    ? { value: { job, sessionId, uuid: entry.messageUuid } }
    : { reason: withdrawal(queuedSubmissionId, false) };
}

function claimPendingInput(
  input: QueuedInput,
  queuedSubmissionId: string,
  deps: OwnedInputWithdrawalDeps
): Gate<QueuedInput> {
  return input.job.status === 'pending' &&
    !deps.transaction(() => {
      const marker = deps.messageId(input.sessionId, input.uuid) ? WITHDRAWING : WITHDRAWN;
      return deps.jobs.markDeadIfActive(input.job.id, marker, ['pending']);
    })
    ? { reason: withdrawal(queuedSubmissionId, false) }
    : { value: input };
}

async function removeDeferredInput(
  input: QueuedInput,
  queuedSubmissionId: string,
  deps: OwnedInputWithdrawalDeps
): Promise<Gate<QueuedInput>> {
  const dbId = deps.messageId(input.sessionId, input.uuid);
  const removed = dbId
    ? await deps.removeDeferred(input.sessionId, dbId, input.job.id)
    : input.job.status === 'pending';
  return removed ? { value: input } : { reason: withdrawal(queuedSubmissionId, false) };
}

function finishWithdrawal(queuedSubmissionId: string): Outcome {
  return withdrawal(queuedSubmissionId, true);
}

export const withdrawOwnedInput = (superpipe({})('withdraw-owned-input') as PipelineAPI)
  .input(['sessionId', 'queuedSubmissionId', 'from', 'deps'])
  .pipe(
    (queuedSubmissionId: string, deps: OwnedInputWithdrawalDeps) =>
      deps.jobs.getLatestByPayload('mailbox', { id: queuedSubmissionId }),
    ['queuedSubmissionId', 'deps'],
    'job'
  )
  .pipe(
    requireOwnedQueuedInput,
    ['job', 'sessionId', 'queuedSubmissionId', 'from'],
    'result:outcome'
  )
  .pipe(claimPendingInput, ['outcome', 'queuedSubmissionId', 'deps'], 'result:outcome')
  .pipe(removeDeferredInput, ['outcome', 'queuedSubmissionId', 'deps'], 'result:outcome')
  .pipe(finishWithdrawal, 'queuedSubmissionId', 'outcome')
  .endAsync('outcome') as (
  sessionId: string,
  queuedSubmissionId: string,
  from: string,
  deps: OwnedInputWithdrawalDeps
) => Promise<Outcome>;
