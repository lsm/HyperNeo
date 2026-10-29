import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
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
type StalledTodo = NeoTodo & { since: number; sessionId: string };
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
            : { since: todo.since, delivered: [] },
      };
    },
    ['db', 'todo'],
    'context'
  )
  .pipe(
    (db: Database, context: Context, now: number) => {
      const { todo, reminder } = context;
      const sdk = new SDKMessageRepository(db);
      const delivered = reminder.delivered.length;
      reminder.delivered = reminder.delivered.filter(
        ({ id }) => sdk.getUserSendStatus(todo.sessionId, id) !== 'failed'
      );
      const pending = reminder.pending;
      if (pending) {
        const receipt = sdk.getUserDeliveryReceipt(todo.sessionId, pending);
        const job = new JobQueueRepository(db).getLatestByPayload('mailbox', {
          'to.sessionId': todo.sessionId,
          messageUuid: pending,
        });
        if (receipt?.status === 'consumed') {
          reminder.delivered.push({ id: pending, at: receipt.timestamp });
          delete reminder.pending;
        } else if (
          receipt?.status === 'failed' ||
          job?.status === 'dead' ||
          (!receipt && job?.status !== 'pending' && job?.status !== 'processing')
        ) {
          delete reminder.pending;
        }
      }
      if (pending !== reminder.pending || delivered !== reminder.delivered.length)
        new NeoTodoSessionRepository(db).recordNudge(todo.id, {
          ...context.incident,
          stallReminder: reminder,
        });
      return !reminder.pending &&
        reminder.delivered.length < 3 &&
        now - (reminder.delivered.at(-1)?.at ?? todo.since) >= INTERVAL
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
          deliveryMode: reminder.delivered.length === 0 ? 'immediate' : 'defer',
          message: {
            type: 'user',
            parent_tool_use_id: null,
            inputKind: 'system',
            neoWakeEvent: true,
            message: {
              content: `Todo "${todo.title}" (${todo.id}) in ask ${todo.askId} is still stalled${todo.blockedBy === 'environment' ? ` by environment: ${todo.blockedReason}; retry or escalate this environment failure` : ''}. Review this todo and continue its work or record the next action. This is reminder ${reminder.delivered.length + 1} of 3; the todo stays visible after reminders stop.`,
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
