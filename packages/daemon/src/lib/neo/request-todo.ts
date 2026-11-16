import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { SessionRepository } from '../../storage/repositories/session-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { renderAddress } from '../mailbox/address.ts';
import { enqueueMailboxEntry } from '../mailbox/enqueue.ts';
import { createMailboxEntry } from '../mailbox/entry.ts';
import { wrapSessionContent } from '../messaging/session-envelope.ts';
import { sessionUnavailable } from '../session-resolution/session-lookup.ts';
import { neoDerivedId } from './derived-id.ts';

const requestTodoId = (incident: string) => neoDerivedId(`neo-request-todo:${incident}`);

export function closedNeoRequest(store: NeoAskTodoRepository, incident: string): string | null {
  const todo = store.getTodo(requestTodoId(incident));
  return todo && ['done', 'removed', 'failed'].includes(todo.state) ? todo.id : null;
}

export function recordNeoRequestTodo(
  store: NeoAskTodoRepository,
  input: {
    incident: string;
    neoSession: string;
    sender: string;
    text: string;
    messageId: string;
    now: number;
  }
): void {
  const askId = neoDerivedId(`neo-request-ask:${input.incident}`);
  const todoId = requestTodoId(input.incident);
  if (store.getTodo(todoId)) return;
  const title = input.text.trim().split('\n')[0].trim().slice(0, 120) || 'Request from a session';
  if (!store.getAsk(askId))
    store.openAsk({
      id: askId,
      projectId: null,
      sessionId: input.neoSession,
      originMessageId: input.messageId,
      title,
      request: `From session ${input.sender}:\n${input.text}`,
      createdAt: input.now,
    });
  store.addTodo(
    todoId,
    askId,
    {
      title,
      doneWhen: `Neo replied to session ${input.sender} and closed this todo.`,
      check: null,
      named: { requestFrom: input.sender },
      instruction: null,
      approvedAt: input.now,
      dependsOn: [],
    },
    input.now
  );
}

export function queueNeoRequestReply(
  db: Database,
  before: NeoTodo,
  after: NeoTodo,
  reason: string | undefined
): string | null {
  const to = before.named?.requestFrom;
  const terminal = (todo: NeoTodo) => ['done', 'removed'].includes(todo.state);
  if (typeof to !== 'string' || terminal(before) || !terminal(after)) return null;
  const session = new SessionRepository(db).getSession(to);
  if (!session || sessionUnavailable(session.status))
    return `reply_failed: the requester ${to} was not told (its session is gone). Tell it yourself with message.send.`;
  const neo = new NeoAskTodoRepository(db).getAsk(before.askId)?.sessionId;
  const text = `Neo closed your request "${after.title}" as ${after.state}${reason ? `: ${reason}` : '.'}`;
  const outcome = enqueueMailboxEntry(
    new JobQueueRepository(db),
    createMailboxEntry({
      to: { kind: 'session', sessionId: to },
      origin: neo ? renderAddress({ kind: 'session', sessionId: neo }) : 'system',
      messageUuid: neoDerivedId(`neo-request-reply:${before.id}`),
      message: {
        type: 'user',
        parent_tool_use_id: null,
        inputKind: 'task',
        message: {
          content: neo
            ? (wrapSessionContent(text, { sessionId: neo, name: null }) as string)
            : text,
        },
      },
    })
  );
  if (outcome.kind === 'rejected') throw new Error(outcome.reason);
  return null;
}
