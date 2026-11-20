import { proposalQuestionId, requireAcceptedAsk } from './proposal.ts';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { z } from 'zod';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { OperationCaller, OperationDefinition } from '../operations/registry.ts';
import { neoUserFolder } from './folder.ts';
import { desktopControlQuestion, planDesktopControl } from './desktop-control-preference.ts';
import { type NeoInputReads, resolveNeoInputAsk } from './input-ask.ts';
import type { NeoPack } from './pack-contract.ts';
import type {
  NeoTodoControls,
  NeoTodoDraftSchema,
  ResolvedNeoTodoDraft,
} from './todo-operations.ts';

type AddInput = z.infer<typeof NeoTodoDraftSchema> & {
  askId?: string;
  input?: string;
};
type Result = { ok: false; reason: string } | { ok: true; todo?: NeoTodo; records?: string[] };

export async function preflightTodoDesktopControl(
  store: NeoAskTodoRepository,
  askDesktopControl: NeoTodoControls['askDesktopControl'],
  askId: string,
  requested: boolean,
  role: OperationCaller['role']
): Promise<{ value: boolean } | { reason: { ok: false; reason: string } }> {
  if (!requested) return { value: false };
  const decision =
    role === 'neo' ? planDesktopControl(true, await store.read('desktopControlPreference')) : 'off';
  if (decision === 'allow') return { value: true };
  if (decision === 'ask' && askDesktopControl) {
    const question = desktopControlQuestion(askId, await store.desktopControlQuestionState());
    if (question) await askDesktopControl(question);
  }
  return {
    reason: {
      ok: false,
      reason:
        'desktop_control_requires_permission: The human has not allowed desktop control without asking. Add the todo with desktopControl left out, then send a desktop_control card for it.',
    },
  };
}

export async function recordNeoTodoAdmission(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: Pick<NeoTodoControls, 'advance' | 'userFolder' | 'refreshIdentity'>,
  ask: NeoAsk,
  draft: ResolvedNeoTodoDraft,
  packs: readonly NeoPack[],
  desktopControlAllowed: boolean
): Promise<Result> {
  const admitted =
    desktopControlAllowed && draft.named?.desktopControl === true
      ? { ...draft, desktopControlApproved: true as const }
      : draft;
  const result = await admitNeoTodo(store, sessions, controls, ask, admitted, packs);
  if (result.ok && result.todo && draft.target?.verb === 'bind')
    await controls.refreshIdentity?.(result.todo.id);
  return result;
}

async function admitNeoTodo(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: Pick<NeoTodoControls, 'advance' | 'userFolder'>,
  ask: NeoAsk,
  draft: ResolvedNeoTodoDraft,
  packs: readonly NeoPack[]
): Promise<Result> {
  const pack = packs.find((entry) => entry.id === draft.check.pack);
  const covered = pack?.todos?.writerAdd && (await store.writerAddPacks()).includes(pack.id);
  if (!covered) {
    const { recordNeoTodo } = await import('./todo-operations.ts');
    return recordNeoTodo(store, sessions, controls, ask, draft, packs);
  }
  const receipt = await store.commitAdd({
    askId: ask.id,
    todoId: crypto.randomUUID(),
    draft,
    now: Date.now(),
    userFolder: controls.userFolder ?? neoUserFolder(),
  });
  if (!receipt.ok) return receipt;
  const { start, ...result } = receipt;
  if (start) await controls.advance();
  return {
    ...result,
    ...(result.todo ? { todo: (await store.read('getTodo', result.todo.id)) ?? result.todo } : {}),
  };
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
      async (ask: NeoAsk) => {
        const facts = await store.read('askFacts', { askId: ask.id });
        return { ask, facts };
      },
      'outcome',
      'facts'
    )
    .pipe(
      ({
        ask,
        facts,
      }: {
        ask: NeoAsk;
        facts: Awaited<ReturnType<NeoAskTodoRepository['askFacts']>>;
      }) =>
        requireAcceptedAsk(
          ask,
          facts.questions.find((question) => question.id === proposalQuestionId(ask.id)) ?? null,
          facts.questions,
          facts.todos
        ),
      'facts',
      'result:outcome'
    )
    .pipe(
      async (_ask: NeoAsk, input: AddInput) => {
        const { resolveNeoTodoDraft } = await import('./todo-operations.ts');
        return resolveNeoTodoDraft(input, controls.resolveTarget);
      },
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      async (draft: ResolvedNeoTodoDraft, ask: NeoAsk, caller: OperationCaller) => {
        const desktop = await preflightTodoDesktopControl(
          store,
          controls.askDesktopControl,
          ask.id,
          draft.named?.desktopControl === true,
          caller.role
        );
        return 'reason' in desktop ? desktop : { value: { draft, desktopControl: desktop.value } };
      },
      ['outcome', 'ask', 'caller'],
      'result:outcome'
    )
    .pipe(
      (
        { draft, desktopControl }: { draft: ResolvedNeoTodoDraft; desktopControl: boolean },
        ask: NeoAsk
      ) => recordNeoTodoAdmission(store, sessions, controls, ask, draft, packs(), desktopControl),
      ['outcome', 'ask'],
      'outcome'
    )
    .pipe(
      async (result: Result) => {
        if (!result.ok || !result.todo) return result;
        const [todo] = await project([result.todo]);
        return { ...result, todo };
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
