import type { WorkRef } from '../../lib/drivers/types.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import { markWorkUnusable } from './work-started-sessions-worker.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository, neoWorkerKey } from './neo-todo-session-repository.ts';

export type NeoTodoMove = { todoId: string; fromRef: WorkRef; at: number };

class NeoTodoMoves {
  constructor(
    private readonly db: Database,
    private readonly changes?: Pick<ReactiveDatabase, 'notifyChange'>
  ) {}

  pending(): NeoTodoMove[] {
    return (
      this.db
        .prepare(
          "SELECT todo_id AS todoId, value_json AS value FROM pack_facts WHERE pack = 'core' AND key = 'move'"
        )
        .all() as { todoId: string; value: string }[]
    ).map(({ todoId, value }) => ({ todoId, ...JSON.parse(value) }));
  }

  private get(todoId: string): NeoTodoMove | null {
    const row = this.db
      .prepare(
        "SELECT value_json AS value FROM pack_facts WHERE todo_id = ? AND pack = 'core' AND key = 'move'"
      )
      .get(todoId) as { value: string } | null;
    return row ? { todoId, ...JSON.parse(row.value) } : null;
  }

  release(move: NeoTodoMove): boolean {
    return (
      this.db
        .prepare(`DELETE FROM pack_facts WHERE todo_id = ? AND pack = 'core' AND key = 'move'
      AND json_extract(value_json, '$.at') = ? AND json_extract(value_json, '$.fromRef.adapter') = ?
      AND json_extract(value_json, '$.fromRef.id') = ? AND json_extract(value_json, '$.fromRef.daemon') IS ?`)
        .run(
          move.todoId,
          move.at,
          move.fromRef.adapter,
          move.fromRef.id,
          move.fromRef.daemon ?? null
        ).changes > 0
    );
  }

  active(move: NeoTodoMove): boolean {
    const current = this.get(move.todoId);
    if (
      !current ||
      current.at !== move.at ||
      neoWorkerKey(current.fromRef) !== neoWorkerKey(move.fromRef)
    )
      return false;
    const store = new NeoAskTodoRepository(this.db);
    const sessions = new NeoTodoSessionRepository(this.db);
    const todo = store.getTodo(move.todoId);
    if (
      todo?.state === 'doing' &&
      store.getAsk(todo.askId)?.status === 'open' &&
      neoWorkerKey(sessions.readRef(move.todoId)) === neoWorkerKey(move.fromRef)
    )
      return true;
    this.release(move);
    return false;
  }

  claim(todoId: string, fromRef: WorkRef, at: number) {
    const sessions = new NeoTodoSessionRepository(this.db);
    const store = new NeoAskTodoRepository(this.db);
    const prior = this.get(todoId);
    if (prior) this.active(prior);
    const todo = store.getTodo(todoId);
    if (!todo) return { reason: 'not_found: no such todo.' };
    if (neoWorkerKey(sessions.readRef(todoId)) !== neoWorkerKey(fromRef)) return { todo };
    if (todo?.state !== 'doing' || store.getAsk(todo.askId)?.status !== 'open')
      return { reason: 'move_not_doing: only ongoing work can move.' };
    if (sessions.get(todoId)?.verb !== 'start')
      return { reason: 'move_not_started: only started work can move.' };
    const refs = this.db
      .prepare(`SELECT s.todo_id AS id, COALESCE(s.ref, json_extract(s.target, '$.ref')) AS ref
      FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
      WHERE s.todo_id <> ? AND t.state IN ('todo', 'doing', 'blocked')
      UNION ALL SELECT todo_id AS id, json_extract(target, '$.ref') AS ref FROM work_delivery_inputs WHERE outcome IS NULL`)
      .all(todoId) as { id: string | null; ref: string | null }[];
    if (refs.some((row) => row.ref && neoWorkerKey(JSON.parse(row.ref)) === neoWorkerKey(fromRef)))
      return { reason: 'move_shared: another todo or pending delivery uses this worker.' };
    const move = this.get(todoId) ?? { todoId, fromRef, at };
    this.db
      .prepare(
        "INSERT OR IGNORE INTO pack_facts (todo_id, pack, key, value_json) VALUES (?, 'core', 'move', ?)"
      )
      .run(todoId, JSON.stringify({ fromRef: move.fromRef, at: move.at }));
    return { move };
  }

  reopen(move: NeoTodoMove): boolean {
    if (!this.active(move)) return false;
    const store = new NeoAskTodoRepository(this.db);
    markWorkUnusable(this.db, move.fromRef);
    store.updateTodo(
      store.getTodo(move.todoId)!,
      { state: 'todo', startedAt: null, finishedAt: null },
      Date.now()
    );
    this.db
      .prepare(`UPDATE neo_todo_sessions SET ref = NULL, started_at = NULL, live_status = NULL,
      sent_receipt = NULL, start_interrupted = 0 WHERE todo_id = ?`)
      .run(move.todoId);
    this.release(move);
    this.changes?.notifyChange('neo_todos');
    this.changes?.notifyChange('neo_todo_sessions');
    return true;
  }
}

export const neoTodoMoveReads = defineRepositoryOp('neo.todoMoveReads', 'read', NeoTodoMoves, [
  'pending',
]);
export const neoTodoMoveWrites = defineRepositoryOp('neo.todoMoveWrites', 'write', NeoTodoMoves, [
  'claim',
  'active',
  'release',
  'reopen',
]);
