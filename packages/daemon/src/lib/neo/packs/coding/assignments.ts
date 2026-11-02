import { codingStageTargetReads } from './stage-target-db.ts';
import { planCodingStageTarget } from './stage-preferences.ts';
import { CodingPrLedgerRepository } from './pr-ledger.ts';
import { codingSmokeReads } from './smoke-admission-db.ts';
import type { CodingSmokeRequest } from './smoke-operation.ts';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { ReactiveDatabase } from '../../../../storage/reactive-database.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import { WorkRefSchema } from '../../../drivers/types.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import { CodingActor, CodingStageFact } from './stage-facts.ts';
import { NeoAskTodoRepository } from '../../../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../storage/repositories/neo-todo-session-repository.ts';
import { messageOpening, type NeoDriverTarget, type readDriverOutcome } from '../../driver-work.ts';
import { recordWorkDeliveryOutcome } from '../../../../storage/repositories/work-delivery-input-repository.ts';
import { ChangeRecorder } from '../../../../storage/db-gateway/db-op.ts';

export const CodingAssignment = z
  .object({
    url: z.string().refine((url) => !!parsePrUrl(url)),
    head: z.string().min(1),
    acceptanceContract: z.string().trim().min(1),
    newDispatch: z.literal(true),
    write: WorkRefSchema,
    actor: CodingActor.optional(),
    ref: WorkRefSchema.optional(),
    stageTodoId: z.string().optional(),
    bot: z.string().optional(),
    effort: z.string().optional(),
    fallback: z.array(z.string()).optional(),
  })
  .refine((value) =>
    value.bot
      ? !value.actor && !value.ref
      : value.actor &&
        value.ref &&
        value.actor.id === value.ref.id &&
        (value.actor.kind === 'human'
          ? value.ref.adapter === 'human'
          : value.actor.harness === value.ref.adapter) &&
        !isDeepStrictEqual(value.write, value.ref)
  );
export type CodingAssignment = z.infer<typeof CodingAssignment>;
type Stage = 'review' | 'qa';
const key = (url: string, head: string, stage: Stage) =>
  `assignment:${githubUrlKey(url)}:${head}:${stage}`;

export class CodingAssignmentsRepository {
  private readonly todos: NeoAskTodoRepository;
  constructor(
    private readonly db: Database,
    changes?: Pick<ReactiveDatabase, 'notifyChange'>
  ) {
    this.todos = new NeoAskTodoRepository(db, () => {
      changes?.notifyChange('neo_todos');
      changes?.notifyChange('neo_asks');
    });
  }

  planTarget(input: Parameters<typeof planCodingStageTarget>[1]) {
    return planCodingStageTarget(
      this.db,
      input,
      input.stage === 'review'
        ? new CodingPrLedgerRepository(this.db).policy(input.repo).provenance !== false
        : false
    );
  }

  planTargetCurrent(input: Parameters<typeof planCodingStageTarget>[1]) {
    return gatewayFor(this.db).call(codingStageTargetReads, 'planTarget', input);
  }

  smokeAssignmentCurrent(input: CodingSmokeRequest) {
    return gatewayFor(this.db).call(codingSmokeReads, 'check', input);
  }

  read(todoId: string, url: string, head: string): Partial<Record<Stage, CodingAssignment>> {
    const todo = this.todos.getTodo(todoId);
    if (todo?.check?.kind === 'stage_result') todoId = String(todo.check.params.todoId);
    const rows = this.db
      .prepare(`SELECT key, value_json FROM pack_facts
      WHERE todo_id = ? AND pack = 'coding' AND key IN (?, ?)`)
      .all(todoId, key(url, head, 'review'), key(url, head, 'qa')) as {
      key: string;
      value_json: string;
    }[];
    return Object.fromEntries(
      rows.map((row) => [
        row.key.endsWith(':review') ? 'review' : 'qa',
        this.hydrate(JSON.parse(row.value_json)),
      ])
    );
  }

  private hydrate(value: CodingAssignment): CodingAssignment {
    if (!value.stageTodoId) return CodingAssignment.parse(value);
    const card = new NeoTodoSessionRepository(this.db).readCard(value.stageTodoId);
    return CodingAssignment.parse({
      ...value,
      ref: card?.ref,
      effort: card?.effort ?? undefined,
      actor: card?.ref && {
        kind: 'agent',
        id: card.ref.id,
        harness: card.ref.adapter,
        model: card.model,
      },
    });
  }

  reserveStage(
    todoId: string,
    stage: Stage,
    assignment: CodingAssignment,
    target: NeoDriverTarget
  ) {
    const todos = this.todos,
      sessions = new NeoTodoSessionRepository(this.db);
    const parent = todos.getTodo(todoId)!;
    const ask = todos.getAsk(parent.askId)!;
    if (ask.status !== 'open' || !['doing', 'blocked'].includes(parent.state))
      throw new Error('The author todo is no longer live.');
    const params = { todoId, url: assignment.url, head: assignment.head, stage };
    const existing = todos
      .listTodos(ask.id)
      .find(
        (todo) =>
          todo.check?.kind === 'stage_result' && isDeepStrictEqual(todo.check.params, params)
      );
    if (existing) return { todo: existing, ask, created: false };
    const now = Date.now(),
      id = crypto.randomUUID();
    todos.addTodo(
      id,
      ask.id,
      {
        title: `${stage === 'review' ? 'Review' : 'Verify'} PR #${parsePrUrl(assignment.url)!.number} at ${assignment.head}`,
        doneWhen: 'The assigned actor has returned a verdict for this exact head.',
        check: { pack: 'coding', kind: 'stage_result', params },
        instruction: null,
        named: null,
      },
      now,
      parent.repo
    );
    sessions.create(id, target);
    return {
      todo: todos.commitState(id, {}, now, {
        state: 'blocked',
        reason: 'Awaiting the assigned actor dispatch receipt.',
      }).todo!,
      ask,
      created: true,
    };
  }

  recordDispatch(id: string, todoId: string, outcome: ReturnType<typeof readDriverOutcome>) {
    const sessions = new NeoTodoSessionRepository(this.db);
    const input = sessions.inputs.list(todoId).find((item) => item.id === id)!;
    const askId = this.todos.getTodo(todoId)!.askId;
    recordWorkDeliveryOutcome.run(this.db, { id, outcome, now: Date.now() }, new ChangeRecorder());
    if ('ref' in outcome) {
      const now = Date.now();
      sessions.recordDispatch({
        todoId,
        askId,
        ref: outcome.ref,
        target: input.target,
        keepIdentity: false,
        startedAt: outcome.startedAt ?? now,
        observed: { model: outcome.model, effort: outcome.effort },
        sent: {
          inputBefore: 0,
          opening: messageOpening(input.message),
          ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
        },
      });
      this.todos.commitState(todoId, { state: 'doing', startedAt: now }, now, {
        state: 'no_opinion',
      });
    }
    return outcome;
  }

  recordResult(todoId: string, fact: CodingStageFact): boolean {
    const assignment = this.read(todoId, fact.url, fact.head)[fact.stage];
    if (
      !assignment ||
      assignment.acceptanceContract !== fact.acceptanceContract ||
      !isDeepStrictEqual(assignment.ref, fact.ref) ||
      !isDeepStrictEqual(assignment.actor, fact.actor)
    )
      return false;
    const ledger = new CodingPrLedgerRepository(this.db);
    const recorded = ledger.recordStage(fact);
    if (
      !recorded &&
      ledger.stageFacts
        .read(fact.url)
        .some((item) => item.head === fact.head && item.verdict === 'fail')
    )
      return false;
    if (assignment.stageTodoId)
      this.todos.commitState(assignment.stageTodoId, {}, Date.now(), {
        state: 'done',
        evidence: fact.evidence.join('\n'),
      });
    return recorded || !!assignment.stageTodoId;
  }

  failStage(todoId: string, reason: string): void {
    this.todos.commitState(todoId, {}, Date.now(), {
      state: 'failed',
      reason,
    });
  }

  write<K extends (typeof codingAssignmentWrites.methods)[number]>(
    method: K,
    ...args: Parameters<CodingAssignmentsRepository[K]>
  ): Promise<ReturnType<CodingAssignmentsRepository[K]>> {
    return gatewayFor(this.db).call(codingAssignmentWrites, method, ...(args as never)) as Promise<
      ReturnType<CodingAssignmentsRepository[K]>
    >;
  }

  record(todoId: string, stage: Stage, input: CodingAssignment): boolean {
    const assignment = CodingAssignment.parse(input);
    assignment.url = githubUrlKey(assignment.url);
    return this.db.transaction(() => {
      const parent = this.todos.getTodo(todoId);
      if (
        assignment.stageTodoId &&
        (!parent ||
          !['doing', 'blocked'].includes(parent.state) ||
          this.todos.getAsk(parent.askId)?.status !== 'open')
      )
        return false;
      if (
        this.db
          .prepare(`SELECT 1 FROM pack_facts WHERE todo_id = ? AND pack = 'coding'
        AND key LIKE 'assignment:%' AND json_extract(value_json, '$.acceptanceContract') <> ? LIMIT 1`)
          .get(todoId, assignment.acceptanceContract)
      )
        return false;
      const previous = this.read(todoId, assignment.url, assignment.head);
      if (
        Object.values(previous).some(
          (item) =>
            item.acceptanceContract !== assignment.acceptanceContract ||
            !isDeepStrictEqual(item.write, assignment.write)
        )
      )
        return false;
      if (
        stage === 'qa' &&
        (assignment.bot ||
          !previous.review ||
          isDeepStrictEqual(previous.review.ref, assignment.ref))
      )
        return false;
      return (
        this.db
          .prepare(`INSERT INTO pack_facts (todo_id, pack, key, value_json)
      SELECT ?, 'coding', ?, ? WHERE EXISTS
        (SELECT 1 FROM pack_coding_stage_heads WHERE url = ? AND head = ?)
      ON CONFLICT(todo_id, pack, key) DO NOTHING`)
          .run(
            todoId,
            key(assignment.url, assignment.head, stage),
            JSON.stringify(
              assignment.stageTodoId
                ? { ...assignment, ref: undefined, actor: undefined, effort: undefined }
                : assignment
            ),
            assignment.url,
            assignment.head
          ).changes === 1
      );
    })();
  }

  recordLater(todoId: string, stage: Stage, assignment: CodingAssignment): Promise<boolean> {
    return gatewayFor(this.db).call(
      codingAssignmentWrites,
      'record',
      todoId,
      stage,
      assignment
    ) as Promise<boolean>;
  }
}

export const codingAssignmentWrites = defineRepositoryOp(
  'coding.assignmentWrites',
  'write',
  CodingAssignmentsRepository,
  ['record', 'reserveStage', 'recordDispatch', 'recordResult', 'failStage']
);
