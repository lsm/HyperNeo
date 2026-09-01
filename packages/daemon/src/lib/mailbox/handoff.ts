import superpipe, { type PipelineAPI } from 'superpipe';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { type MailboxAddress, parseAddress } from './address.ts';
import { enqueueMailboxEntry } from './enqueue.ts';
import {
  createMailboxEntry,
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
  policy: Partial<MailboxEntryPolicy> | undefined
): { entry: MailboxEntry | undefined; outcome: MailboxHandoffOutcome | undefined } {
  try {
    return {
      entry: createMailboxEntry({ to: address, message: projectedMessage, origin, policy }),
      outcome: undefined,
    };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { entry: undefined, outcome: { kind: 'rejected', reason: error.message } };
  }
}

export function enqueueStage(
  jobQueue: JobQueueRepository,
  entry: MailboxEntry
): MailboxHandoffOutcome {
  return enqueueMailboxEntry(jobQueue, entry);
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
  .input(['to', 'message', 'origin', 'policy', 'jobQueue'])
  .pipe(parseAddressStage, 'to', ['address', 'outcome'])
  .pipe('!rejected', 'outcome')
  .pipe(projectMessageStage, 'message', ['projectedMessage', 'outcome'])
  .pipe('!rejected', 'outcome')
  .pipe(createEntryStage, ['address', 'projectedMessage', 'origin', 'policy'], ['entry', 'outcome'])
  .pipe('!rejected', 'outcome')
  .pipe(enqueueStage, ['jobQueue', 'entry'], 'outcome')
  .error(crashHandler, ['error'])
  .endAsync('outcome') as (...args: unknown[]) => Promise<MailboxHandoffOutcome>;

export function handoffPromptToMailbox(args: {
  to: string;
  message: MailboxMessage;
  origin: string;
  policy?: Partial<MailboxEntryPolicy>;
  jobQueue: JobQueueRepository;
}): Promise<MailboxHandoffOutcome> {
  return runMailboxHandoff(args.to, args.message, args.origin, args.policy, args.jobQueue).catch(
    crashHandler
  );
}
