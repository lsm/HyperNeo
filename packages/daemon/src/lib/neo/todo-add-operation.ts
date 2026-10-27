import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { z } from 'zod';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { OperationCaller, OperationDefinition } from '../operations/registry.ts';
import type { NeoPack } from './pack-contract.ts';
import {
  type NeoTodoControls,
  type NeoTodoDraftSchema,
  planNeoTodoDraft,
  recordNeoTodo,
  requireNeoOpenAsk,
  resolveNeoTodoDraft,
} from './todo-operations.ts';

type Draft = z.infer<typeof NeoTodoDraftSchema>;
type Result = { ok: false; reason: string } | { ok: true; todo?: NeoTodo; records?: string[] };

export async function recordNeoTodoAdmission(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: Pick<NeoTodoControls, 'start'>,
  ask: NeoAsk,
  draft: Draft,
  packs: readonly NeoPack[],
  split = false
): Promise<Result> {
  if (!['core', 'coding'].includes(draft.check.pack))
    return recordNeoTodo(store, sessions, controls, ask, draft, packs, split);
  const receipt = await store.commitAdd({
    askId: ask.id,
    todoId: crypto.randomUUID(),
    draft,
    split,
    now: Date.now(),
  });
  if (!receipt.ok) return receipt;
  const { start, ...result } = receipt;
  return start
    ? { ...(await controls.start(start)), ...(result.records ? { records: result.records } : {}) }
    : result;
}

export function wireNeoTodoAdd(
  definitions: readonly OperationDefinition[],
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: NeoTodoControls,
  packs: () => readonly NeoPack[],
  project: <T extends NeoTodo>(todos: readonly T[]) => Promise<T[]>
): OperationDefinition[] {
  const add = (superpipe({})('neo.todo.add-through-writer') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      async (input: Draft & { askId: string }) => {
        const ask = await store.read('getAsk', input.askId);
        return ask && ask.status !== 'open'
          ? {
              reason: {
                ok: true as const,
                todos: await project(await store.read('listTodosForAsks', [ask.id])),
                records: [`ask_settled: this ask is ${ask.status}; no change was made.`],
              },
            }
          : requireNeoOpenAsk(ask);
      },
      'input',
      'result:outcome'
    )
    .pipe((ask: NeoAsk) => ask, 'outcome', 'ask')
    .pipe(
      (_ask: NeoAsk, input: Draft) => resolveNeoTodoDraft(input, controls.resolveTarget),
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe((draft: Draft) => planNeoTodoDraft(draft, packs()), 'outcome', 'result:outcome')
    .pipe(
      (draft: Draft, ask: NeoAsk) =>
        recordNeoTodoAdmission(store, sessions, controls, ask, draft, packs()),
      ['outcome', 'ask'],
      'outcome'
    )
    .pipe(
      async (result: Result) => {
        if (!result.ok) return result;
        const todos = result.todo ? await store.read('listTodosForAsks', [result.todo.askId]) : [];
        const [todo, ...projected] = await project(result.todo ? [result.todo, ...todos] : todos);
        return { ...result, ...(result.todo ? { todo } : {}), todos: result.todo ? projected : [] };
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (
    input: Draft & { askId: string },
    caller: OperationCaller
  ) => Promise<unknown>;
  return definitions.map((entry) =>
    entry.name === 'neo.todo.add'
      ? { ...entry, execute: (input, caller) => add(input as Draft & { askId: string }, caller) }
      : entry
  );
}
