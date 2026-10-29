import superpipe, { type PipelineAPI } from 'superpipe';
import { createMailboxEntry } from '../../lib/mailbox/entry.ts';
import { enqueueMailboxEntry } from '../../lib/mailbox/enqueue.ts';
import type { FollowThroughIncident } from '../../lib/work-queue/follow-through.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';

const INTERVAL = 2 * 60 * 60 * 1000;
type StalledTodo = { id: string; title: string; since: number; sessionId: string; askId: string };
type Reminder = NonNullable<FollowThroughIncident['stallReminder']>;
type Context = { todo: StalledTodo; incident: FollowThroughIncident; reminder: Reminder };

const remindTodo = (superpipe({})('neo.stalled-todo.remind') as PipelineAPI)
  .input(['db', 'todo', 'now'])
  .pipe(
    (db: Database, todo: StalledTodo): Context => {
      const incident = new NeoTodoSessionRepository(db).readNudge(todo.id) ?? {
        since: todo.since,
        nudges: 0,
      };
      return {
        todo,
        incident,
        reminder:
          incident.stallReminder?.since === todo.since
            ? { ...incident.stallReminder }
            : { since: todo.since, delivered: 0 },
      };
    },
    ['db', 'todo'],
    'context'
  )
  .pipe(
    (db: Database, context: Context, now: number) => {
      const { todo, reminder } = context;
      if (reminder.pending) {
        const status = new SDKMessageRepository(db).getUserSendStatus(
          todo.sessionId,
          reminder.pending
        );
        const job = new JobQueueRepository(db).getLatestByPayload('mailbox', {
          'to.sessionId': todo.sessionId,
          messageUuid: reminder.pending,
        });
        if (status === 'consumed') {
          reminder.delivered++;
          reminder.deliveredAt = now;
          delete reminder.pending;
        } else if (status === 'failed' || job?.status === 'dead') {
          delete reminder.pending;
        }
        if (!reminder.pending)
          new NeoTodoSessionRepository(db).recordNudge(todo.id, {
            ...context.incident,
            stallReminder: reminder,
          });
      }
      return !reminder.pending &&
        reminder.delivered < 3 &&
        now - (reminder.deliveredAt ?? todo.since) >= INTERVAL
        ? { value: context }
        : { reason: null };
    },
    ['db', 'context', 'now'],
    'result:due'
  )
  .pipe(
    (db: Database, due: Context) => {
      const { todo, reminder } = due;
      const messageUuid = crypto.randomUUID();
      const outcome = enqueueMailboxEntry(
        new JobQueueRepository(db),
        createMailboxEntry({
          to: { kind: 'session', sessionId: todo.sessionId },
          origin: `session:${todo.sessionId}`,
          messageUuid,
          deliveryMode: reminder.delivered === 0 ? 'immediate' : 'defer',
          message: {
            type: 'user',
            parent_tool_use_id: null,
            inputKind: 'system',
            neoWakeEvent: true,
            message: {
              content: `Todo "${todo.title}" (${todo.id}) in ask ${todo.askId} is still stalled. Review this todo and continue its work or record the next action. This is reminder ${reminder.delivered + 1} of 3; the todo stays visible after reminders stop.`,
            },
          },
        })
      );
      if (outcome.kind === 'rejected') throw new Error(outcome.reason);
      new NeoTodoSessionRepository(db).recordNudge(todo.id, {
        ...due.incident,
        stallReminder: { ...reminder, pending: messageUuid },
      });
    },
    ['db', 'due'],
    'result'
  )
  .end('result') as (db: Database, todo: StalledTodo, now: number) => void;

export const neoStallReminderWrite = defineDbOp<{ now: number }, void>({
  name: 'neo.stalledTodoReminders',
  mode: 'write',
  run(db, { now }) {
    const store = new NeoAskTodoRepository(db);
    for (const todo of store.listCheckable(now - INTERVAL)) {
      const ask = store.getAsk(todo.askId)!;
      remindTodo(db, { ...todo, since: todo.updatedAt, sessionId: ask.sessionId }, now);
    }
  },
});
