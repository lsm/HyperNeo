import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { z } from 'zod';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { OperationCaller, OperationDefinition } from '../operations/registry.ts';
import { neoUserFolder } from './folder.ts';
import { type NeoInputReads, resolveNeoInputAsk } from './input-ask.ts';
import type { NeoPack } from './pack-contract.ts';
import {
  type NeoTodoControls,
  type NeoTodoDraftSchema,
  type ResolvedNeoTodoDraft,
  recordNeoTodo,
  resolveNeoTodoDraft,
} from './todo-operations.ts';

type AddInput = z.infer<typeof NeoTodoDraftSchema> & {
  askId?: string;
  input?: string;
};
type Result = { ok: false; reason: string } | { ok: true; todo?: NeoTodo; records?: string[] };

export async function recordNeoTodoAdmission(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: Pick<NeoTodoControls, 'start' | 'userFolder'>,
  ask: NeoAsk,
  draft: ResolvedNeoTodoDraft,
  packs: readonly NeoPack[]
): Promise<Result> {
  if (!['core', 'coding'].includes(draft.check.pack))
    return recordNeoTodo(store, sessions, controls, ask, draft, packs);
  const receipt = await store.commitAdd({
    askId: ask.id,
    todoId: crypto.randomUUID(),
    draft,
    now: Date.now(),
    userFolder: controls.userFolder ?? neoUserFolder(),
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
  project: <T extends NeoTodo>(todos: readonly T[]) => Promise<T[]>,
  inputs: NeoInputReads
): OperationDefinition[] {
  const add = (superpipe({})('neo.todo.add-through-writer') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: AddInput, caller: OperationCaller) =>
        resolveNeoInputAsk(store, inputs, caller, input, input.title),
      ['input', 'caller'],
      'binding'
    )
    .pipe(
      async (binding: Awaited<ReturnType<typeof resolveNeoInputAsk>>) => {
        if ('reason' in binding) return binding;
        const ask = await store.read('getAsk', binding.value.askId);
        return ask && ask.status !== 'open'
          ? {
              reason: {
                ok: true as const,
                todos: await project(await store.read('listTodosForAsks', [ask.id])),
                records: [`ask_settled: this ask is ${ask.status}; no change was made.`],
              },
            }
          : ask
            ? { value: ask }
            : { reason: { ok: false as const, reason: 'not_found: no such ask.' } };
      },
      'binding',
      'result:outcome'
    )
    .pipe((ask: NeoAsk) => ask, 'outcome', 'ask')
    .pipe(
      (_ask: NeoAsk, input: AddInput) => resolveNeoTodoDraft(input, controls.resolveTarget),
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (draft: ResolvedNeoTodoDraft, ask: NeoAsk) =>
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
    .endAsync('outcome') as (input: AddInput, caller: OperationCaller) => Promise<unknown>;
  return definitions.map((entry) =>
    entry.name === 'neo.todo.add'
      ? { ...entry, execute: (input, caller) => add(input as AddInput, caller) }
      : entry
  );
}
