import type { Database } from '../../../src/storage/sqlite-compat.ts';
import { createCodingPack } from '../../../src/lib/neo/packs/coding/pack.ts';
import { createCodingPackTables } from '../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../src/lib/neo/packs/coding/todo-prs.ts';
import { NeoAskTodoRepository } from '../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../src/storage/repositories/neo-todo-session-repository.ts';
import { gatewayFor } from '../../../src/storage/db-gateway/db-gateway.ts';
import { createNeoTodoRunner } from '../../../src/lib/neo/todo-runner.ts';
import { createNeoTodoOperations } from '../../../src/lib/neo/todo-operations.ts';
import { recordStartedWork } from '../../../src/storage/work-started-sessions.ts';

export const stageParams = {
  parentTodoId: 'author-todo',
  url: 'https://github.com/synthetic/stages/pull/7',
  head: 'a'.repeat(40),
  stage: 'review' as 'review' | 'verify',
  acceptanceContract: 'artifact:acceptance',
};
export const stageTarget = {
  adapter: 'fixture',
  place: { machine: 'fixture', name: 'Fixture', folder: '/synthetic' },
  model: 'claude-opus-5-5',
};
export const stageDraft = (stage: 'review' | 'verify' = 'review') => ({
  title: `${stage === 'review' ? 'Review' : 'Verify'} PR #7 at ${stageParams.head}`,
  check: { pack: 'coding', kind: 'stage_result', params: { ...stageParams, stage } },
  instruction: 'Inspect the exact synthetic head.',
  target: { verb: 'start', ...stageTarget },
  after: [],
  start: true,
});
export function codingStageTodoFixture(db: Database) {
  createCodingPackTables(db);
  const store = new NeoAskTodoRepository(db),
    sessions = new NeoTodoSessionRepository(db);
  const ledger = new CodingPrLedgerRepository(db);
  const pack = createCodingPack({
    database: () => db,
    readPrs: async () => [],
    readClaudeOwners: async () => [],
    projectRepos: () => [],
    todoPrs: new CodingTodoPrRepository(db),
    prLedger: ledger,
    prEvents: new CodingPrEventRepository(db),
    prSweep: new CodingPrSweepRepository(db),
    prSweepDeps: { tell: async () => true, wake: async () => {} },
  });
  const ask = store.openAsk({
    id: 'ask',
    sessionId: 'fixture-neo',
    projectId: null,
    repo: 'synthetic/stages',
    originMessageId: null,
    title: 'Synthetic coding matter',
    request: 'Ship a change',
    createdAt: 1,
  });
  const author = store.addTodo(
    stageParams.parentTodoId,
    ask.id,
    {
      title: 'Author',
      doneWhen: 'PR merged',
      check: { pack: 'coding', kind: 'pr_merged', params: { urls: [stageParams.url] } },
      instruction: null,
      named: null,
    },
    1
  );
  sessions.create(author.id, { verb: 'start', ...stageTarget });
  sessions.recordRef(author.id, { adapter: 'fixture', id: 'author' }, 1);
  store.updateTodo(author, { state: 'doing', startedAt: 1 }, 1);
  ledger.stageFacts.observeHead(stageParams.url, stageParams.head, 1);
  const calls: Record<string, unknown>[] = [];
  const runner = createNeoTodoRunner({
    store,
    sessions,
    packs: () => [pack],
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    limits: () => ({ running: 99, perGroup: 99 }),
    changed: () => {},
    tell: async () => {},
    invoke: async (_caller, name, input) => {
      if (name === 'work.start') {
        calls.push(input);
        const excluded = input.excludeRefs as { id: string }[] | undefined;
        const ref = {
          adapter: 'fixture',
          id: ['author', 'reviewer', 'verifier'].find(
            (id) => !excluded?.some((item) => item.id === id)
          )!,
        };
        recordStartedWork(db, ref);
        return { kind: 'completed', value: { ok: true, value: { ref, model: stageTarget.model } } };
      }
      return {
        kind: 'completed',
        value: {
          ok: true,
          value: { status: 'running', lastActivityAt: Date.now(), model: stageTarget.model },
        },
      };
    },
  });
  const operations = createNeoTodoOperations(
    store,
    sessions,
    { ...runner, resolveTarget: async (ref) => ({ value: ref }) },
    () => [pack],
    () => null
  );
  const invoke = async (name: string, input: unknown) => {
    const op = operations.find((op) => op.name === name)!;
    return (await op.execute(op.inputSchema.parse(input), {
      source: 'mcp',
      role: 'neo',
      sessionId: 'fixture-neo',
    })) as { ok: boolean; reason?: string; todo?: typeof author };
  };
  const result = (
    todoId: string,
    verdict: 'pass' | 'fail' | 'inconclusive',
    stage: 'review' | 'qa' = 'review'
  ) => {
    const card = sessions.readCard(todoId)!;
    return ledger.stageFacts.record({
      url: stageParams.url,
      head: stageParams.head,
      stage,
      acceptanceContract: stageParams.acceptanceContract,
      verdict,
      evidence: ['artifact:observed'],
      ref: card.ref!,
      actor: { kind: 'agent', id: card.ref!.id, harness: card.ref!.adapter, model: card.model! },
    });
  };
  return { store, sessions, pack, ledger, runner, operations, calls, invoke, ask, author, result };
}
