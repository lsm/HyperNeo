import { queueNeoRequestReply } from '../../lib/neo/request-todo.ts';
import type {
  NeoAnswerProvenance,
  NeoAsk,
  NeoQuestion,
  NeoQuestionAnswer,
  NeoTodo,
  NeoTodoCheck,
} from '@hyperneo/shared/types/neo-ask';
import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import superpipe, { type PipelineAPI } from 'superpipe';
import { renderAddress } from '../../lib/mailbox/address.ts';
import { enqueueMailboxEntry } from '../../lib/mailbox/enqueue.ts';
import { createMailboxEntry } from '../../lib/mailbox/entry.ts';
import { neoDerivedId } from '../../lib/neo/derived-id.ts';
import type { NeoTodoJudgement } from '../../lib/neo/pack-contract.ts';
import { neoTodoStorage } from '../../lib/neo/packs/todo-storage.ts';
import {
  type NeoQuestionPrune,
  neoTodosAwaitingNeoDecision,
  planNeoQuestionPrune,
} from '../../lib/neo/todo-start-gate.ts';
import {
  neoAskQuestionHolds,
  neoQuestionCoversTodo,
  neoTodoAwaitsHuman,
  recomputeTodoState,
  recomputeTodoStateAsync,
  type TodoStateFacts,
} from '../../lib/neo/todo-state.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import { neoInputText, type NeoUnansweredInput } from '../../lib/neo/plan-context.ts';
import type { Database } from '../sqlite-compat.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import {
  type NeoAskInputClaim,
  neoAskInputReads,
  neoAskInputWrites,
} from './neo-ask-input-worker.ts';
import { NeoPublicationRepository } from './neo-publication-repository.ts';
import { NeoQuestionAnswerRepository } from './neo-question-answer-repository.ts';
import { applyNeoRuleAnswer } from './neo-rule-answer.ts';
import type { neoTodoAddWrites } from './neo-todo-add-write.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';
import { applyPackPreferenceAnswer } from './pack-preference-answer.ts';

export type NeoTodoDraft = Pick<NeoTodo, 'title' | 'doneWhen' | 'check' | 'instruction' | 'named'> &
  Partial<Pick<NeoTodo, 'priority' | 'dependsOn' | 'approvedAt'>> & { producesFollowUp?: boolean };

export type NeoTodoInsert = (
  id: string,
  askId: string,
  draft: NeoTodoDraft,
  now: number,
  repo?: string | null
) => NeoTodo;

export type NeoTodoCommit = (
  id: string,
  askId: string,
  draft: NeoTodoDraft,
  now: number
) => NeoTodo;

export interface NeoTodoStorageBoundary {
  insert(commit: NeoTodoCommit, args: Parameters<NeoTodoInsert>): NeoTodo;
}

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
    | 'priority'
    | 'dependsOn'
    | 'instruction'
    | 'named'
    | 'approvedAt'
    | 'approvalQuestionId'
  >
>;

const TODO_COLUMNS: Record<keyof NeoTodoPatch, string> = {
  approvedAt: 'approved_at',
  approvalQuestionId: 'approval_question_id',
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
  priority: 'priority',
  dependsOn: 'depends_on',
  instruction: 'instruction',
  named: 'named',
};

const ASK_SELECT = `SELECT id, goal_id AS goalId, project_id AS projectId, parent_id AS parentId, session_id AS sessionId,
  origin_message_id AS originMessageId, title, topic, request, status, outcome, focused_session_json AS focusedSessionJson,
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
  check_json AS checkJson, instruction, named, state, reason, blocked_reason AS blockedReason,
  next_action AS nextAction, blocked_by AS blockedBy, replaced_by AS replacedBy,
  added_after_start AS addedAfterStart, report, evidence, artifacts_json AS artifactsJson, priority, depends_on AS dependsOnJson, created_at AS createdAt,
  updated_at AS updatedAt, started_at AS startedAt, finished_at AS finishedAt,
  approved_at AS approvedAt, approval_question_id AS approvalQuestionId,
  produces_follow_up AS producesFollowUp FROM neo_todos`;

export type NeoQuestionDraft = Pick<
  NeoQuestion,
  | 'text'
  | 'retireWhen'
  | 'kind'
  | 'options'
  | 'labels'
  | 'multiple'
  | 'noLabel'
  | 'yesLabel'
  | 'confirm'
  | 'document'
  | 'replyTo'
  | 'todoId'
  | 'artifacts'
  | 'sourceSession'
> &
  Pick<NeoQuestion, 'cause'> & { todos?: readonly string[] };

export const NEO_ADVISORY_QUESTION = (question: string) =>
  `EXISTS (SELECT 1 FROM neo_pack_preference_proposals p WHERE p.question_id = ${question}.id
    AND json_extract(p.values_json, '$.hold') = 0)`;

const QUESTION_SELECT = `SELECT id, ask_id AS askId, todo_id AS todoId, text, kind, options, labels, multiple, no_label AS noLabel,
  yes_label AS yesLabel, todos, state, answer, answered_by AS answeredBy,
  answer_provenance_json AS answerProvenanceJson, answered_at AS answeredAt, retired_reason AS retiredReason, replaced_by AS replacedBy,
  retire_when_json AS retireWhenJson, confirm_json AS confirmJson, reply_to_json AS replyToJson, artifacts_json AS artifactsJson, source_session_json AS sourceSessionJson, document, cause, actions_applied_at AS actionsAppliedAt, held_at AS heldAt, hold_requests AS holdRequests, created_at AS createdAt FROM neo_questions`;

type QuestionRow = Omit<
  NeoQuestion,
  | 'kind'
  | 'options'
  | 'multiple'
  | 'todos'
  | 'answer'
  | 'confirm'
  | 'replyTo'
  | 'artifacts'
  | 'sourceSession'
  | 'retireWhen'
> & {
  kind: NeoQuestion['kind'] | 'start';
  holdRequests: string | null;
  answerProvenanceJson: string | null;
  retireWhenJson: string | null;
  artifactsJson: string | null;
  sourceSessionJson: string | null;
  confirmJson: string | null;
  replyToJson: string | null;
  options: string | null;
  labels: string | null;
  multiple: number;
  todos: string;
  answer: string | null;
};

const parsed = <T>(json: string | null): T | null => (json ? (JSON.parse(json) as T) : null);

const toQuestion = ({
  answerProvenanceJson,
  retireWhenJson,
  confirmJson,
  replyToJson,
  artifactsJson,
  sourceSessionJson,
  todoId,
  cause,
  actionsAppliedAt,
  heldAt,
  holdRequests: _holdRequests,
  ...row
}: QuestionRow): NeoQuestion => ({
  ...(cause ? { cause } : {}),
  ...(actionsAppliedAt ? { actionsAppliedAt } : {}),
  ...(heldAt && row.state === 'open' ? { heldAt } : {}),
  ...(answerProvenanceJson
    ? { answerProvenance: JSON.parse(answerProvenanceJson) as NeoAnswerProvenance }
    : {}),
  ...(retireWhenJson ? { retireWhen: JSON.parse(retireWhenJson) as NeoTodoCheck } : {}),
  ...row,
  ...(sourceSessionJson
    ? { sourceSession: JSON.parse(sourceSessionJson) as NeoQuestion['sourceSession'] }
    : {}),
  ...(artifactsJson ? { artifacts: JSON.parse(artifactsJson) as NeoQuestion['artifacts'] } : {}),
  ...(todoId ? { todoId } : {}),
  ...(replyToJson ? { replyTo: JSON.parse(replyToJson) as string[] } : {}),
  confirm: parsed<NonNullable<NeoQuestion['confirm']>>(confirmJson),
  ...(row.kind === 'start'
    ? { kind: 'choice' as const, options: JSON.parse(row.todos) as string[], multiple: true }
    : { kind: row.kind, options: parsed<string[]>(row.options), multiple: row.multiple === 1 }),
  labels: parsed<string[]>(row.labels),
  todos: JSON.parse(row.todos) as string[],
  answer: parsed<NeoQuestionAnswer>(row.answer),
});

type TodoRow = Omit<
  NeoTodo,
  'check' | 'named' | 'addedAfterStart' | 'artifacts' | 'dependsOn' | 'producesFollowUp'
> & {
  checkJson: string | null;
  producesFollowUp: number;
  dependsOnJson: string | null;
  artifactsJson: string | null;
  named: string | null;
  addedAfterStart: number;
};

const toTodo = ({
  checkJson,
  artifactsJson,
  dependsOnJson,
  named,
  addedAfterStart,
  producesFollowUp,
  ...row
}: TodoRow): NeoTodo => ({
  ...row,
  ...(producesFollowUp === 1 ? { producesFollowUp: true as const } : {}),
  dependsOn: parsed<string[]>(dependsOnJson),
  ...(artifactsJson ? { artifacts: JSON.parse(artifactsJson) as NeoTodo['artifacts'] } : {}),
  check: parsed<NeoTodoCheck>(checkJson),
  named: parsed<Record<string, unknown>>(named),
  addedAfterStart: addedAfterStart === 1,
});

export interface NeoCardReplyContext {
  conversationId: string;
  sourceMessageIds: readonly string[];
  language?: LanguageSetting;
}

const ASK_ALL_DONE = `(EXISTS (SELECT 1 FROM neo_todos WHERE ask_id = neo_asks.id AND state = 'done')
  AND NOT EXISTS (SELECT 1 FROM neo_todos WHERE ask_id = neo_asks.id AND state NOT IN ('done', 'removed'))
  AND NOT EXISTS (SELECT 1 FROM neo_asks child WHERE child.parent_id = neo_asks.id AND child.status = 'open'))`;

export const NEO_ANSWER_NOTE = { button: 'neo-question:', relay: 'neo-relay-answer:' } as const;

export class NeoAskTodoRepository {
  async commitAdd(input: Parameters<typeof neoTodoAddWrites.run>[1]) {
    const gateway = gatewayFor(this.db);
    const write = gateway.run.bind(gateway);
    const { neoTodoAddWrites: op } = await import('./neo-todo-add-write.ts');
    const receipt = await write(op, input);
    return receipt;
  }

  async writerAddPacks(): Promise<readonly string[]> {
    const { neoTodoPolicies } = await import('../../lib/neo/packs/todo-policies.ts');
    return neoTodoPolicies(this.db).map((policy) => policy.id);
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
      openWork: this.openWorkFacts(),
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

  planContext(withUnanswered = false) {
    const asks = this.listOpenAsks();
    const families = [...new Set(asks.map((ask) => ask.parentId ?? ask.id))];
    const todos = families.flatMap((id) => this.listFamilyTodos(id));
    return {
      asks,
      todos: [...new Map(todos.map((todo) => [todo.id, todo])).values()],
      questions: this.listQuestionsForAsks(asks.map((ask) => ask.id)),
      ...(withUnanswered ? { unanswered: this.listUnansweredInputs() } : {}),
    };
  }

  listUnansweredInputs(): NeoUnansweredInput[] {
    const rows = this.db
      .prepare(`WITH answered(id) AS (
          SELECT value FROM neo_publications p, json_each(p.payload_json, '$.replyTo')
            WHERE json_extract(p.payload_json, '$.publishedBy') IS NOT 'front'
          UNION SELECT value FROM neo_publications p,
            json_each(p.payload_json, '$.cardReply.sourceMessageIds')
            WHERE json_extract(p.payload_json, '$.publishedBy') IS NOT 'front')
        SELECT a.request_id AS id, a.payload_json AS payload
        FROM neo_front_inputs f
        JOIN neo_conversation_asks a ON a.conversation_id = f.conversation_id
          AND a.request_id = f.message_id
        WHERE (f.owner = 'neo' OR (f.eligible = 0 AND f.owner IS NULL))
          AND NOT EXISTS (SELECT 1 FROM answered WHERE answered.id = f.message_id)
        ORDER BY a.sequence DESC`)
      .all() as { id: string; payload: string }[];
    return rows.map((row) => ({
      id: row.id,
      text: neoInputText(JSON.parse(row.payload) as { content?: unknown }) || '(non-text message)',
    }));
  }

  openWorkFacts() {
    const todos = this.db
      .prepare(
        `SELECT t.id, t.ask_id AS askId, t.state, t.blocked_by AS blockedBy, t.started_at AS startedAt
         FROM neo_todos t JOIN neo_asks a ON a.id = t.ask_id
         WHERE t.state IN ('todo', 'doing', 'blocked', 'failed') AND a.status = 'open'`
      )
      .all() as Pick<NeoTodo, 'id' | 'askId' | 'state' | 'blockedBy' | 'startedAt'>[];
    const questions = (
      this.db
        .prepare(
          `SELECT q.ask_id AS askId, q.state, q.todos, q.held_at AS heldAt
           FROM neo_questions q JOIN neo_asks a ON a.id = q.ask_id
           WHERE q.state = 'open' AND a.status = 'open'`
        )
        .all() as (Pick<NeoQuestion, 'askId' | 'state' | 'heldAt'> & { todos: string })[]
    ).map((row) => ({ ...row, todos: JSON.parse(row.todos) as string[] }));
    return { todos, questions, awaitingNeo: this.listAwaitingNeoDecision() };
  }

  askFacts(input: { askId?: string; todoId?: string; questionId?: string }) {
    const askId =
      input.askId ??
      (input.todoId ? this.getTodo(input.todoId)?.askId : undefined) ??
      (input.questionId ? this.getQuestion(input.questionId)?.askId : undefined) ??
      '';
    const facts = this.doneTodoFacts(askId);
    return { ...facts, questions: facts.ask ? this.gateQuestions(facts.ask) : [] };
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
    private readonly settingsChanged: (setting: 'rules' | 'preferences') => void = () => {},
    private readonly questionsPruned?: () => void,
    private readonly changes?: Pick<ReactiveDatabase, 'notifyChange'>,
    private readonly storage: NeoTodoStorageBoundary = neoTodoStorage(db, changes)
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

  inTransaction<T>(work: () => T): T {
    return this.db.transaction(work, 'immediate')();
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
    }, 'immediate')();
  }

  openAsk(
    ask: Omit<NeoAsk, 'parentId' | 'topic' | 'status' | 'outcome' | 'updatedAt' | 'settledAt'> &
      Partial<Pick<NeoAsk, 'parentId' | 'topic'>>
  ): NeoAsk {
    this.db
      .prepare(
        `INSERT INTO neo_asks (id, goal_id, project_id, parent_id, session_id, origin_message_id, title, topic, request, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ask.id,
        ask.goalId ?? null,
        ask.projectId,
        ask.parentId ?? null,
        ask.sessionId,
        ask.originMessageId,
        ask.title,
        ask.topic ?? null,
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
    title: string | null,
    goalId: string | null = null
  ): NeoAsk | null {
    return foundAsk(
      (this.db
        .prepare(
          `${ASK_SELECT} WHERE session_id = ?1 AND origin_message_id IS ?2 AND (?3 IS NULL OR title = ?3) AND (?3 IS NOT NULL OR parent_id IS NULL) AND goal_id IS ?4
           AND (status = 'open' OR (status = 'done'
             AND EXISTS (SELECT 1 FROM neo_asks c WHERE c.parent_id = neo_asks.id)))`
        )
        .get(sessionId, originMessageId, title, goalId) as AskRow | null) ?? null
    );
  }

  findAskInput(sessionId: string, messageId: string): Promise<string | null> {
    return gatewayFor(this.db).call(neoAskInputReads, 'owner', sessionId, messageId);
  }

  async claimNeoInputAsk(input: NeoAskInputClaim): Promise<string | { reason: string }> {
    const owner = await gatewayFor(this.db).call(neoAskInputWrites, 'claimNeoInputAsk', input);
    if (typeof owner === 'string') this.changed();
    return owner;
  }

  listChildAsks(parentId: string): NeoAsk[] {
    return this.listChildAsksOf([parentId]);
  }

  listChildAsksOf(parentIds: readonly string[]): NeoAsk[] {
    return (
      this.db
        .prepare(
          `${ASK_SELECT} WHERE parent_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`
        )
        .all(JSON.stringify(parentIds)) as AskRow[]
    ).map(toAsk);
  }

  listGoalAsks(goalId: string): NeoAsk[] {
    return (
      this.db
        .prepare(`${ASK_SELECT} WHERE goal_id = ? ORDER BY created_at, id`)
        .all(goalId) as AskRow[]
    ).map(toAsk);
  }

  setAskTopic(id: string, topic: string, now: number): NeoAsk {
    this.db
      .prepare("UPDATE neo_asks SET topic = ?, updated_at = ? WHERE id = ? AND status = 'open'")
      .run(topic, now, id);
    this.changed();
    return this.getAsk(id)!;
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
        queueNeoRequestReply(
          this.db,
          todo,
          this.updateTodo(
            todo,
            { state: 'removed', reason: `The ask was settled ${status}.`, finishedAt: now },
            now
          ),
          outcome,
          ask.sessionId
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
    includeBlocked = true,
    wakeFinishedNow = false
  ): {
    id: string;
    sessionId: string;
    title: string;
    since: number;
    updatedAt: number;
    finished: number;
  }[] {
    return this.db
      .prepare(`SELECT id, session_id AS sessionId, title, ${ASK_ALL_DONE} AS finished, updated_at AS updatedAt,
      COALESCE((SELECT MAX(updated_at) FROM neo_todos WHERE ask_id = neo_asks.id), updated_at) AS since
      FROM neo_asks WHERE status = 'open'
      AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = neo_asks.session_id AND sessions.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM neo_todos WHERE ask_id = neo_asks.id AND state IN ('todo', 'doing'))
      AND NOT EXISTS (SELECT 1 FROM neo_questions WHERE ask_id = neo_asks.id AND state = 'open'
        AND NOT ${NEO_ADVISORY_QUESTION('neo_questions')})
      AND (?2 OR NOT EXISTS (SELECT 1 FROM neo_todos WHERE ask_id = neo_asks.id AND state IN ('blocked', 'failed')))
      AND (updated_at <= ?1 OR (?3 AND ${ASK_ALL_DONE}))`)
      .all(before, includeBlocked ? 1 : 0, wakeFinishedNow ? 1 : 0) as ReturnType<
      NeoAskTodoRepository['listStalledAsks']
    >;
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
    ).map((row) => toTodo(row));
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
    ).map((row) => toTodo(row));
  }

  listFamilyTodos(askId: string): NeoTodo[] {
    const root = this.getAsk(askId)?.parentId ?? askId;
    return this.listTodosForAsks([root, ...this.listChildAsks(root).map((ask) => ask.id)]);
  }

  listTodosForAsks(askIds: readonly string[]): NeoTodo[] {
    return (
      this.db
        .prepare(`${TODO_SELECT} WHERE ask_id IN (SELECT value FROM json_each(?))
          ORDER BY ask_id, position, created_at`)
        .all(JSON.stringify(askIds)) as TodoRow[]
    ).map((row) => toTodo(row));
  }

  addTodo(...args: Parameters<NeoTodoInsert>): NeoTodo {
    const storage = this.storage;
    const todo = this.inTransaction(() =>
      storage.insert((id, askId, draft, now) => this.insertTodo(id, askId, draft, now, false), args)
    );
    this.changed();
    return todo;
  }

  private insertTodo(
    id: string,
    askId: string,
    draft: NeoTodoDraft,
    now: number,
    notify = true
  ): NeoTodo {
    this.db
      .prepare(
        `INSERT INTO neo_todos (id, ask_id, position, title, done_when, check_json, instruction, named,
           added_after_start, priority, depends_on, approved_at, produces_follow_up, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM neo_todos WHERE ask_id = ?), ?, ?, ?, ?, ?,
           EXISTS (SELECT 1 FROM neo_todos WHERE ask_id = ? AND started_at IS NOT NULL), ?,
           ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        askId,
        askId,
        draft.title,
        draft.doneWhen,
        draft.check ? JSON.stringify(draft.check) : null,
        draft.instruction,
        draft.named ? JSON.stringify({ ...draft.named, desktopControl: undefined }) : null,
        askId,
        draft.priority ?? 'normal',
        JSON.stringify(draft.dependsOn ?? []),
        draft.approvedAt ?? null,
        draft.producesFollowUp ? 1 : 0,
        now,
        now
      );
    this.touchAsk(askId, now, notify);
    return this.getTodo(id)!;
  }

  private stateFacts(
    todo: NeoTodo,
    change: NeoTodoPatch,
    judgement: NeoTodoJudgement,
    markedDone = false
  ): TodoStateFacts {
    const live = this.db
      .prepare('SELECT ref, live_status AS status FROM neo_todo_sessions WHERE todo_id = ?')
      .get(todo.id) as { ref: string | null; status: string | null } | null;
    const triagedAt =
      todo.blockedBy === 'needs-human'
        ? new NeoTodoSessionRepository(this.db).readNudge(todo.id)?.blockerReport?.triagedAt
        : undefined;
    const cards = this.todoCards(todo);
    return {
      todo,
      change,
      judgement,
      markedDone,
      triagePending:
        triagedAt !== undefined &&
        !this.listQuestions(todo.askId).some(
          (q) => q.todoId === todo.id && q.state === 'answered' && (q.answeredAt ?? 0) >= triagedAt
        ),
      answerPending:
        todo.blockedBy === 'needs-human' &&
        this.questionAnswers.pending().some((route) => route.todoId === todo.id),
      askOpen: this.getAsk(todo.askId)?.status === 'open',
      order: (
        this.db
          .prepare(
            `SELECT id, state, started_at AS startedAt FROM neo_todos
             WHERE ask_id = ? ORDER BY position, created_at`
          )
          .all(todo.askId) as Pick<NeoTodo, 'id' | 'state' | 'startedAt'>[]
      ).map((row) => ({
        ...row,
        questionOpen: Number(cards.some((card) => neoQuestionCoversTodo(card, row))),
      })),
      questionOpen: neoTodoAwaitsHuman(todo, cards),
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
    judgement: NeoTodoJudgement,
    markedDone = false
  ): { todo: NeoTodo | null; startNext: string | null } {
    const current = this.getTodo(todoId);
    if (!current) return { todo: null, startNext: null };
    this.pruneQuestions(current.askId, now);
    if (current.state === 'removed') return { todo: current, startNext: null };
    return recomputeTodoState(
      () => this.stateFacts(current, change, judgement, markedDone),
      (plan) => ({ todo: this.writeTodo(current, plan.patch, now)!, startNext: plan.startNext }),
      now
    );
  }

  private writeTodo(
    todo: NeoTodo,
    change: NeoTodoPatch,
    now: number,
    claim = false,
    prune = true
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
            key === 'check' || key === 'artifacts' || key === 'dependsOn' || key === 'named'
              ? JSON.stringify(patch[key] ?? null)
              : (patch[key] ?? null)
          ),
          now,
          todo.id
        );
      if (
        result.changes &&
        prune &&
        (patch.state || 'instruction' in patch || 'dependsOn' in patch)
      )
        this.pruneQuestions(todo.askId, now);
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

  listCheckable(stalledBefore?: number, queuedBefore?: number): NeoTodo[] {
    return (
      this.db
        .prepare(
          `${TODO_SELECT} WHERE state IN ('todo', 'doing', 'blocked', 'failed')
             AND ask_id IN (SELECT id FROM neo_asks WHERE status = 'open')
             AND (?1 IS NULL OR (((state = 'blocked' AND blocked_by IN ('stalled', 'environment') AND updated_at <= ?1)
               OR (state = 'todo' AND created_at <= ?2 AND check_json IS NOT NULL AND COALESCE(TRIM(instruction), '') = ''))
               AND ask_id IN (SELECT a.id FROM neo_asks a JOIN sessions s ON s.id = a.session_id WHERE s.status = 'active')))`
        )
        .all(stalledBefore ?? null, queuedBefore ?? null) as TodoRow[]
    ).map((row) => toTodo(row));
  }

  getCheckable(id: string): NeoTodo | null {
    const row = this.db
      .prepare(
        `${TODO_SELECT} WHERE id = ? AND state IN ('todo', 'doing', 'blocked', 'failed')
           AND ask_id IN (SELECT id FROM neo_asks WHERE status = 'open')`
      )
      .get(id) as TodoRow | null;
    return row ? toTodo(row) : null;
  }

  openQuestionChecks() {
    return this.listQuestionsForAsks(this.listOpenAsks().map((ask) => ask.id))
      .filter((question) => question.state === 'open')
      .map((question) => ({
        question,
        todo: question.todoId ? this.getTodo(question.todoId) : null,
      }));
  }

  retireCheckedQuestion(
    question: NeoQuestion,
    check: NeoTodoCheck | null,
    evidence: string,
    now: number
  ): NeoQuestion | null {
    const current = this.getQuestion(question.id);
    const ask = current ? this.getAsk(current.askId) : null;
    if (
      current?.state !== 'open' ||
      ask?.status !== 'open' ||
      JSON.stringify(
        current.retireWhen ?? (current.todoId ? this.getTodo(current.todoId)?.check : null)
      ) !== JSON.stringify(check)
    )
      return null;
    const retired = this.retireQuestion(current, evidence, null, now);
    if (!retired) return null;
    for (const todo of this.listTodos(current.askId))
      if (todo.state === 'blocked' && ['question', 'needs-human'].includes(todo.blockedBy ?? ''))
        this.commitState(todo.id, {}, now, { state: 'no_opinion' });
    const to = { kind: 'session' as const, sessionId: ask.sessionId };
    const queued = enqueueMailboxEntry(
      new JobQueueRepository(this.db),
      createMailboxEntry({
        to,
        origin: renderAddress(to),
        messageUuid: `neo-question-retired:${current.id}`,
        message: {
          type: 'user',
          parent_tool_use_id: null,
          inputKind: 'system',
          neoWakeEvent: true,
          message: {
            role: 'user',
            content: `Retired question ${current.id}: ${evidence}`.replace(/\s+/g, ' '),
          },
        },
      })
    );
    if (queued.kind === 'rejected') throw new Error(queued.reason);
    return retired;
  }

  getQuestion(id: string): NeoQuestion | null {
    const row = this.questionRow(id);
    return row ? toQuestion(row) : null;
  }

  private questionRow(id: string): QuestionRow | null {
    return this.db.prepare(`${QUESTION_SELECT} WHERE id = ?`).get(id) as QuestionRow | null;
  }

  holdQuestion(id: string, held: boolean, requestId: string, now: number): NeoQuestion | null {
    const changed = this.db.transaction(() => {
      const row = this.questionRow(id);
      if (row?.state !== 'open') return null;
      const requests = JSON.parse(row.holdRequests ?? '[]') as string[];
      if (requests.includes(requestId)) return false;
      const heldAt = held ? (row.heldAt ?? now) : null;
      this.changeQuestion(id, {
        held_at: heldAt,
        hold_requests: JSON.stringify([...requests, requestId]),
      });
      return heldAt !== row.heldAt;
    })();
    if (changed === null) return null;
    const question = this.getQuestion(id);
    if (changed && question) this.touchAsk(question.askId, now);
    return question;
  }

  markCardActionsApplied(id: string, now: number): void {
    this.changeQuestion(id, { actions_applied_at: now }, 'answered');
  }

  listBlockingQuestions(askId: string): NeoQuestion[] {
    return (
      this.db
        .prepare(
          `${QUESTION_SELECT} WHERE ask_id = ? AND NOT ${NEO_ADVISORY_QUESTION('neo_questions')} ORDER BY created_at, rowid`
        )
        .all(askId) as QuestionRow[]
    ).map(toQuestion);
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
        `INSERT INTO neo_questions (id, ask_id, text, kind, options, labels, multiple, no_label, yes_label,
           todos, confirm_json, document, reply_to_json, todo_id, artifacts_json, source_session_json, retire_when_json, cause, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        askId,
        draft.text,
        draft.kind,
        draft.options ? JSON.stringify(draft.options) : null,
        draft.labels ? JSON.stringify(draft.labels) : null,
        draft.multiple ? 1 : 0,
        draft.noLabel,
        draft.yesLabel,
        JSON.stringify(
          draft.todos
            ? draft.todos
            : draft.todoId
              ? [draft.todoId]
              : neoAskQuestionHolds(
                  [askId, ...this.listChildAsks(askId).map((ask) => ask.id)].flatMap((id) =>
                    this.listTodos(id)
                  )
                )
        ),
        draft.confirm ? JSON.stringify(draft.confirm) : null,
        draft.document ?? null,
        draft.replyTo ? JSON.stringify(draft.replyTo) : null,
        draft.todoId ?? null,
        draft.artifacts ? JSON.stringify(draft.artifacts) : null,
        draft.sourceSession ? JSON.stringify(draft.sourceSession) : null,
        draft.retireWhen ? JSON.stringify(draft.retireWhen) : null,
        draft.cause ?? null,
        now
      );
    this.touchAsk(askId, now);
    return this.getQuestion(id)!;
  }

  answerQuestion(
    question: NeoQuestion,
    answer: NeoQuestionAnswer,
    by: 'button' | 'chat',
    now: number,
    approval?: { sessionId: string; messageId: string },
    provenance?: NeoAnswerProvenance,
    effects: readonly { todo: NeoTodo; patch: NeoTodoPatch }[] = []
  ): NeoQuestion | null {
    let settingsChanged: 'rules' | 'preferences' | undefined;
    const changed = this.db.transaction(() => {
      const answered = this.changeQuestion(
        question.id,
        {
          state: 'answered',
          answer: JSON.stringify(answer),
          answered_by: by,
          answered_at: now,
          answer_provenance_json: provenance ? JSON.stringify(provenance) : null,
        },
        'open'
      );
      if (answered) {
        this.pruneQuestions(question.askId, now);
        for (const { todo, patch } of effects) this.writeTodo(todo, patch, now, false, false);
        const preferences = applyPackPreferenceAnswer(this.db, question.id);
        if (preferences.ok && preferences.applied) settingsChanged = 'preferences';
        const rules = applyNeoRuleAnswer(this.db, question.id, approval);
        if (rules.ok && rules.changed) settingsChanged = 'rules';
      }
      return answered;
    })();
    if (!changed) return null;
    this.touchAsk(question.askId, now);
    if (settingsChanged) this.settingsChanged(settingsChanged);
    return this.getQuestion(question.id);
  }

  retireQuestion(
    question: NeoQuestion,
    reason: string,
    replacedBy: string | null,
    now: number,
    unheld = false
  ): NeoQuestion | null {
    const changed = this.db.transaction(() => {
      const retired = this.changeQuestion(
        question.id,
        { state: 'retired', retired_reason: reason, replaced_by: replacedBy },
        'open',
        unheld
      );
      if (retired) this.pruneQuestions(question.askId, now);
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

  gateQuestions(ask: NeoAsk): NeoQuestion[] {
    return this.listQuestionsForAsks(ask.parentId ? [ask.parentId, ask.id] : [ask.id]);
  }

  familyQuestions(askId: string): NeoQuestion[] {
    const root = this.getAsk(askId)?.parentId ?? askId;
    return this.listQuestionsForAsks([root, ...this.listChildAsks(root).map((ask) => ask.id)]);
  }

  todoCards(todo: Pick<NeoTodo, 'askId'>): NeoQuestion[] {
    const ask = this.getAsk(todo.askId);
    return ask ? this.gateQuestions(ask) : [];
  }

  private pruneQuestions(askId: string, now: number): void {
    const root = this.getAsk(askId)?.parentId ?? askId;
    for (const id of [root, ...this.listChildAsks(root).map((ask) => ask.id)])
      NeoAskTodoRepository.pruneAskQuestions(this, id, now);
  }

  private static readonly pruneOpenQuestion = (
    superpipe({})('neo.question.prune-open') as PipelineAPI
  )
    .input(['store', 'question', 'now'])
    .pipe(
      (store: NeoAskTodoRepository, question: NeoQuestion) => store.listFamilyTodos(question.askId),
      ['store', 'question'],
      'family'
    )
    .pipe(planNeoQuestionPrune, ['question', 'family'], 'result:plan')
    .pipe(
      (store: NeoAskTodoRepository, question: NeoQuestion, plan: NeoQuestionPrune, now: number) => {
        const changed =
          plan.retire !== undefined
            ? store.retireQuestion(question, plan.retire, null, now)
            : store.rewriteCard(question, plan, now);
        if (changed) store.questionsPruned?.();
      },
      ['store', 'question', 'plan', 'now'],
      'pruned'
    )
    .end('pruned') as (store: NeoAskTodoRepository, question: NeoQuestion, now: number) => void;

  private static readonly pruneAskQuestions = (
    superpipe({})('neo.question.prune-ask') as PipelineAPI
  )
    .input(['store', 'askId', 'now'])
    .pipe(
      (store: NeoAskTodoRepository, askId: string, now: number) => {
        for (const question of store.listQuestions(askId))
          if (question.state === 'open')
            NeoAskTodoRepository.pruneOpenQuestion(store, question, now);
      },
      ['store', 'askId', 'now'],
      'pruned'
    )
    .end('pruned') as (store: NeoAskTodoRepository, askId: string, now: number) => void;

  private rewriteCard(
    question: NeoQuestion,
    plan: Exclude<NeoQuestionPrune, { retire: string }>,
    now: number
  ): boolean {
    this.db
      .prepare(
        'UPDATE neo_questions SET todos = ?, text = ?, state = ?, retired_reason = ? WHERE id = ?'
      )
      .run(JSON.stringify(plan.kept), plan.text, plan.state, plan.retiredReason, question.id);
    for (const todo of plan.released) this.writeTodo(todo, { state: 'todo' }, now);
    return true;
  }

  listAwaitingNeoDecision(): NeoTodo[] {
    const candidates = this.db
      .prepare(`SELECT a.id FROM neo_asks a WHERE a.status = 'open'
        AND EXISTS (SELECT 1 FROM neo_todos waiting WHERE waiting.ask_id = a.id
          AND waiting.started_at IS NULL AND waiting.state IN ('todo', 'blocked'))
        AND EXISTS (SELECT 1 FROM neo_todos gone JOIN neo_asks home ON home.id = gone.ask_id
          WHERE COALESCE(home.parent_id, home.id) = COALESCE(a.parent_id, a.id)
          AND gone.state = 'removed')`)
      .all() as { id: string }[];
    return candidates.flatMap(({ id }) =>
      neoTodosAwaitingNeoDecision(
        this.listFamilyTodos(id),
        this.getAsk(id),
        this.familyQuestions(id)
      )
    );
  }

  private changeQuestion(
    id: string,
    patch: Record<string, string | number | null>,
    state?: NeoQuestion['state'],
    unheld = false
  ): number {
    return this.db
      .prepare(`UPDATE neo_questions SET ${Object.keys(patch)
        .map((key) => `${key} = ?`)
        .join(', ')}
      WHERE id = ?${state ? ' AND state = ?' : ''}${unheld ? ' AND held_at IS NULL' : ''}`)
      .run(...Object.values(patch), id, ...(state ? [state] : [])).changes;
  }

  private touchAsk(askId: string, now: number, notify = true): void {
    this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(now, askId);
    if (notify) this.changed();
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
    'getQuestion',
    'getTodo',
    'getAsk',
    'openQuestionChecks',
    'snapshot',
    'planContext',
    'doneTodoFacts',
    'askFacts',
    'listCheckable',
    'listAwaitingNeoDecision',
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
    constructor(db: Database, changes?: ReactiveDatabase) {
      super(db, undefined, undefined, undefined, changes);
    }
  },
  ['commitState', 'retireCheckedQuestion']
);
