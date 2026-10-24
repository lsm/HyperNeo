import {
  recomputeTodoState,
  recomputeTodoStateAsync,
  type TodoStateFacts,
} from '../../lib/neo/todo-state.ts';
import type { NeoTodoJudgement } from '../../lib/neo/pack-contract.ts';
import { applyNeoRuleAnswer } from './neo-rule-answer.ts';
import { applyPackPreferenceAnswer } from './pack-preference-answer.ts';
import type {
  NeoAsk,
  NeoQuestion,
  NeoQuestionAnswer,
  NeoTodo,
  NeoTodoCheck,
} from '@hyperneo/shared/types/neo-ask';
import { neoStartQuestionTitle } from '../../lib/neo/start-question.ts';
import type { Database } from '../sqlite-compat.ts';

export type NeoTodoDraft = Pick<NeoTodo, 'title' | 'doneWhen' | 'check' | 'instruction' | 'named'>;

export type NeoTodoPatch = Partial<
  Pick<
    NeoTodo,
    | 'title'
    | 'check'
    | 'doneWhen'
    | 'state'
    | 'reason'
    | 'replacedBy'
    | 'report'
    | 'evidence'
    | 'artifacts'
    | 'startedAt'
    | 'finishedAt'
    | 'blockedReason'
    | 'nextAction'
    | 'blockedBy'
  >
>;

const TODO_COLUMNS: Record<keyof NeoTodoPatch, string> = {
  title: 'title',
  check: 'check_json',
  doneWhen: 'done_when',
  state: 'state',
  reason: 'reason',
  replacedBy: 'replaced_by',
  report: 'report',
  evidence: 'evidence',
  artifacts: 'artifacts_json',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  blockedReason: 'blocked_reason',
  nextAction: 'next_action',
  blockedBy: 'blocked_by',
};

const ASK_SELECT = `SELECT id, goal_id AS goalId, project_id AS projectId, repo, parent_id AS parentId, session_id AS sessionId,
  origin_message_id AS originMessageId, title, request, status, outcome,
  created_at AS createdAt, updated_at AS updatedAt, settled_at AS settledAt FROM neo_asks`;

const TODO_SELECT = `SELECT id, ask_id AS askId, position, title, done_when AS doneWhen,
  check_json AS checkJson, instruction, named, repo, state, reason, blocked_reason AS blockedReason,
  next_action AS nextAction, blocked_by AS blockedBy, replaced_by AS replacedBy,
  added_after_start AS addedAfterStart, report, evidence, artifacts_json AS artifactsJson, created_at AS createdAt,
  updated_at AS updatedAt, started_at AS startedAt, finished_at AS finishedAt FROM neo_todos`;

export type NeoQuestionDraft = Pick<
  NeoQuestion,
  | 'text'
  | 'kind'
  | 'options'
  | 'multiple'
  | 'noLabel'
  | 'yesLabel'
  | 'startTodos'
  | 'confirm'
  | 'document'
  | 'replyTo'
  | 'todoId'
  | 'artifacts'
  | 'sourceSession'
>;

const QUESTION_SELECT = `SELECT id, ask_id AS askId, todo_id AS todoId, text, kind, options, multiple, no_label AS noLabel,
  yes_label AS yesLabel, start_todos AS startTodos, state, answer, answered_by AS answeredBy,
  answered_at AS answeredAt, retired_reason AS retiredReason, replaced_by AS replacedBy,
  confirm_json AS confirmJson, reply_to_json AS replyToJson, artifacts_json AS artifactsJson, source_session_json AS sourceSessionJson, document, created_at AS createdAt FROM neo_questions`;

type QuestionRow = Omit<
  NeoQuestion,
  | 'options'
  | 'multiple'
  | 'startTodos'
  | 'answer'
  | 'confirm'
  | 'replyTo'
  | 'artifacts'
  | 'sourceSession'
> & {
  artifactsJson: string | null;
  sourceSessionJson: string | null;
  confirmJson: string | null;
  replyToJson: string | null;
  options: string | null;
  multiple: number;
  startTodos: string | null;
  answer: string | null;
};

const parsed = <T>(json: string | null): T | null => (json ? (JSON.parse(json) as T) : null);

const toQuestion = ({
  confirmJson,
  replyToJson,
  artifactsJson,
  sourceSessionJson,
  todoId,
  ...row
}: QuestionRow): NeoQuestion => ({
  ...row,
  ...(sourceSessionJson
    ? { sourceSession: JSON.parse(sourceSessionJson) as NeoQuestion['sourceSession'] }
    : {}),
  ...(artifactsJson ? { artifacts: JSON.parse(artifactsJson) as NeoQuestion['artifacts'] } : {}),
  ...(todoId ? { todoId } : {}),
  ...(replyToJson ? { replyTo: JSON.parse(replyToJson) as string[] } : {}),
  confirm: parsed<NonNullable<NeoQuestion['confirm']>>(confirmJson),
  options: parsed<string[]>(row.options),
  multiple: row.multiple === 1,
  startTodos: parsed<string[]>(row.startTodos),
  answer: parsed<NeoQuestionAnswer>(row.answer),
});

type TodoRow = Omit<NeoTodo, 'check' | 'named' | 'addedAfterStart' | 'artifacts'> & {
  checkJson: string | null;
  artifactsJson: string | null;
  named: string | null;
  addedAfterStart: number;
};

const toTodo = ({
  checkJson,
  artifactsJson,
  named,
  addedAfterStart,
  ...row
}: TodoRow): NeoTodo => ({
  ...row,
  ...(artifactsJson ? { artifacts: JSON.parse(artifactsJson) as NeoTodo['artifacts'] } : {}),
  check: parsed<NeoTodoCheck>(checkJson),
  named: parsed<Record<string, unknown>>(named),
  addedAfterStart: addedAfterStart === 1,
});

const isStartable = (todo: NeoTodo) =>
  todo.state === 'todo' || (todo.state === 'blocked' && todo.blockedBy === 'question');

export class NeoAskTodoRepository {
  constructor(
    private readonly db: Database,
    private readonly changed: () => void = () => {},
    private readonly rulesChanged: () => void = () => {}
  ) {}

  openAsk(
    ask: Omit<NeoAsk, 'repo' | 'parentId' | 'status' | 'outcome' | 'updatedAt' | 'settledAt'> &
      Partial<Pick<NeoAsk, 'repo' | 'parentId'>>
  ): NeoAsk {
    this.db
      .prepare(
        `INSERT INTO neo_asks (id, goal_id, project_id, repo, parent_id, session_id, origin_message_id, title, request, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ask.id,
        ask.goalId ?? null,
        ask.projectId,
        ask.repo ?? null,
        ask.parentId ?? null,
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

  findAsk(
    sessionId: string,
    originMessageId: string | null,
    title: string,
    goalId: string | null = null
  ): NeoAsk | null {
    return (
      (this.db
        .prepare(
          `${ASK_SELECT} WHERE session_id = ? AND origin_message_id IS ? AND title = ? AND goal_id IS ?
           AND (status = 'open' OR (status = 'done'
             AND EXISTS (SELECT 1 FROM neo_asks c WHERE c.parent_id = neo_asks.id)))`
        )
        .get(sessionId, originMessageId, title, goalId) as NeoAsk | null) ?? null
    );
  }

  childAsk(parentId: string, repo: string): NeoAsk | null {
    return (
      (this.db
        .prepare(`${ASK_SELECT} WHERE parent_id = ? AND repo = ? AND status = 'open'`)
        .get(parentId, repo) as NeoAsk | null) ?? null
    );
  }

  listChildAsks(parentId: string): NeoAsk[] {
    return this.db
      .prepare(`${ASK_SELECT} WHERE parent_id = ? ORDER BY created_at, rowid`)
      .all(parentId) as NeoAsk[];
  }

  listGoalAsks(goalId: string): NeoAsk[] {
    return this.db
      .prepare(`${ASK_SELECT} WHERE goal_id = ? ORDER BY created_at, id`)
      .all(goalId) as NeoAsk[];
  }

  settleAsk(ask: NeoAsk, status: 'done' | 'dropped', outcome: string, now: number): NeoAsk {
    this.db
      .prepare(
        "UPDATE neo_asks SET status = ?, outcome = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status = 'open'"
      )
      .run(status, outcome, now, now, ask.id);
    for (const todo of this.listTodos(ask.id))
      if (['todo', 'doing', 'blocked'].includes(todo.state))
        this.updateTodo(
          todo,
          { state: 'removed', reason: `The ask was settled ${status}.`, finishedAt: now },
          now
        );
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

  countAsks(projectId: string | null | undefined): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM neo_asks WHERE (?1 = 0 OR project_id IS ?2)')
        .get(projectId === undefined ? 0 : 1, projectId ?? null) as { count: number }
    ).count;
  }

  listOpenAsks(): NeoAsk[] {
    return this.db.prepare(`${ASK_SELECT} WHERE status = 'open'`).all() as NeoAsk[];
  }

  listStalledAsks(
    before: number,
    repeatBefore: number | null = null
  ): {
    id: string;
    sessionId: string;
    title: string;
    wakeKey: string;
  }[] {
    return this.db
      .prepare(`SELECT id, session_id AS sessionId, title,
      'neo-stalled-ask:' || id || ':' || updated_at || ':' || COALESCE(stalled_wake_at, 0) AS wakeKey
      FROM neo_asks WHERE status = 'open' AND updated_at <= ?1
      AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = neo_asks.session_id AND sessions.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM neo_todos WHERE ask_id = neo_asks.id AND state IN ('todo', 'doing'))
      AND NOT EXISTS (SELECT 1 FROM neo_questions WHERE ask_id = neo_asks.id AND state = 'open')
      AND (?2 IS NULL OR stalled_wake_at IS NULL OR stalled_wake_at <= ?2)`)
      .all(before, repeatBefore) as {
      id: string;
      sessionId: string;
      title: string;
      wakeKey: string;
    }[];
  }

  recordStalledAskWake(askId: string, now: number): void {
    this.db.prepare('UPDATE neo_asks SET stalled_wake_at = ? WHERE id = ?').run(now, askId);
  }

  getTodo(id: string): NeoTodo | null {
    const row = this.db.prepare(`${TODO_SELECT} WHERE id = ?`).get(id) as TodoRow | null;
    return row ? toTodo(row) : null;
  }

  getTodos(ids: readonly string[]): NeoTodo[] {
    return (
      this.db
        .prepare(`${TODO_SELECT} WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(ids)) as TodoRow[]
    ).map(toTodo);
  }

  getAsks(ids: readonly string[]): NeoAsk[] {
    return this.db
      .prepare(`${ASK_SELECT} WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as NeoAsk[];
  }

  listTodos(askId: string): NeoTodo[] {
    return (
      this.db
        .prepare(`${TODO_SELECT} WHERE ask_id = ? ORDER BY position, created_at`)
        .all(askId) as TodoRow[]
    ).map(toTodo);
  }

  listTodosForAsks(askIds: readonly string[]): NeoTodo[] {
    return (
      this.db
        .prepare(`${TODO_SELECT} WHERE ask_id IN (SELECT value FROM json_each(?))
          ORDER BY ask_id, position, created_at`)
        .all(JSON.stringify(askIds)) as TodoRow[]
    ).map(toTodo);
  }

  addTodo(
    id: string,
    askId: string,
    draft: NeoTodoDraft,
    now: number,
    repo: string | null = null
  ): NeoTodo {
    const home = this.getAsk(askId)?.repo;
    if (repo && home && home !== repo)
      throw new Error(`todo_repo_mismatch: a ${repo} todo cannot join a ${home} card.`);
    this.db
      .prepare(
        `INSERT INTO neo_todos (id, ask_id, position, title, done_when, check_json, instruction, named,
           repo, added_after_start, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM neo_todos WHERE ask_id = ?), ?, ?, ?, ?, ?, ?,
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
        repo,
        askId,
        now,
        now
      );
    if (repo)
      this.db
        .prepare('UPDATE neo_asks SET repo = ? WHERE id = ? AND repo IS NULL')
        .run(repo, askId);
    this.touchAsk(askId, now);
    return this.getTodo(id)!;
  }

  moveTodo(todo: NeoTodo, askId: string, repo: string, now: number): NeoTodo {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE neo_todos SET repo = ?2, position = CASE WHEN ask_id = ?1 THEN position
             ELSE (SELECT COALESCE(MAX(position) + 1, 0) FROM neo_todos WHERE ask_id = ?1) END, ask_id = ?1
           WHERE id = ?3`
        )
        .run(askId, repo, todo.id);
      this.pruneQuestions(todo.askId, now);
      const moved = this.getTodo(todo.id)!;
      if (askId !== todo.askId && moved.instruction && isStartable(moved))
        this.joinStartQuestion(moved, now);
    })();
    this.db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ? AND repo IS NULL').run(repo, askId);
    this.touchAsk(todo.askId, now);
    if (askId !== todo.askId) this.touchAsk(askId, now);
    return this.getTodo(todo.id)!;
  }

  private stateFacts(
    todo: NeoTodo,
    change: NeoTodoPatch,
    judgement: NeoTodoJudgement
  ): TodoStateFacts {
    const live = this.db
      .prepare('SELECT ref, live_status AS status FROM neo_todo_sessions WHERE todo_id = ?')
      .get(todo.id) as { ref: string | null; status: string | null } | null;
    return {
      todo,
      change,
      judgement,
      askOpen: this.getAsk(todo.askId)?.status === 'open',
      order: this.db
        .prepare(
          'SELECT id, state, started_at AS startedAt FROM neo_todos WHERE ask_id = ? ORDER BY position, created_at'
        )
        .all(todo.askId) as TodoStateFacts['order'],
      questionOpen: !!this.db
        .prepare(`SELECT 1 FROM neo_questions WHERE ask_id = ? AND state = 'open'
        AND (todo_id IS NULL OR todo_id = ?)
        AND (kind != 'start' OR EXISTS (SELECT 1 FROM json_each(start_todos) WHERE value = ?)) LIMIT 1`)
        .get(todo.askId, todo.id, todo.id),
      dispatched: !!live?.ref || todo.startedAt !== null,
      live: live?.status ?? null,
    };
  }

  updateTodo(todo: NeoTodo, change: NeoTodoPatch, now: number): NeoTodo {
    const current = this.getTodo(todo.id)!;
    this.pruneQuestions(current.askId, now);
    return recomputeTodoState(
      () => this.stateFacts(current, change, { state: 'no_opinion' }),
      (decision) => this.writeTodo(current, decision.patch, now)!,
      now
    );
  }

  async recompute(
    todo: NeoTodo,
    change: NeoTodoPatch,
    now: number,
    judgement: NeoTodoJudgement,
    advance: (id: string) => Promise<unknown>
  ): Promise<NeoTodo> {
    const current = this.getTodo(todo.id)!;
    this.pruneQuestions(current.askId, now);
    if (current.state === 'removed') return current;
    return recomputeTodoStateAsync(
      () => this.stateFacts(current, change, judgement),
      async (plan) => {
        const written = this.writeTodo(current, plan.patch, now)!;
        if (plan.startNext) await advance(plan.startNext);
        return written;
      },
      now
    );
  }

  private writeTodo(
    todo: NeoTodo,
    change: NeoTodoPatch,
    now: number,
    claim = false
  ): NeoTodo | null {
    if (!Object.keys(change).length) return this.getTodo(todo.id);
    const patch: NeoTodoPatch =
      change.state && change.state !== 'blocked'
        ? { ...change, blockedReason: null, nextAction: null, blockedBy: null }
        : change;
    const keys = Object.keys(patch) as (keyof NeoTodoPatch)[];
    const changed = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE neo_todos SET ${keys.map((key) => `${TODO_COLUMNS[key]} = ?`).join(', ')}${
            keys.length ? ', ' : ''
          }updated_at = ? WHERE id = ?${claim ? " AND (state = 'todo' OR (state = 'blocked' AND blocked_by = 'question'))" : ''}`
        )
        .run(
          ...keys.map((key) =>
            key === 'check' || key === 'artifacts'
              ? JSON.stringify(patch[key] ?? null)
              : (patch[key] ?? null)
          ),
          now,
          todo.id
        );
      if (result.changes && patch.state) this.pruneQuestions(todo.askId, now);
      return result.changes;
    })();
    if (!changed) return null;
    this.touchAsk(todo.askId, now);
    return this.getTodo(todo.id)!;
  }

  claimStart(todo: NeoTodo, now: number): NeoTodo | null {
    const current = this.getTodo(todo.id)!;
    this.pruneQuestions(current.askId, now);
    return recomputeTodoState(
      () => this.stateFacts(current, { state: 'doing', startedAt: now }, { state: 'no_opinion' }),
      (decision) =>
        decision.patch.state === 'doing'
          ? this.writeTodo(current, decision.patch, now, true)
          : null,
      now
    );
  }

  listCheckable(): NeoTodo[] {
    return (
      this.db
        .prepare(
          `${TODO_SELECT} WHERE state IN ('todo', 'doing', 'blocked')
             AND ask_id IN (SELECT id FROM neo_asks WHERE status = 'open')`
        )
        .all() as TodoRow[]
    ).map(toTodo);
  }

  getCheckable(id: string): NeoTodo | null {
    const row = this.db
      .prepare(
        `${TODO_SELECT} WHERE id = ? AND state IN ('todo', 'doing', 'blocked')
           AND ask_id IN (SELECT id FROM neo_asks WHERE status = 'open')`
      )
      .get(id) as TodoRow | null;
    return row ? toTodo(row) : null;
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

  listQuestionsForAsks(askIds: readonly string[]): NeoQuestion[] {
    return (
      this.db
        .prepare(`${QUESTION_SELECT} WHERE ask_id IN (SELECT value FROM json_each(?))
          ORDER BY ask_id, created_at, rowid`)
        .all(JSON.stringify(askIds)) as QuestionRow[]
    ).map(toQuestion);
  }

  askQuestion(id: string, askId: string, draft: NeoQuestionDraft, now: number): NeoQuestion {
    this.db
      .prepare(
        `INSERT INTO neo_questions (id, ask_id, text, kind, options, multiple, no_label, yes_label,
           start_todos, confirm_json, document, reply_to_json, todo_id, artifacts_json, source_session_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        draft.confirm ? JSON.stringify(draft.confirm) : null,
        draft.document ?? null,
        draft.replyTo ? JSON.stringify(draft.replyTo) : null,
        draft.todoId ?? null,
        draft.artifacts ? JSON.stringify(draft.artifacts) : null,
        draft.sourceSession ? JSON.stringify(draft.sourceSession) : null,
        now
      );
    this.touchAsk(askId, now);
    return this.getQuestion(id)!;
  }

  extendStartQuestion(
    id: string,
    startTodos: readonly string[],
    text: string,
    now: number,
    replyTo?: readonly string[],
    artifacts?: NeoQuestion['artifacts'],
    sourceSession?: NeoQuestion['sourceSession']
  ): void {
    const question = this.getQuestion(id);
    if (!question) return;
    this.db
      .prepare(
        "UPDATE neo_questions SET start_todos = ?, text = ?, reply_to_json = COALESCE(?, reply_to_json), artifacts_json = COALESCE(?, artifacts_json), source_session_json = ? WHERE id = ? AND state = 'open'"
      )
      .run(
        JSON.stringify(startTodos),
        text,
        replyTo ? JSON.stringify(replyTo) : null,
        artifacts ? JSON.stringify(artifacts) : null,
        sourceSession ? JSON.stringify(sourceSession) : null,
        id
      );
    this.touchAsk(question.askId, now);
  }

  joinStartQuestion(todo: NeoTodo, now: number): void {
    const todos = this.listTodos(todo.askId);
    const open = this.listQuestions(todo.askId).find(
      (question) => question.kind === 'start' && question.state === 'open'
    );
    const listed = (open?.startTodos ?? []).filter((id) =>
      todos.some((item) => item.id === id && isStartable(item) && item.instruction)
    );
    const startTodos = [...new Set([...listed, todo.id])];
    const text = neoStartQuestionTitle(
      startTodos.map((id) => ({ title: todos.find((item) => item.id === id)?.title }))
    );
    if (open) this.extendStartQuestion(open.id, startTodos, text, now);
    else
      this.askQuestion(
        crypto.randomUUID(),
        todo.askId,
        {
          text,
          kind: 'start',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          startTodos,
        },
        now
      );
  }

  answerQuestion(
    question: NeoQuestion,
    answer: NeoQuestionAnswer,
    by: 'button' | 'chat',
    now: number
  ): NeoQuestion | null {
    let rulesChanged = false;
    const changed = this.db.transaction(() => {
      const answered = this.db
        .prepare(
          `UPDATE neo_questions SET state = 'answered', answer = ?, answered_by = ?, answered_at = ?
           WHERE id = ? AND state = 'open'`
        )
        .run(JSON.stringify(answer), by, now, question.id).changes;
      if (answered) {
        this.releaseStartTodos(question.id, now);
        if (answer === 'yes') {
          applyPackPreferenceAnswer(this.db, question.id);
          const rules = applyNeoRuleAnswer(this.db, question.id);
          rulesChanged = rules.ok && rules.changed;
        }
      }
      return answered;
    })();
    if (!changed) return null;
    this.touchAsk(question.askId, now);
    if (rulesChanged) this.rulesChanged();
    return this.getQuestion(question.id);
  }

  retireQuestion(
    question: NeoQuestion,
    reason: string,
    replacedBy: string | null,
    now: number
  ): NeoQuestion | null {
    const changed = this.db.transaction(() => {
      const retired = this.db
        .prepare(
          `UPDATE neo_questions SET state = 'retired', retired_reason = ?, replaced_by = ?
           WHERE id = ? AND state = 'open'`
        )
        .run(reason, replacedBy, question.id).changes;
      if (retired) this.releaseStartTodos(question.id, now);
      return retired;
    })();
    if (!changed) return null;
    this.touchAsk(question.askId, now);
    return this.getQuestion(question.id);
  }

  replaceQuestion(
    old: NeoQuestion,
    id: string,
    draft: NeoQuestionDraft,
    now: number
  ): NeoQuestion | null {
    return this.db.transaction(() => {
      if (!this.retireQuestion(old, 'replaced by the new question', id, now)) return null;
      return this.askQuestion(id, old.askId, draft, now);
    })();
  }

  retireQuestions(askId: string, now: number): void {
    this.db
      .prepare("UPDATE neo_questions SET state = 'retired' WHERE ask_id = ? AND state = 'open'")
      .run(askId);
    this.touchAsk(askId, now);
  }

  private pruneQuestions(askId: string, now: number): void {
    const todos = this.listTodos(askId);
    const startable = new Set(todos.filter(isStartable).map((todo) => todo.id));
    for (const question of this.listQuestions(askId)) {
      if (question.state !== 'open') continue;
      if (
        question.todoId &&
        !todos.some(
          (todo) => todo.id === question.todoId && !['done', 'removed'].includes(todo.state)
        )
      ) {
        this.retireQuestion(question, 'todo no longer active', null, now);
        continue;
      }
      if (question.kind !== 'start' || question.state !== 'open' || !question.startTodos) continue;
      const kept = question.startTodos.filter((id) => startable.has(id));
      if (kept.length === question.startTodos.length) continue;
      if (!kept.length)
        this.db
          .prepare(
            `UPDATE neo_questions SET start_todos = '[]', state = 'retired',
               retired_reason = 'nothing left to start' WHERE id = ?`
          )
          .run(question.id);
      else
        this.db
          .prepare('UPDATE neo_questions SET start_todos = ?, text = ? WHERE id = ?')
          .run(
            JSON.stringify(kept),
            neoStartQuestionTitle(
              kept.map((id) => ({ title: todos.find((todo) => todo.id === id)?.title }))
            ),
            question.id
          );
    }
  }

  private releaseStartTodos(questionId: string, now: number): void {
    for (const id of this.getQuestion(questionId)?.startTodos ?? []) {
      const todo = this.getTodo(id);
      if (todo?.state === 'blocked' && todo.blockedBy === 'question')
        this.updateTodo(todo, { state: 'todo' }, now);
    }
  }

  private touchAsk(askId: string, now: number): void {
    this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(now, askId);
    this.changed();
  }
}
