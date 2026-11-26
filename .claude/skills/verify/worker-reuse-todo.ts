import type { Place, WorkRef } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { NEO_DRIVER_REFRESH } from '../../../packages/daemon/src/lib/neo/driver-refresh.ts';
import { JobQueueRepository } from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import type { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

export const nextTodoMessage = 'Synthetic next todo of the same ask';

export function queueNextTodo(db: Database, work: { ref: WorkRef; place: Place }, sessionId: string) {
  const now = Date.now();
  const todos = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  todos.openAsk({ id: 'compact-ask', projectId: null, sessionId, originMessageId: null, title: 'Reuse worker', request: 'Run the fixture', createdAt: now });
  const add = (id: string, instruction: string) =>
    todos.addTodo(id, 'compact-ask', { approvedAt: now, dependsOn: [], title: id, doneWhen: 'Settled', check: null, instruction, named: null }, now);
  add('compact-first', 'Synthetic first todo');
  sessions.create('compact-first', { verb: 'start', adapter: work.ref.adapter, place: work.place });
  sessions.recordRef('compact-first', work.ref, now);
  todos.updateTodo(todos.getTodo('compact-first')!, { state: 'done', finishedAt: now }, now);
  add('compact-next', nextTodoMessage);
  sessions.create('compact-next', { verb: 'send', ref: work.ref });
  db.prepare("DELETE FROM job_queue WHERE queue = ? AND status = 'pending'").run(NEO_DRIVER_REFRESH);
  new JobQueueRepository(db).enqueue({ queue: NEO_DRIVER_REFRESH, payload: { scope: 'neo' }, runAt: 0 });
  return () => sessions.readRef('compact-next') !== null;
}
