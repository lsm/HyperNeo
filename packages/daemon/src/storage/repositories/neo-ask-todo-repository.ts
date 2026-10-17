import type {
  NeoAsk,
  NeoQuestion,
  NeoQuestionAnswer,
  NeoTodo,
  NeoTodoCheck,
} from '@hyperneo/shared/types/neo-ask';
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

export type NeoQuestionDraft = Pick<
  NeoQuestion,
  'text' | 'kind' | 'options' | 'multiple' | 'noLabel' | 'yesLabel' | 'startTodos'
>;

const QUESTION_SELECT = `SELECT id, ask_id AS askId, text, kind, options, multiple, no_label AS noLabel,
  yes_label AS yesLabel, start_todos AS startTodos, state, answer, answered_by AS answeredBy,
  answered_at AS answeredAt, created_at AS createdAt FROM neo_questions`;

type QuestionRow = Omit<NeoQuestion, 'options' | 'multiple' | 'startTodos' | 'answer'> & {
  options: string | null;
  multiple: number;
  startTodos: string | null;
  answer: string | null;
};

const parsed = <T>(json: string | null): T | null => (json ? (JSON.parse(json) as T) : null);

const toQuestion = (row: QuestionRow): NeoQuestion => ({
  ...row,
  options: parsed<string[]>(row.options),
  multiple: row.multiple === 1,
  startTodos: parsed<string[]>(row.startTodos),
  answer: parsed<NeoQuestionAnswer>(row.answer),
});

type TodoRow = Omit<NeoTodo, 'check' | 'named' | 'addedAfterStart'> & {
  checkJson: string | null;
  named: string | null;
  addedAfterStart: number;
};

const toTodo = ({ checkJson, named, addedAfterStart, ...row }: TodoRow): NeoTodo => ({
  ...row,
  check: parsed<NeoTodoCheck>(checkJson),
  named: parsed<Record<string, unknown>>(named),
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

  findAsk(sessionId: string, originMessageId: string | null, title: string): NeoAsk | null {
    return (
      (this.db
        .prepare(
          `${ASK_SELECT} WHERE session_id = ? AND origin_message_id IS ? AND title = ? AND status = 'open'`
        )
        .get(sessionId, originMessageId, title) as NeoAsk | null) ?? null
    );
  }

  settleAsk(ask: NeoAsk, status: 'done' | 'dropped', outcome: string, now: number): NeoAsk {
    this.db
      .prepare(
        "UPDATE neo_asks SET status = ?, outcome = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status = 'open'"
      )
      .run(status, outcome, now, now, ask.id);
    this.db
      .prepare(
        "UPDATE neo_todos SET state = 'removed', reason = ?, finished_at = ?, updated_at = ? WHERE ask_id = ? AND state IN ('todo', 'doing')"
      )
      .run(`The ask was settled ${status}.`, now, now, ask.id);
    this.retireQuestions(ask.id, now);
    return this.getAsk(ask.id)!;
  }

  getAsk(id: string): NeoAsk | null {
    return (this.db.prepare(`${ASK_SELECT} WHERE id = ?`).get(id) as NeoAsk | null) ?? null;
  }

  listAsks(projectId: string | null | undefined, limit: number): NeoAsk[] {
    return this.db
      .prepare(
        `${ASK_SELECT} WHERE (?1 = 0 OR project_id IS ?2)
          ORDER BY status = 'open' DESC, updated_at DESC LIMIT ?3`
      )
      .all(projectId === undefined ? 0 : 1, projectId ?? null, limit) as NeoAsk[];
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

  claimStart(todo: NeoTodo, now: number): NeoTodo | null {
    const changed = this.db
      .prepare(
        "UPDATE neo_todos SET state = 'doing', started_at = ?, updated_at = ? WHERE id = ? AND state = 'todo'"
      )
      .run(now, now, todo.id).changes;
    if (!changed) return null;
    this.touchAsk(todo.askId, now);
    return this.getTodo(todo.id);
  }

  listCheckable(): NeoTodo[] {
    return (
      this.db
        .prepare(
          `${TODO_SELECT} WHERE check_json IS NOT NULL AND state IN ('todo', 'doing')
             AND ask_id IN (SELECT id FROM neo_asks WHERE status = 'open')`
        )
        .all() as TodoRow[]
    ).map(toTodo);
  }

  getQuestion(id: string): NeoQuestion | null {
    const row = this.db.prepare(`${QUESTION_SELECT} WHERE id = ?`).get(id) as QuestionRow | null;
    return row ? toQuestion(row) : null;
  }

  listQuestions(askId: string): NeoQuestion[] {
    return (
      this.db
        .prepare(`${QUESTION_SELECT} WHERE ask_id = ? ORDER BY created_at, rowid`)
        .all(askId) as QuestionRow[]
    ).map(toQuestion);
  }

  askQuestion(id: string, askId: string, draft: NeoQuestionDraft, now: number): NeoQuestion {
    this.db
      .prepare(
        `INSERT INTO neo_questions (id, ask_id, text, kind, options, multiple, no_label, yes_label,
           start_todos, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        askId,
        draft.text,
        draft.kind,
        draft.options ? JSON.stringify(draft.options) : null,
        draft.multiple ? 1 : 0,
        draft.noLabel,
        draft.yesLabel,
        draft.startTodos ? JSON.stringify(draft.startTodos) : null,
        now
      );
    this.touchAsk(askId, now);
    return this.getQuestion(id)!;
  }

  answerQuestion(
    question: NeoQuestion,
    answer: NeoQuestionAnswer,
    by: 'button' | 'chat',
    now: number
  ): NeoQuestion | null {
    const changed = this.db
      .prepare(
        `UPDATE neo_questions SET state = 'answered', answer = ?, answered_by = ?, answered_at = ?
         WHERE id = ? AND state = 'open'`
      )
      .run(JSON.stringify(answer), by, now, question.id).changes;
    if (!changed) return null;
    this.touchAsk(question.askId, now);
    return this.getQuestion(question.id);
  }

  retireQuestions(askId: string, now: number): void {
    this.db
      .prepare("UPDATE neo_questions SET state = 'retired' WHERE ask_id = ? AND state = 'open'")
      .run(askId);
    this.touchAsk(askId, now);
  }

  private touchAsk(askId: string, now: number): void {
    this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(now, askId);
    this.changed();
  }
}
