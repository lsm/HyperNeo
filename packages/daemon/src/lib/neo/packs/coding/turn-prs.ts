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
  type CodingTurn,
  type CodingTurnMentions,
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

  own(todoId: string): CodingTurn[] {
    const refs = new Map(
      this.deliveries.list(todoId).flatMap((row) => {
        const ref = deliveryRef(row);
        return ref ? [[JSON.stringify(ref), ref] as const] : [];
      })
    );
    return [...refs.values()].flatMap((ref) => {
      const todos = this.todosOf(ref);
      return this.turns
        .list(ref)
        .map((turn, index, all): CodingTurn => ({ ...turn, ref, previous: all[index - 1] ?? null }))
        .filter((turn) => codingTurnTodos(turn, todos).includes(todoId));
    });
  }

  mentions(urls: readonly string[]): CodingTurnMentions {
    const turns = this.turns.mentioning(urls);
    const refs = new Map(turns.map((turn) => [JSON.stringify(turn.ref), turn.ref]));
    return {
      turns,
      todos: Object.fromEntries(
        [...refs.values()].map((ref) => [codingTurnSessionKey(ref), this.todosOf(ref)])
      ),
    };
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

  ownedPrs(todoId: string): string[] | null {
    const own = this.own(todoId);
    if (!own.length) return null;
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
    async (todo: NeoTodo, turns: CodingTurnPrRepository) => {
      const own = await turns.readOwn(todo.id);
      return own.length ? { value: own } : { reason: null };
    },
    ['todo', 'turns'],
    'result:facts'
  )
  .pipe((facts: CodingTurn[]) => facts, 'facts', 'own')
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
) => Promise<ReturnType<typeof planCodingTurnFacts> | null>;
