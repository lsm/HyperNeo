import { NeoAskTodoRepository } from '../../../../storage/repositories/neo-ask-todo-repository.ts';
import { neoRepositoryIdentity } from '../../project-mirror.ts';
import { codingPrKey } from './pr-key.ts';
import { codingTodoRepository, createCodingTodoPolicy } from './todo-prs.ts';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorkRef } from '../../../drivers/types.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import { WorkDeliveryInputRepository } from '../../../../storage/repositories/work-delivery-input-repository.ts';
import { WorkTurnRepository } from '../../../../storage/repositories/work-turn-repository.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import type { NeoWorkPrReader } from './work-prs.ts';
import {
  planCodingTurnOwner,
  type CodingTurnOwner,
  type CodingTurn,
  type CodingTurnBind,
  type CodingTurnMentions,
  codingTurnBoundUnknown,
  codingTurnSessionKey,
  codingTurnTodos,
  planCodingTurnFacts,
  planCodingTurnOwned,
  planCodingTurnUrls,
} from './turn-owner.ts';

type Delivery = ReturnType<WorkDeliveryInputRepository['list']>[number];

const PENDING_RECEIPT = /^desktop-pending:\d+:([a-f0-9]+)$/;

function deliveryKeys({ outcome }: Delivery): string[] {
  const reply = outcome as {
    receipt?: { inputId?: string };
    delivery?: { startedTurnId?: string; steeredIntoTurnId?: string };
  } | null;
  const input = reply?.receipt?.inputId;
  const pending = input && PENDING_RECEIPT.exec(input);
  return [
    ...(pending ? [`desktop-pending:${pending[1]}`] : input ? [input] : []),
    ...(reply?.delivery?.startedTurnId ? [reply.delivery.startedTurnId] : []),
    ...(reply?.delivery?.steeredIntoTurnId ? [reply.delivery.steeredIntoTurnId] : []),
  ];
}

const deliveryRef = ({ outcome }: Delivery) => (outcome as { ref?: WorkRef } | null)?.ref ?? null;

type AttachmentCandidate = {
  id: string;
  ref: WorkRef;
  repo: string | null;
  startedAt: number | null;
};

function planCodingPrAttachment(
  pr: { url: string; createdAt?: number },
  owner: CodingTurnOwner,
  candidates: readonly AttachmentCandidate[],
  named: ReadonlySet<string>
): string | null {
  if (owner.state !== 'placed' || named.has(pr.url)) return null;
  const parsed = parsePrUrl(pr.url)!;
  const repository = neoRepositoryIdentity(`${parsed.host}/${parsed.owner}/${parsed.repo}`);
  const eligible = candidates.filter((candidate) => {
    const repo =
      candidate.repo && /^[^/]+\/[^/]+$/.test(candidate.repo)
        ? `github.com/${candidate.repo}`
        : candidate.repo;
    return (
      codingTurnSessionKey(candidate.ref) === codingTurnSessionKey(owner.session) &&
      neoRepositoryIdentity(repo ?? undefined) === repository
    );
  });
  return eligible.length === 1 &&
    eligible[0].startedAt !== null &&
    eligible[0].startedAt <= (pr.createdAt ?? 0)
    ? eligible[0].id
    : null;
}

export class CodingTurnPrRepository {
  private readonly turns: WorkTurnRepository;
  private readonly deliveries: WorkDeliveryInputRepository;

  constructor(private readonly db: Database) {
    this.turns = new WorkTurnRepository(db);
    this.deliveries = new WorkDeliveryInputRepository(db);
  }

  private todosOf(ref: WorkRef) {
    return Object.fromEntries(
      this.deliveries
        .list(ref)
        .flatMap((row) =>
          row.todoId ? deliveryKeys(row).map((key) => [key, row.todoId as string]) : []
        )
    );
  }

  private bindsOf(ref: WorkRef): CodingTurnBind[] {
    return this.db
      .prepare(`SELECT s.todo_id AS todo, json_extract(s.target, '$.boundAt') AS boundAt,
          t.finished_at AS finishedAt
        FROM neo_todo_sessions s LEFT JOIN neo_todos t ON t.id = s.todo_id
        WHERE json_extract(s.target, '$.verb') = 'adopt'
          AND json_extract(s.target, '$.boundAt') IS NOT NULL
          AND json_extract(s.ref, '$.adapter') = ? AND json_extract(s.ref, '$.id') = ?
          AND json_extract(s.ref, '$.daemon') IS ?`)
      .all(ref.adapter, ref.id, ref.daemon ?? null) as CodingTurnBind[];
  }

  private boundRef(todoId: string): WorkRef | null {
    const row = this.db
      .prepare(`SELECT ref FROM neo_todo_sessions
        WHERE todo_id = ? AND json_extract(target, '$.verb') = 'adopt' AND ref IS NOT NULL`)
      .get(todoId) as { ref: string } | null;
    return row ? (JSON.parse(row.ref) as WorkRef) : null;
  }

  own(todoId: string): CodingTurn[] {
    const bound = this.boundRef(todoId);
    const refs = new Map([
      ...this.deliveries.list(todoId).flatMap((row) => {
        const ref = deliveryRef(row);
        return ref ? [[JSON.stringify(ref), ref] as const] : [];
      }),
      ...(bound ? [[JSON.stringify(bound), bound] as const] : []),
    ]);
    return [...refs.values()].flatMap((ref) => {
      const todos = this.todosOf(ref);
      const binds = this.bindsOf(ref);
      return this.turns
        .list(ref)
        .map(
          (turn, index, all): CodingTurn => ({
            ...turn,
            ref,
            previous: all[index - 1] ?? null,
            bound: binds,
          })
        )
        .filter(
          (turn) =>
            codingTurnTodos(turn, todos).includes(todoId) ||
            (codingTurnBoundUnknown(turn, todos) && binds.some(({ todo }) => todo === todoId))
        );
    });
  }

  mentions(urls: readonly string[]): CodingTurnMentions {
    const found = this.turns.mentioning(urls);
    const refs = new Map(found.map((turn) => [JSON.stringify(turn.ref), turn.ref]));
    const binds = new Map([...refs].map(([key, ref]) => [key, this.bindsOf(ref)]));
    return {
      turns: found.map((turn) => ({ ...turn, bound: binds.get(JSON.stringify(turn.ref)) })),
      todos: Object.fromEntries(
        [...refs.values()].map((ref) => [codingTurnSessionKey(ref), this.todosOf(ref)])
      ),
    };
  }

  attachUnclaimed(
    rows: readonly { repo: string; number: number; createdAt: number | null }[],
    mentions: CodingTurnMentions
  ): void {
    const store = new NeoAskTodoRepository(this.db);
    const active = this.db
      .prepare(`SELECT t.id, s.ref FROM neo_todos t
      JOIN neo_asks a ON a.id = t.ask_id
      JOIN neo_todo_sessions s ON s.todo_id = t.id
      WHERE a.status = 'open' AND t.state = 'doing'
        AND json_extract(t.check_json, '$.pack') = 'coding' AND s.ref IS NOT NULL`)
      .all() as { id: string; ref: string }[];
    const candidates = active.map((row) => {
      const todo = store.getTodo(row.id)!;
      return {
        id: row.id,
        ref: JSON.parse(row.ref) as WorkRef,
        startedAt: todo.startedAt,
        repo: todo.repo ?? codingTodoRepository(todo),
      };
    });
    const claims = this.db
      .prepare(`WITH active AS (
      SELECT t.check_json FROM neo_todos t JOIN neo_asks a ON a.id = t.ask_id
      WHERE a.status = 'open' AND t.state IN ('todo', 'doing', 'blocked'))
      SELECT urls.value AS url FROM active, json_each(active.check_json, '$.params.urls') urls
      UNION SELECT json_extract(check_json, '$.params.url') AS url FROM active
      WHERE json_extract(check_json, '$.params.url') IS NOT NULL`)
      .all() as { url: string }[];
    const named = new Set(claims.flatMap((row) => codingPrKey(row.url) ?? []));
    const prs = rows.map((row) => ({
      url: `https://github.com/${row.repo.toLowerCase()}/pull/${row.number}`,
      createdAt: row.createdAt ?? undefined,
    }));
    const policy = createCodingTodoPolicy({ urls: () => [] });
    const attach = (superpipe({})('coding.attach-unclaimed-pr') as PipelineAPI)
      .input(['pr'])
      .pipe(
        (pr: (typeof prs)[number]) => planCodingTurnOwner(pr, mentions.turns, mentions.todos),
        'pr',
        'owner'
      )
      .pipe(
        (pr: (typeof prs)[number], owner: CodingTurnOwner) =>
          planCodingPrAttachment(pr, owner, candidates, named),
        ['pr', 'owner'],
        'todoId'
      )
      .pipe(
        (todoId: string | null, pr: (typeof prs)[number]) => {
          if (!todoId) return;
          const todo = store.getTodo(todoId)!;
          const check = policy.addUrls(todo, [pr.url]);
          if (!check) return;
          store.updateTodo(
            todo,
            { check, doneWhen: policy.doneWhen(check) ?? todo.doneWhen },
            Date.now()
          );
          named.add(pr.url);
        },
        ['todoId', 'pr'],
        'attached'
      )
      .end('attached') as (pr: (typeof prs)[number]) => void;
    for (const pr of prs) attach(pr);
  }

  lastTurnEndsOfRunningWorkers(): (number | null)[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.ref FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
          WHERE s.ref IS NOT NULL AND s.live_status = 'running' AND t.state = 'doing'`
      )
      .all() as { ref: string }[];
    return rows.map((row) => this.turns.lastEndedAt(JSON.parse(row.ref) as WorkRef));
  }

  private createdAt(url: string) {
    const pr = parsePrUrl(url);
    const row = this.db
      .prepare(
        `SELECT created_at AS createdAt FROM pack_coding_pr_ledger WHERE number = ?2 AND (repo = ?1
          OR repo IN (SELECT canonical FROM pack_coding_repo_aliases WHERE alias = ?1))`
      )
      .get(`${pr?.owner}/${pr?.repo}`.toLowerCase(), Number(pr?.number)) as {
      createdAt: number | null;
    } | null;
    return row?.createdAt ?? undefined;
  }

  ownedPrs(todoId: string): string[] {
    const own = this.own(todoId);
    const row = this.db
      .prepare('SELECT check_json AS json FROM neo_todos WHERE id = ?')
      .get(todoId) as {
      json: string | null;
    } | null;
    const todo = { id: todoId, check: row?.json ? JSON.parse(row.json) : null };
    const urls = planCodingTurnUrls(todo, own);
    const prs = urls.map((url) => ({ url, createdAt: this.createdAt(url) }));
    return planCodingTurnOwned(todo, prs, this.mentions(urls));
  }

  readOwn(todoId: string): Promise<CodingTurn[]> {
    return gatewayFor(this.db).call(codingTurnPrReads, 'own', todoId);
  }

  readMentions(urls: readonly string[]): Promise<CodingTurnMentions> {
    return gatewayFor(this.db).call(codingTurnPrReads, 'mentions', urls);
  }
}

export const codingTurnPrReads = defineRepositoryOp(
  'coding.turnPrReads',
  'read',
  CodingTurnPrRepository,
  ['own', 'mentions'] as const
);

export const readCodingTurnFacts = (superpipe({})('coding.turn-facts') as PipelineAPI)
  .input(['todo', 'turns', 'readPrs'])
  .pipe(
    (todo: NeoTodo, turns: CodingTurnPrRepository) => turns.readOwn(todo.id),
    ['todo', 'turns'],
    'own'
  )
  .pipe(planCodingTurnUrls, ['todo', 'own'], 'urls')
  .pipe((readPrs: NeoWorkPrReader, urls: string[]) => readPrs(urls), ['readPrs', 'urls'], 'read')
  .pipe(
    (turns: CodingTurnPrRepository, urls: string[]) => turns.readMentions(urls),
    ['turns', 'urls'],
    'mentions'
  )
  .pipe(() => Date.now(), 'todo', 'observedAt')
  .pipe(planCodingTurnFacts, ['todo', 'own', 'urls', 'read', 'mentions', 'observedAt'], 'facts')
  .endAsync('facts') as (
  todo: NeoTodo,
  turns: CodingTurnPrRepository,
  readPrs: NeoWorkPrReader
) => Promise<ReturnType<typeof planCodingTurnFacts>>;
