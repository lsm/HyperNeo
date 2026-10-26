import superpipe, { type PipelineAPI } from 'superpipe';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import {
  claimOwnedInputWithdrawal,
  withdrawal,
  type WithdrawalInput,
} from '../../storage/repositories/owned-input-withdrawal-write.ts';
import type { Result, WorkWithdrawal } from './types.ts';

export interface OwnedInputWithdrawalDeps {
  db: Database;
  removeDeferred(sessionId: string, messageDbId: string, withdrawalJobId: string): Promise<boolean>;
}

type Outcome = Result<WorkWithdrawal>;
type Gate<T> = { value: T } | { reason: Outcome };

async function claimPendingInput(
  sessionId: string,
  queuedSubmissionId: string,
  from: string,
  deps: OwnedInputWithdrawalDeps
): Promise<Gate<WithdrawalInput>> {
  return gatewayFor(deps.db).call(
    claimOwnedInputWithdrawal,
    'claim',
    sessionId,
    queuedSubmissionId,
    from
  );
}

async function removeDeferredInput(
  input: WithdrawalInput,
  queuedSubmissionId: string,
  deps: OwnedInputWithdrawalDeps
): Promise<Gate<WithdrawalInput>> {
  const removed = input.messageDbId
    ? await deps.removeDeferred(input.sessionId, input.messageDbId, input.jobId)
    : input.wasPending;
  return removed ? { value: input } : { reason: withdrawal(queuedSubmissionId, false) };
}

function finishWithdrawal(queuedSubmissionId: string): Outcome {
  return withdrawal(queuedSubmissionId, true);
}

export const withdrawOwnedInput = (superpipe({})('withdraw-owned-input') as PipelineAPI)
  .input(['sessionId', 'queuedSubmissionId', 'from', 'deps'])
  .pipe(claimPendingInput, ['sessionId', 'queuedSubmissionId', 'from', 'deps'], 'result:outcome')
  .pipe(removeDeferredInput, ['outcome', 'queuedSubmissionId', 'deps'], 'result:outcome')
  .pipe(finishWithdrawal, 'queuedSubmissionId', 'outcome')
  .endAsync('outcome') as (
  sessionId: string,
  queuedSubmissionId: string,
  from: string,
  deps: OwnedInputWithdrawalDeps
) => Promise<Outcome>;
