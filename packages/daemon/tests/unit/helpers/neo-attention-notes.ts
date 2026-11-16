import {
  NEO_ATTENTION_KINDS,
  type NeoAttentionEvent,
} from '../../../src/lib/neo/attention/decide.ts';
import { createNeoAttention, neoAttentionDelivery } from '../../../src/lib/neo/attention/tell.ts';
import { neoTodoCovered } from '../../../src/lib/neo/todo-state.ts';
import type { NeoAskTodoRepository } from '../../../src/storage/repositories/neo-ask-todo-repository.ts';
import type { Database } from '../../../src/storage/sqlite-compat.ts';

export function neoAttentionNotes(
  db: Database,
  store: NeoAskTodoRepository,
  sink: (text: string) => void = () => {}
) {
  const dropped: string[] = [];
  const texts = (queue: 'mailbox' | 'neo_notes') =>
    (
      db.prepare('SELECT payload FROM job_queue WHERE queue = ?').all(queue) as {
        payload: string;
      }[]
    )
      .map((row) => JSON.parse(row.payload) as { message: { message: { content: unknown } } })
      .map((entry) => String(entry.message.message.content));
  const delivery = neoAttentionDelivery(
    db,
    () => 'neo',
    () => false
  );
  const sunk =
    (queue: 'mailbox' | 'neo_notes', deliver: typeof delivery.wake): typeof delivery.wake =>
    async (uuid, text) => {
      const before = texts(queue).length;
      const sent = await deliver(uuid, text);
      if (texts(queue).length > before) sink(text);
      return sent;
    };
  const tell = createNeoAttention({
    kinds: () => NEO_ATTENTION_KINDS,
    read: ({ subject }) => {
      const todo = subject.type === 'todo' ? store.getTodo(subject.id) : null;
      return {
        covered: !!todo && neoTodoCovered(todo, store.todoCards(todo)),
        latestReportAt: null,
      };
    },
    wake: sunk('mailbox', delivery.wake),
    digest: sunk('neo_notes', delivery.digest),
    dropped: (event, reason) => dropped.push(`${event.kind} ${event.subject.id}: ${reason}`),
  });
  return {
    tell,
    attend: (event: NeoAttentionEvent) => tell(event, Date.now()),
    dropped,
    wakes: () => texts('mailbox'),
    digests: () => texts('neo_notes'),
    told: () => [...texts('mailbox'), ...texts('neo_notes')],
  };
}
