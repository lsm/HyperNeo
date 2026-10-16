import superpipe, { type PipelineAPI } from 'superpipe';
import { parseAddress, renderAddress } from '../mailbox/address.ts';
import { readClaudeInboxEndpoint, type ClaudeCliInboxEndpoint } from './claude-inbox-endpoint.ts';
import type { ClaudeInboxSubmission, ClaudeInboxTarget } from './claude-inbox.ts';
import type { ClaudeSessionIdentity, ClaudeSessionOwner } from './claude-session-owner.ts';
import type { Rejected, Result, WorkCallContext, WorkDelivery } from './types.ts';
import { reject } from './work-operations.ts';

interface ClaudeInboxSubmitDeps {
  registrationsDir: string;
  liveSessions(): Promise<readonly (ClaudeSessionIdentity & { owner?: ClaudeSessionOwner })[]>;
  hasSession(sessionId: string): boolean;
  write(
    target: ClaudeInboxTarget,
    returnTo: string,
    submission: ClaudeInboxSubmission
  ): Promise<{ written: true }>;
}

export function requireClaudeReplyDestination(
  context: Pick<WorkCallContext, 'from'>,
  deps: Pick<ClaudeInboxSubmitDeps, 'hasSession'>
): { value: string } | { reason: Rejected } {
  const destination = parseAddress(context.from);
  if (destination?.kind !== 'session')
    return {
      reason: reject(
        'unsupported',
        'Direct Claude inbox messages require a local session reply destination.'
      ),
    };
  return deps.hasSession(destination.sessionId)
    ? { value: renderAddress(destination) }
    : { reason: reject('unreachable', 'The Claude inbox reply destination is unavailable.') };
}

async function requireSubmissionEndpoint(
  sessionId: string,
  deps: ClaudeInboxSubmitDeps
): Promise<{ value: ClaudeCliInboxEndpoint } | { reason: Rejected }> {
  const endpoint = await readClaudeInboxEndpoint(
    sessionId,
    await deps.liveSessions(),
    deps.registrationsDir
  );
  return 'ok' in endpoint ? { reason: endpoint } : { value: endpoint };
}

async function writeSubmission(
  target: ClaudeCliInboxEndpoint,
  returnTo: string,
  submission: ClaudeInboxSubmission,
  deps: ClaudeInboxSubmitDeps
): Promise<Result<WorkDelivery>> {
  await deps.write(target, returnTo, submission);
  return {
    ok: true,
    value: {
      delivered: false,
      unconfirmed: true,
      receipt: { executionId: target.sessionId, inputId: submission.inputId },
    },
  };
}

export const submitClaudeInboxMessage = (
  superpipe({})('submit-claude-inbox-message') as PipelineAPI
)
  .input(['sessionId', 'submission', 'context', 'deps'])
  .pipe(requireSubmissionEndpoint, ['sessionId', 'deps'], 'result:outcome')
  .pipe((target: ClaudeCliInboxEndpoint) => target, 'outcome', 'target')
  .pipe(requireClaudeReplyDestination, ['context', 'deps'], 'result:outcome')
  .pipe(writeSubmission, ['target', 'outcome', 'submission', 'deps'], 'outcome')
  .endAsync('outcome') as (
  sessionId: string,
  submission: ClaudeInboxSubmission,
  context: WorkCallContext,
  deps: ClaudeInboxSubmitDeps
) => Promise<Result<WorkDelivery>>;
