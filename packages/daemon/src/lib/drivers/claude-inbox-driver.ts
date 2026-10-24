import superpipe, { type PipelineAPI } from 'superpipe';
import {
  type ClaudeInboxRoutes,
  createClaudeInboxConversations,
} from './claude-inbox-conversations.ts';
import { requireClaudeReplyDestination, submitClaudeInboxMessage } from './claude-inbox-submit.ts';
import type { ClaudeInboxEvent, ClaudeInboxSubmission } from './claude-inbox.ts';
import { readClaudeSenderSession } from './claude-inbox-endpoint.ts';
import type { ClaudeLiveSession } from './claude-desktop-adapter.ts';
import type { MailboxHandoffArgs, MailboxHandoffOutcome } from '../mailbox/handoff.ts';
import type { Rejected, WorkCallContext } from './types.ts';

type InboxHandoff = Omit<MailboxHandoffArgs, 'jobQueue'>;

interface ClaudeInboxDriverDeps {
  name: string;
  routes: ClaudeInboxRoutes;
  registrationsDir: string;
  liveSessions(): Promise<readonly ClaudeLiveSession[]>;
  hasSession(sessionId: string): boolean;
  handoff(args: InboxHandoff): Promise<MailboxHandoffOutcome>;
  onError(error: unknown): void;
  open?: Parameters<typeof createClaudeInboxConversations>[0]['open'];
}

function claudeInboxReply(event: ClaudeInboxEvent, to: string): InboxHandoff {
  return {
    to,
    origin: `driver:claude-code:${event.sessionId}`,
    messageUuid: event.kind === 'reply' ? event.messageId : crypto.randomUUID(),
    message: {
      type: 'user',
      inputKind: 'system',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content:
          event.kind === 'reply'
            ? event.content
            : `Claude inbox transport fact: ${JSON.stringify(event)}. This is peer transport status, not proof of completion.`,
      },
    },
  };
}

async function persistClaudeInboxReply(args: InboxHandoff, deps: ClaudeInboxDriverDeps) {
  const outcome = await deps.handoff(args);
  if (outcome.kind === 'rejected') throw new Error(outcome.reason);
  return outcome;
}

const receiveClaudeInboxReply = (superpipe({})('receive-claude-inbox-reply') as PipelineAPI)
  .input(['destination', 'event', 'deps'])
  .pipe(requireClaudeReplyDestination, ['destination', 'deps'], 'result:outcome')
  .pipe(claudeInboxReply, ['event', 'outcome'], 'message')
  .pipe(persistClaudeInboxReply, ['message', 'deps'], 'outcome')
  .endAsync('outcome') as (
  destination: Pick<WorkCallContext, 'from'>,
  event: ClaudeInboxEvent,
  deps: ClaudeInboxDriverDeps
) => Promise<MailboxHandoffOutcome | Rejected>;

export function createClaudeInboxDriver(deps: ClaudeInboxDriverDeps) {
  const conversations = createClaudeInboxConversations({
    name: deps.name,
    routes: deps.routes,
    senderSession: (from) => readClaudeSenderSession(from, deps.registrationsDir),
    open: deps.open,
    onError: deps.onError,
    onEvent: async (returnTo, event) => {
      const outcome = await receiveClaudeInboxReply({ from: returnTo }, event, deps);
      if ('ok' in outcome && !outcome.ok) throw new Error(outcome.detail);
    },
  });
  return {
    admit: (context: WorkCallContext) => requireClaudeReplyDestination(context, deps),
    send(
      sessionId: string,
      text: string,
      context: WorkCallContext,
      fromMode?: ClaudeInboxSubmission['fromMode']
    ) {
      const id = crypto.randomUUID();
      return submitClaudeInboxMessage(
        sessionId,
        { messageId: id, inputId: id, text, ...(fromMode ? { fromMode } : {}) },
        context,
        {
          ...deps,
          write: conversations.write,
        }
      );
    },
    listen: conversations.listen,
    close: conversations.close,
  };
}
