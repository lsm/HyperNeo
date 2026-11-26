import { proposalQuestionId, requireAcceptedAsk } from './proposal.ts';
import type { NeoAsk, NeoDesktopApp, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { type DesktopAppName, resolveDesktopApps } from '../desktop/app-scope.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { z } from 'zod';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { OperationCaller, OperationDefinition } from '../operations/registry.ts';
import { neoUserFolder } from './folder.ts';
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
  topic?: string;
  desktopApps?: string[];
};
type Result = { ok: false; reason: string } | { ok: true; todo?: NeoTodo; records?: string[] };

export const DESKTOP_CONTROL_REFUSAL = {
  ok: false as const,
  reason:
    'desktop_control_requires_permission: Leave desktopControl out. A todo uses only the apps in its own desktopApps; call desktop.access.request {app} first so the Mac asks the human for that app.',
};

export function requireNeoTodoAddAsk(
  ask: NeoAsk | null,
  byAskId = false
): { value: NeoAsk } | { reason: { ok: false; reason: string } } {
  if (!ask) return { reason: { ok: false, reason: 'not_found: no such ask.' } };
  if (ask.status !== 'open')
    return {
      reason: {
        ok: false,
        reason: `ask_settled: this ask is ${ask.status}; the todo was not added. ${byAskId ? 'Pass the human message input without askId to open a new ask, or use' : 'Use'} neo.ask.propose with a new title.`,
      },
    };
  return { value: ask };
}

async function neoTodoDesktopScope(
  bundleIds: readonly string[],
  ask: NeoAsk,
  name?: DesktopAppName
): Promise<{ value: NeoDesktopApp[] } | { reason: string }> {
  const resolved = await resolveDesktopApps(bundleIds, name);
  if ('missing' in resolved)
    return {
      reason: `app_not_found: no installed app has bundle id ${resolved.missing}. Use the bundleId desktop.access.request returned.`,
    };
  for (const app of resolved.value) {
    const approved = ask.desktopApps?.find(({ bundleId }) => bundleId === app.bundleId);
    if (!approved)
      return {
        reason: `desktop_app_not_approved: ${app.name} is not on this ask's approved card. Propose a new ask with desktopApps so the card asks.`,
      };
    if (approved.seen !== 'all')
      return {
        reason:
          'desktop_consent_outdated: Propose a new ask with desktopApps and wait for approval.',
      };
  }
  return { value: resolved.value };
}

export async function recordNeoTodoAdmission(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: Pick<NeoTodoControls, 'advance' | 'userFolder' | 'refreshIdentity'>,
  ask: NeoAsk,
  draft: ResolvedNeoTodoDraft,
  packs: readonly NeoPack[]
): Promise<Result> {
  const result = await admitNeoTodo(store, sessions, controls, ask, draft, packs);
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
      async (binding: Awaited<ReturnType<typeof resolveNeoInputAsk>>, input: AddInput) =>
        'reason' in binding
          ? binding
          : requireNeoTodoAddAsk(await store.read('getAsk', binding.value.askId), !input.input),
      ['binding', 'input'],
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
      (draft: ResolvedNeoTodoDraft) =>
        draft.named?.desktopControl === true
          ? { reason: DESKTOP_CONTROL_REFUSAL }
          : { value: draft },
      'outcome',
      'result:outcome'
    )
    .pipe(
      async (draft: ResolvedNeoTodoDraft, ask: NeoAsk, input: AddInput) => {
        if (!input.desktopApps) return { value: draft };
        const scope = await neoTodoDesktopScope(input.desktopApps, ask, controls.desktopAppName);
        return 'reason' in scope
          ? { reason: { ok: false as const, reason: scope.reason } }
          : { value: { ...draft, desktopScope: scope.value } };
      },
      ['outcome', 'ask', 'input'],
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
