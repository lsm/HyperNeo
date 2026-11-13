import type { NeoWorkerNameSource } from '../../../src/lib/neo/worker-name.ts';
import { createCodingPackTables } from '../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { Database } from '../../../src/storage/sqlite-compat.ts';
import type { WorkRef } from '../../../src/lib/drivers/types.ts';
import type { NeoPack } from '../../../src/lib/neo/pack-contract.ts';
import type { OperationOutcome } from '../../../src/lib/operations/invoke.ts';
import { recordedWorkInvoke } from './recorded-work-invoke.ts';
import { createNeoTodoRunner } from '../../../src/lib/neo/todo-runner.ts';
import { createNeoTodoOperations } from '../../../src/lib/neo/todo-operations.ts';
import { createNeoAskRecordOperations } from '../../../src/lib/neo/ask-record-operations.ts';
import { gatewayFor } from '../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../src/storage/repositories/neo-todo-session-repository.ts';

export function packWorkerStartFixture(
  db: Database,
  options: {
    hook?: boolean;
    beforeStart?: (todo: NeoTodo) => void;
    workerNames?: NeoWorkerNameSource;
    invoke?: (name: string, input: Record<string, unknown>) => Promise<OperationOutcome>;
  } = {}
) {
  createCodingPackTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const checked: string[] = [];
  const fixture: NeoPack = {
    id: 'fixture',
    describe: 'Generic start policy fixture',
    instructions: () => null,
    todos: {
      schema: () => {},
      check: async () => ({ done: false, evidence: null }),
      statusLine: () => null,
      doneWhen: () => 'Synthetic result recorded',
    },
  };
  if (options.hook !== false)
    Object.assign(fixture, {
      workerStartExclusions: async (todo: NeoTodo) => {
        checked.push(todo.id);
        options.beforeStart?.(todo);
        const ids = (todo.check?.params.excludeTodoIds ?? []) as string[];
        const refs = ids.map((id) => sessions.readRef(id));
        return refs.some((ref) => !ref)
          ? { reason: 'missing_worker_binding' }
          : { value: refs as WorkRef[] };
      },
    });
  const packs = () => [fixture];
  const gateway = gatewayFor(db);
  const runner = createNeoTodoRunner({
    store,
    sessions,
    packs,
    workerNames: () => options.workerNames,
    write: gateway.run.bind(gateway),
    limits: () => ({ running: 99, perGroup: 99 }),
    tell: async () => {},
    changed: () => {},
    invoke: recordedWorkInvoke(sessions.inputs, async (_caller, name, input) => {
      calls.push({ name, input });
      if (options.invoke) return options.invoke(name, input);
      const excluded = (input.excludeRefs ?? []) as WorkRef[];
      const ref = ['author', 'prior', 'independent']
        .map((id) => ({ adapter: 'fixture', id }))
        .find(
          (ref) => !excluded.some((item) => item.id === ref.id && item.adapter === ref.adapter)
        )!;
      return {
        kind: 'completed',
        value: { ok: true, value: { ref, status: 'done', lastActivityAt: Date.now() } },
      };
    }),
  });
  const controls = { ...runner, resolveTarget: async (ref: WorkRef) => ({ value: ref }) };
  const operations = [
    ...createNeoTodoOperations(store, sessions, controls, packs, () => null),
    ...createNeoAskRecordOperations(
      store,
      sessions,
      controls,
      () => null,
      () => true,
      () => [],
      packs,
      undefined,
      undefined,
      { gateway, changed: () => {} }
    ),
  ];
  const invoke = async (name: string, input: unknown) => {
    const op = operations.find((item) => item.name === name)!;
    return (await op.execute(op.inputSchema.parse(input), {
      source: 'mcp',
      role: 'neo',
      sessionId: 'fixture-neo',
    })) as {
      ok: boolean;
      todo: NeoTodo;
      todos: NeoTodo[];
      reason?: string;
    };
  };
  const draft = (title: string, excludeTodoIds: string[] = []) => ({
    title,
    check: { pack: 'fixture', kind: 'result', params: { excludeTodoIds } },
    instruction: 'Run the synthetic task.',
    target: { verb: 'start', adapter: 'fixture' },
    after: [],
  });
  const open = () =>
    invoke('neo.ask.open', { title: 'Synthetic matter', request: 'Track tasks', todos: [] });
  const bind = (todoId: string, id: string, daemon?: string) => {
    const ref = { adapter: 'fixture', id, ...(daemon ? { daemon } : {}) };
    if (!sessions.get(todoId)) sessions.create(todoId, { verb: 'adopt', ref });
    sessions.recordRef(todoId, ref, Date.now());
  };
  return { store, sessions, runner, operations, calls, checked, invoke, draft, open, bind };
}
