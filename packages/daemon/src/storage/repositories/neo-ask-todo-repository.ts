import type { NeoAsk, NeoTodo, NeoTodoCheck } from '@hyperneo/shared/types/neo-ask';
import type { Database } from '../sqlite-compat.ts';

export type NeoTodoDraft = Pick<NeoTodo, 'title' | 'doneWhen' | 'check' | 'instruction' | 'named'>;

export type NeoTodoPatch = Partial<
  Pick<
    NeoTodo,
    | 'title'
    | 'doneWhen'
    | 'state'
    | 'reason'
    | 'replacedBy'
    | 'report'
    | 'evidence'
    | 'startedAt'
    | 'finishedAt'
  >
>;

const TODO_COLUMNS: Record<keyof NeoTodoPatch, string> = {
  title: 'title',
  doneWhen: 'done_when',
  state: 'state',
  reason: 'reason',
  replacedBy: 'replaced_by',
  report: 'report',
  evidence: 'evidence',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

const ASK_SELECT = `SELECT id, project_id AS projectId, session_id AS sessionId,
  origin_message_id AS originMessageId, title, request, status, outcome,
  created_at AS createdAt, updated_at AS updatedAt, settled_at AS settledAt FROM neo_asks`;

const TODO_SELECT = `SELECT id, ask_id AS askId, position, title, done_when AS doneWhen,
  check_json AS checkJson, instruction, named, state, reason, replaced_by AS replacedBy,
  added_after_start AS addedAfterStart, report, evidence, created_at AS createdAt,
  updated_at AS updatedAt, started_at AS startedAt, finished_at AS finishedAt FROM neo_todos`;

type TodoRow = Omit<NeoTodo, 'check' | 'named' | 'addedAfterStart'> & {
  checkJson: string | null;
  named: string | null;
  addedAfterStart: number;
};

const toTodo = ({ checkJson, named, addedAfterStart, ...row }: TodoRow): NeoTodo => ({
  ...row,
  check: checkJson ? (JSON.parse(checkJson) as NeoTodoCheck) : null,
  named: named ? (JSON.parse(named) as Record<string, unknown>) : null,
  addedAfterStart: addedAfterStart === 1,
});

export class NeoAskTodoRepository {
  constructor(
    private readonly db: Database,
    private readonly changed: () => void = () => {}
  ) {}

  openAsk(ask: Omit<NeoAsk, 'status' | 'outcome' | 'updatedAt' | 'settledAt'>): NeoAsk {
    this.db
      .prepare(
        `INSERT INTO neo_asks (id, project_id, session_id, origin_message_id, title, request, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ask.id,
        ask.projectId,
        ask.sessionId,
        ask.originMessageId,
        ask.title,
        ask.request,
        ask.createdAt,
        ask.createdAt
      );
    this.changed();
    return this.getAsk(ask.id)!;
  }

  getAsk(id: string): NeoAsk | null {
    return (this.db.prepare(`${ASK_SELECT} WHERE id = ?`).get(id) as NeoAsk | null) ?? null;
  }

  getTodo(id: string): NeoTodo | null {
    const row = this.db.prepare(`${TODO_SELECT} WHERE id = ?`).get(id) as TodoRow | null;
    return row ? toTodo(row) : null;
  }

  listTodos(askId: string): NeoTodo[] {
    return (
      this.db
        .prepare(`${TODO_SELECT} WHERE ask_id = ? ORDER BY position, created_at`)
        .all(askId) as TodoRow[]
    ).map(toTodo);
  }

  addTodo(id: string, askId: string, draft: NeoTodoDraft, now: number): NeoTodo {
    this.db
      .prepare(
        `INSERT INTO neo_todos (id, ask_id, position, title, done_when, check_json, instruction, named,
           added_after_start, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM neo_todos WHERE ask_id = ?), ?, ?, ?, ?, ?,
           EXISTS (SELECT 1 FROM neo_todos WHERE ask_id = ? AND started_at IS NOT NULL), ?, ?)`
      )
      .run(
        id,
        askId,
        askId,
        draft.title,
        draft.doneWhen,
        draft.check ? JSON.stringify(draft.check) : null,
        draft.instruction,
        draft.named ? JSON.stringify(draft.named) : null,
        askId,
        now,
        now
      );
    this.touchAsk(askId, now);
    return this.getTodo(id)!;
  }

  updateTodo(todo: NeoTodo, patch: NeoTodoPatch, now: number): NeoTodo {
    const keys = Object.keys(patch) as (keyof NeoTodoPatch)[];
    this.db
      .prepare(
        `UPDATE neo_todos SET ${keys.map((key) => `${TODO_COLUMNS[key]} = ?`).join(', ')}${
          keys.length ? ', ' : ''
        }updated_at = ? WHERE id = ?`
      )
      .run(...keys.map((key) => patch[key] ?? null), now, todo.id);
    this.touchAsk(todo.askId, now);
    return this.getTodo(todo.id)!;
  }

  private touchAsk(askId: string, now: number): void {
    this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(now, askId);
    this.changed();
  }
}
