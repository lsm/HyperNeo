import superpipe, { type PipelineAPI } from 'superpipe';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { type MailboxAddress, parseAddress } from './address.ts';
import { enqueueMailboxEntry } from './enqueue.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { enqueueMailboxAdmission } from '../../storage/repositories/mailbox-admission-write.ts';
import {
  createMailboxEntry,
  type MailboxDeliveryMode,
  type MailboxEntry,
  type MailboxEntryPolicy,
  type MailboxMessage,
  toMailboxMessage,
} from './entry.ts';

export type MailboxHandoffOutcome =
  | { kind: 'enqueued'; id: string }
  | { kind: 'rejected'; reason: string };

export const rejected = (outcome?: MailboxHandoffOutcome): boolean => outcome?.kind === 'rejected';

export function parseAddressStage(to: string): {
  address: MailboxAddress | undefined;
  outcome: MailboxHandoffOutcome | undefined;
} {
  const address = parseAddress(to);
  if (address === null) {
    return {
      address: undefined,
      outcome: { kind: 'rejected', reason: `invalid mailbox address: ${to}` },
    };
  }
  return { address, outcome: undefined };
}

export function projectMessageStage(message: MailboxMessage): {
  projectedMessage: MailboxMessage | undefined;
  outcome: MailboxHandoffOutcome | undefined;
} {
  const projected = toMailboxMessage(message);
  if ('reason' in projected) {
    return { projectedMessage: undefined, outcome: { kind: 'rejected', reason: projected.reason } };
  }
  return { projectedMessage: projected.message, outcome: undefined };
}

export function createEntryStage(
  address: MailboxAddress,
  projectedMessage: MailboxMessage,
  origin: string,
  policy: Partial<MailboxEntryPolicy> | undefined,
  deliveryMode: MailboxDeliveryMode | undefined,
  messageUuid?: string
): { entry: MailboxEntry | undefined; outcome: MailboxHandoffOutcome | undefined } {
  try {
    return {
      entry: createMailboxEntry({
        to: address,
        message: projectedMessage,
        origin,
        policy,
        deliveryMode,
        messageUuid,
      }),
      outcome: undefined,
    };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { entry: undefined, outcome: { kind: 'rejected', reason: error.message } };
  }
}

export async function enqueueStage(
  jobQueue: JobQueueRepository,
  entry: MailboxEntry,
  once?: boolean
): Promise<MailboxHandoffOutcome> {
  if (!once) return gatewayFor(jobQueue.db).call(enqueueMailboxAdmission, 'enqueue', entry);
  return jobQueue.commitSubmissionReceipt(
    `mailbox-once:${JSON.stringify([entry.to, entry.messageUuid])}`,
    'v1',
    () => {
      const outcome = enqueueMailboxEntry(jobQueue, entry);
      if (outcome.kind === 'rejected') throw new Error(outcome.reason);
      return outcome;
    }
  );
}

export function crashHandler(error: unknown): MailboxHandoffOutcome {
  return {
    kind: 'rejected',
    reason: `internal: ${error instanceof Error ? error.message : String(error)}`,
  };
}

const runMailboxHandoff = (
  superpipe<{ rejected: (outcome?: MailboxHandoffOutcome) => boolean }>({
    rejected,
  })('mailbox-handoff') as PipelineAPI
)
  .input(['to', 'message', 'origin', 'policy', 'deliveryMode', 'messageUuid', 'jobQueue', 'once'])
  .pipe(parseAddressStage, 'to', ['address', 'outcome'])
  .pipe('!rejected', 'outcome')
  .pipe(projectMessageStage, 'message', ['projectedMessage', 'outcome'])
  .pipe('!rejected', 'outcome')
  .pipe(
    createEntryStage,
    ['address', 'projectedMessage', 'origin', 'policy', 'deliveryMode', 'messageUuid'],
    ['entry', 'outcome']
  )
  .pipe('!rejected', 'outcome')
  .pipe(enqueueStage, ['jobQueue', 'entry', 'once'], 'outcome')
  .error(crashHandler, ['error'])
  .endAsync('outcome') as (...args: unknown[]) => Promise<MailboxHandoffOutcome>;

export interface MailboxHandoffArgs {
  to: string;
  message: MailboxMessage;
  origin: string;
  policy?: Partial<MailboxEntryPolicy>;
  deliveryMode?: MailboxDeliveryMode;
  messageUuid?: string;
  once?: boolean;
  jobQueue: JobQueueRepository;
}

export function handoffPromptToMailbox(args: MailboxHandoffArgs): Promise<MailboxHandoffOutcome> {
  return runMailboxHandoff(
    args.to,
    args.message,
    args.origin,
    args.policy,
    args.deliveryMode,
    args.messageUuid,
    args.jobQueue,
    args.once
  ).catch(crashHandler);
}
