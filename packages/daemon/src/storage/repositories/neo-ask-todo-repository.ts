import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { NeoQuestionAnswerRepository } from './neo-question-answer-repository.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';
import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import { NeoPublicationRepository } from './neo-publication-repository.ts';
import { neoDerivedId } from '../../lib/neo/derived-id.ts';
import {
  recomputeTodoState,
  recomputeTodoStateAsync,
  type TodoStateFacts,
} from '../../lib/neo/todo-state.ts';
import type { NeoTodoJudgement } from '../../lib/neo/pack-contract.ts';
import { applyNeoRuleAnswer } from './neo-rule-answer.ts';
import { SettingsRepository } from './settings-repository.ts';
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
  origin_message_id AS originMessageId, title, request, status, outcome, focused_session_json AS focusedSessionJson,
  created_at AS createdAt, updated_at AS updatedAt, settled_at AS settledAt FROM neo_asks`;

const ASK_ATTENTION = `(status = 'open'
  OR EXISTS (SELECT 1 FROM neo_todos t WHERE t.ask_id = neo_asks.id
    AND t.state NOT IN ('done', 'removed'))
  OR EXISTS (SELECT 1 FROM neo_questions q WHERE q.ask_id = neo_asks.id AND q.state = 'open'))`;

type AskRow = Omit<NeoAsk, 'focusedSession'> & { focusedSessionJson: string | null };
const toAsk = ({ focusedSessionJson, ...row }: AskRow): NeoAsk => ({
  ...row,
  ...(focusedSessionJson
    ? { focusedSession: JSON.parse(focusedSessionJson) as NeoAsk['focusedSession'] }
    : {}),
});
const foundAsk = (row: AskRow | null): NeoAsk | null => (row ? toAsk(row) : null);

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

export interface NeoCardReplyContext {
  conversationId: string;
  sourceMessageIds: readonly string[];
  language?: LanguageSetting;
}

export class NeoAskTodoRepository {
  requestWorkerSocket(sessionId: string, socket: string) {
    const id = neoDerivedId(`worker-socket:${socket}`);
    const prior = this.getQuestion(id);
    const allowed = new SettingsRepository(this.db).getGlobalSettings().workerUnixSockets ?? [];
    if (prior) {
      if (prior.state === 'answered' && prior.answer === 'yes' && !allowed.includes(socket)) {
        this.changeQuestion(id, {
          state: 'open',
          answer: null,
          answered_by: null,
          answered_at: null,
        });
        this.touchAsk(prior.askId, Date.now());
      }
      return this.getQuestion(id);
    }
    if (allowed.includes(socket)) return null;
    const askId = neoDerivedId(`worker-socket-ask:${socket}`);
    const display = socket.replace(
      /\p{Bidi_Control}/gu,
      (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`
    );
    const text = `Workers need ${display} to sign commits. Allow all workers to use it?`;
    this.openAsk({
      id: askId,
      sessionId,
      projectId: null,
      originMessageId: null,
      title: 'Worker socket access',
      request: `worker-socket:${socket}`,
      createdAt: Date.now(),
    });
    return this.askQuestion(
      id,
      askId,
      {
        text,
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: 'Decline',
        yesLabel: 'Allow',
        startTodos: null,
      },
      Date.now()
    );
  }
  get questionAnswers() {
    return new NeoQuestionAnswerRepository(
      this.db,
      (id, routes) => {
        this.changeQuestion(id, { worker_answers_json: routes });
      },
      (work) => this.db.transaction(work, 'immediate')()
    );
  }

  read<K extends (typeof neoTodoReads.methods)[number]>(
    method: K,
    ...args: Parameters<NeoAskTodoRepository[K]>
  ): Promise<ReturnType<NeoAskTodoRepository[K]>> {
    return gatewayFor(this.db).call(neoTodoReads, method, ...(args as never)) as Promise<
      ReturnType<NeoAskTodoRepository[K]>
    >;
  }

  write<K extends (typeof neoTodoWrites.methods)[number]>(
    method: K,
    ...args: Parameters<NeoAskTodoRepository[K]>
  ): Promise<ReturnType<NeoAskTodoRepository[K]>> {
    return gatewayFor(this.db).call(neoTodoWrites, method, ...(args as never)) as Promise<
      ReturnType<NeoAskTodoRepository[K]>
    >;
  }

  snapshot(
    projectId: string | null | undefined,
    limit: number,
    work = false,
    before?: { updatedAt: number; id: string }
  ) {
    const asks = this.listAsks(projectId, limit, work, before);
    const ids = asks.map((ask) => ask.id);
    const todos = this.listTodosForAsks(ids);
    const questions = this.listQuestionsForAsks(ids);
    const attention = new Set([
      ...todos
        .filter((todo) => !['done', 'removed'].includes(todo.state))
        .map((todo) => todo.askId),
      ...questions
        .filter((question) => question.state === 'open')
        .map((question) => question.askId),
    ]);
    const last = asks.filter((ask) => ask.status !== 'open' && !attention.has(ask.id)).at(-1);
    const unlisted = this.countAsks(projectId) - asks.length;
    return {
      asks,
      unlisted,
      historyCursor:
        work && unlisted > 0 && last ? { updatedAt: last.updatedAt, id: last.id } : null,
      facts: {
        todos,
        questions,
        links: new NeoTodoSessionRepository(this.db).readLinksForTodos(
          todos.map((todo) => todo.id)
        ),
      },
    };
  }

  askFacts(input: { askId?: string; todoId?: string; questionId?: string }) {
    const askId =
      input.askId ??
      (input.todoId ? this.getTodo(input.todoId)?.askId : undefined) ??
      (input.questionId ? this.getQuestion(input.questionId)?.askId : undefined) ??
      '';
    return { ...this.doneTodoFacts(askId), questions: this.listQuestionsForAsks([askId]) };
  }

  doneTodoFacts(askId: string) {
    const todos = this.listTodos(askId);
    return {
      ask: this.getAsk(askId),
      todos,
      links: new NeoTodoSessionRepository(this.db).readLinksForTodos(todos.map((todo) => todo.id)),
    };
  }

  followedRefs() {
    const sessions = new NeoTodoSessionRepository(this.db);
    return this.listCheckable().flatMap((todo) => sessions.readRef(todo.id) ?? []);
  }

  todoLinks(ids: readonly string[]) {
    return new NeoTodoSessionRepository(this.db).readLinksForTodos(ids);
  }

  constructor(
    private readonly db: Database,
    private readonly changed: () => void = () => {},
    private readonly rulesChanged: () => void = () => {}
  ) {}

  cardReplyQuestion(conversationId: string, mutationId: string): NeoQuestion | null {
    const row = this.db
      .prepare(`SELECT json_extract(payload_json, '$.cardReply.questionId') AS id
      FROM neo_publications WHERE conversation_id = ? AND
      (json_extract(payload_json, '$.cardReply.mutationId') = ? OR EXISTS
        (SELECT 1 FROM json_each(payload_json, '$.revisions') r WHERE json_extract(r.value, '$.revisionId') = ?)) LIMIT 1`)
      .get(conversationId, mutationId, mutationId) as { id: string } | null;
    return row ? this.getQuestion(row.id) : null;
  }

  writeCardReply(
    context: NeoCardReplyContext | null,
    mutationId: string,
    write: () => NeoQuestion | null
  ): NeoQuestion | null {
    return this.db.transaction(() => {
      const prior = context ? this.cardReplyQuestion(context.conversationId, mutationId) : null;
      if (prior) return prior;
      const question = write();
      if (question && context) {
        const zh =
          context.language === 'zh-Hans' ||
          ((!context.language || context.language === 'system') &&
            Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh'));
        const shortText = `${zh ? '我给你回了 · 查看卡片' : 'I replied · View card'} · ${question.text.slice(0, 120)}`;
        const result = new NeoPublicationRepository(this.db).append({
          conversationId: context.conversationId,
          publicationId: neoDerivedId(`card-reply:${context.conversationId}:${mutationId}`),
          shortText,
          fullText: shortText,
          links: [],
          cardReply: {
            sourceMessageIds: [...new Set(context.sourceMessageIds)].sort(),
            askId: question.askId,
            questionId: question.id,
            mutationId,
          },
        });
        if (!result.accepted) throw new Error('Card reply publication rejected');
      }
      return question;
    })();
  }

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

  focusAsk(id: string, source: NonNullable<NeoAsk['focusedSession']>, now: number): void {
    this.db
      .prepare(
        "UPDATE neo_asks SET focused_session_json = ?, updated_at = ? WHERE id = ? AND status = 'open'"
      )
      .run(JSON.stringify(source), now, id);
    this.changed();
  }

  findAsk(
    sessionId: string,
    originMessageId: string | null,
    title: string,
    goalId: string | null = null
  ): NeoAsk | null {
    return foundAsk(
      (this.db
        .prepare(
          `${ASK_SELECT} WHERE session_id = ? AND origin_message_id IS ? AND title = ? AND goal_id IS ?
           AND (status = 'open' OR (status = 'done'
             AND EXISTS (SELECT 1 FROM neo_asks c WHERE c.parent_id = neo_asks.id)))`
        )
        .get(sessionId, originMessageId, title, goalId) as AskRow | null) ?? null
    );
  }

  childAsk(parentId: string, repo: string): NeoAsk | null {
    return foundAsk(
      (this.db
        .prepare(`${ASK_SELECT} WHERE parent_id = ? AND repo = ? AND status = 'open'`)
        .get(parentId, repo) as AskRow | null) ?? null
    );
  }

  listChildAsks(parentId: string): NeoAsk[] {
    return (
      this.db
        .prepare(`${ASK_SELECT} WHERE parent_id = ? ORDER BY created_at, rowid`)
        .all(parentId) as AskRow[]
    ).map(toAsk);
  }

  listGoalAsks(goalId: string): NeoAsk[] {
    return (
      this.db
        .prepare(`${ASK_SELECT} WHERE goal_id = ? ORDER BY created_at, id`)
        .all(goalId) as AskRow[]
    ).map(toAsk);
  }

  recordAskOutcome(id: string, outcome: string, now: number): NeoAsk {
    this.db
      .prepare("UPDATE neo_asks SET outcome = ?, updated_at = ? WHERE id = ? AND status = 'open'")
      .run(outcome, now, id);
    this.changed();
    return this.getAsk(id)!;
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
    return foundAsk(this.db.prepare(`${ASK_SELECT} WHERE id = ?`).get(id) as AskRow | null);
  }

  listAsks(
    projectId: string | null | undefined,
    limit: number,
    work = false,
    before?: { updatedAt: number; id: string }
  ): NeoAsk[] {
    const window = work
      ? `(?6 = 1 AND ${ASK_ATTENTION}) OR id IN (
          SELECT id FROM neo_asks WHERE (?1 = 0 OR project_id IS ?2) AND NOT ${ASK_ATTENTION}
            AND (?4 IS NULL OR (updated_at, id) < (?4, ?5))
          ORDER BY updated_at DESC, id DESC LIMIT ?3)`
      : `id IN (SELECT id FROM neo_asks WHERE (?1 = 0 OR project_id IS ?2)
          ORDER BY status = 'open' DESC, updated_at DESC LIMIT ?3)`;
    return (
      this.db
        .prepare(
          `${ASK_SELECT} WHERE (?1 = 0 OR project_id IS ?2) AND (${window})
          ORDER BY status = 'open' DESC, updated_at DESC, id DESC`
        )
        .all(
          projectId === undefined ? 0 : 1,
          projectId ?? null,
          limit,
          ...(work ? [before?.updatedAt ?? null, before?.id ?? null, before ? 0 : 1] : [])
        ) as AskRow[]
    ).map(toAsk);
  }

  countAsks(projectId: string | null | undefined): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM neo_asks WHERE (?1 = 0 OR project_id IS ?2)')
        .get(projectId === undefined ? 0 : 1, projectId ?? null) as { count: number }
    ).count;
  }

  listOpenAsks(): NeoAsk[] {
    return (this.db.prepare(`${ASK_SELECT} WHERE status = 'open'`).all() as AskRow[]).map(toAsk);
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
    return (
      this.db
        .prepare(`${ASK_SELECT} WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(ids)) as AskRow[]
    ).map(toAsk);
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
      humanAnswerDelivered:
        todo.blockedBy === 'needs-human' &&
        this.questionAnswers.delivered(todo.id, live?.ref ?? null),
      askOpen: this.getAsk(todo.askId)?.status === 'open',
      order: this.db
        .prepare(
          `SELECT id, state, started_at AS startedAt,
            EXISTS (SELECT 1 FROM neo_questions q WHERE q.ask_id = neo_todos.ask_id AND q.state = 'open'
              AND (q.todo_id IS NULL OR q.todo_id = neo_todos.id)
              AND (q.kind != 'start' OR EXISTS (SELECT 1 FROM json_each(q.start_todos) WHERE value = neo_todos.id))) AS questionOpen
           FROM neo_todos WHERE ask_id = ? ORDER BY position, created_at`
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

  commitState(
    todoId: string,
    change: NeoTodoPatch,
    now: number,
    judgement: NeoTodoJudgement
  ): { todo: NeoTodo | null; startNext: string | null } {
    const current = this.getTodo(todoId);
    if (!current) return { todo: null, startNext: null };
    this.pruneQuestions(current.askId, now);
    if (current.state === 'removed') return { todo: current, startNext: null };
    return recomputeTodoState(
      () => this.stateFacts(current, change, judgement),
      (plan) => ({ todo: this.writeTodo(current, plan.patch, now)!, startNext: plan.startNext }),
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
    if (open)
      this.extendStartQuestion(
        open.id,
        startTodos,
        text,
        now,
        undefined,
        undefined,
        open.sourceSession
      );
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
      const answered = this.changeQuestion(
        question.id,
        { state: 'answered', answer: JSON.stringify(answer), answered_by: by, answered_at: now },
        'open'
      );
      if (answered) {
        const request = this.getAsk(question.askId)?.request;
        const socket = request?.startsWith('worker-socket:')
          ? request.slice('worker-socket:'.length)
          : null;
        if (socket && question.id === neoDerivedId(`worker-socket:${socket}`) && answer === 'yes') {
          const settings = new SettingsRepository(this.db);
          const allowed = settings.getGlobalSettings().workerUnixSockets ?? [];
          settings.updateGlobalSettings({ workerUnixSockets: [...new Set([...allowed, socket])] });
          rulesChanged = true;
        }
        this.releaseStartTodos(question.id, now);
        if (answer === 'yes') {
          applyPackPreferenceAnswer(this.db, question.id);
          const rules = applyNeoRuleAnswer(this.db, question.id);
          rulesChanged ||= rules.ok && rules.changed;
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
      const retired = this.changeQuestion(
        question.id,
        { state: 'retired', retired_reason: reason, replaced_by: replacedBy },
        'open'
      );
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

  private changeQuestion(
    id: string,
    patch: Record<string, string | number | null>,
    state?: NeoQuestion['state']
  ): number {
    return this.db
      .prepare(`UPDATE neo_questions SET ${Object.keys(patch)
        .map((key) => `${key} = ?`)
        .join(', ')}
      WHERE id = ?${state ? ' AND state = ?' : ''}`)
      .run(...Object.values(patch), id, ...(state ? [state] : [])).changes;
  }

  private touchAsk(askId: string, now: number): void {
    this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(now, askId);
    this.changed();
  }
}

export const neoTodoReads = defineRepositoryOp(
  'neo.todoReads',
  'read',
  class extends NeoAskTodoRepository {
    constructor(db: Database) {
      super(db);
    }
  },
  [
    'snapshot',
    'doneTodoFacts',
    'askFacts',
    'listCheckable',
    'listOpenAsks',
    'listTodosForAsks',
    'followedRefs',
    'listStalledAsks',
    'listGoalAsks',
    'todoLinks',
  ]
);

export const neoTodoWrites = defineRepositoryOp(
  'neo.todoWrites',
  'write',
  class extends NeoAskTodoRepository {
    constructor(db: Database) {
      super(db);
    }
  },
  ['commitState', 'requestWorkerSocket']
);
