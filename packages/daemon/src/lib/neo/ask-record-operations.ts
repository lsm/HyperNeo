import { neoToolDescription } from '@hyperneo/prompts';
import { neoTodoAfterRefusal } from './todo-dependencies.ts';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { todoEvidenceFile } from '../work-locations.ts';
import { neoEvidenceRefusal, withAssignedEvidence } from './core-todo-checks.ts';
import { neoUserFolder } from './folder.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import {
  defineOperation,
  isAgentSessionCaller,
  type OperationCaller,
} from '../operations/registry.ts';
import { NeoAskEntrySchema } from './ask-entries.ts';
import {
  recordNeoTodo,
  startNeoTodoWhenFree,
  resolveNeoTodoDraft,
  type NeoTodoControls,
  NeoTodoDraftSchema,
  planNeoTodoDraft,
  requireNeoOpenAsk,
} from './todo-operations.ts';
import { isNeoTodoStartable } from './todo-runner.ts';
import type { NeoPack, NeoTodoPolicyScope } from './pack-contract.ts';
import { neoTodoRepository } from './pack-contract.ts';
import type { SessionGoal } from '@hyperneo/shared/types/session-goal';
import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import {
  neoAskSettlementReads,
  requireNeoAskSettlement,
  neoAskSettlementWrites,
} from '../../storage/repositories/neo-ask-settlement.ts';
import type { WorkRef } from '../drivers/types.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type AskReceipt = { ok: true; ask: NeoAsk; todos: NeoTodo[]; records?: string[] };

const Text = z.string().trim().min(1);
const Topic = Text.max(12);

const Open = z.object({
  title: Text.max(200),
  topic: Topic.optional(),
  request: Text.max(4000),
  projectId: Text.nullable().optional(),
  goalId: Text.nullable().optional(),
  todos: z.array(NeoTodoDraftSchema).max(20).default([]),
});

const Outcome = z.object({ askId: Text, outcome: Text.max(4000) });

const TopicInput = z.object({ askId: Text, topic: Topic });

const Settle = z.object({
  askId: Text,
  status: z.enum(['done', 'dropped']),
  outcome: Text.max(500),
});

const AskResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    ask: NeoAskEntrySchema.shape.ask,
    records: z.array(z.string()).optional(),
    todos: NeoAskEntrySchema.shape.todos.element
      .omit({ status: true, link: true, remoteLink: true })
      .array(),
  }),
]);

export function requireNeoAskSession(
  caller: OperationCaller,
  isNeoSession: (sessionId: string) => boolean
): Gate<string> {
  return caller.sessionId && isNeoSession(caller.sessionId)
    ? { value: caller.sessionId }
    : { reason: { ok: false, reason: 'no_session: only a Neo session opens an ask.' } };
}

export function requireAskSession(caller: OperationCaller): Gate<string> {
  return isAgentSessionCaller(caller)
    ? { value: caller.sessionId! }
    : { reason: { ok: false, reason: 'no_session: opening an ask needs an agent session.' } };
}

export function requireNeoAskGoal(
  goalId: string | null,
  _sessionId: string,
  goal: SessionGoal | null
): Gate<string | null> {
  return !goalId || goal
    ? { value: goalId }
    : {
        reason: {
          ok: false,
          reason: 'goal_not_found: no such goal.',
        },
      };
}

export function requireNeoAskProject(
  input: { projectId?: string | null },
  resolveProject: (projectId: string) => string | null,
  knownProjects: () => readonly { id: string; title: string }[] = () => []
): Gate<string | null> {
  if (!input.projectId) return { value: null };
  const projectId = resolveProject(input.projectId);
  if (projectId) return { value: projectId };
  const known = knownProjects()
    .slice(0, 50)
    .map((project) => `${project.id} (${project.title})`);
  const list = known.length ? ` Projects: ${known.join('; ')}.` : '';
  return {
    reason: { ok: false, reason: `unknown_project: no project ${input.projectId}.${list}` },
  };
}

export function neoAskMatterRefusal(
  draft: Pick<NeoAsk, 'title' | 'request' | 'projectId'>,
  open: readonly Pick<NeoAsk, 'id' | 'title' | 'request' | 'projectId' | 'createdAt'>[],
  packs: readonly Pick<NeoPack, 'matter'>[]
): string | null {
  const matter = (ask: Pick<NeoAsk, 'title' | 'request' | 'projectId'>) =>
    packs.map((pack) => pack.matter?.(ask)).find(Boolean) ?? null;
  const key = matter(draft);
  const first = key
    ? open
        .filter((ask) => matter(ask) === key)
        .sort((left, right) => left.createdAt - right.createdAt)[0]
    : null;
  return first
    ? `ask_open: "${first.title}" (${first.id}) is already open for ${key}. Add the todos to that ask with neo.todo.add; open another only after it is settled.`
    : null;
}

export function requireNeoAskOwner(
  ask: NeoAsk,
  caller: OperationCaller,
  isNeoSession: (sessionId: string) => boolean
): Gate<NeoAsk> {
  return ask.sessionId === caller.sessionId ||
    (caller.role === 'neo' && !isNeoSession(ask.sessionId))
    ? { value: ask }
    : { reason: { ok: false, reason: 'not_owned: this ask belongs to another session.' } };
}

export function createNeoAskRecordOperations(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: NeoTodoControls,
  resolveProject: (projectId: string) => string | null,
  isNeoSession: (sessionId: string) => boolean,
  knownProjects: () => readonly { id: string; title: string }[],
  packs: () => readonly NeoPack[] = () => [],
  readGoal: (id: string) => SessionGoal | null = () => null,
  project: <T extends NeoTodo>(todos: readonly T[]) => Promise<T[]> = async (todos) => [...todos],
  settlement: { gateway: DbGateway; changed(): void }
) {
  const present = async (result: AskReceipt | Rejection) =>
    result.ok ? { ...result, todos: await project(result.todos) } : result;
  const open = (superpipe({})('neo.ask.open') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe((caller: OperationCaller) => requireAskSession(caller), 'caller', 'result:outcome')
    .pipe(
      (sessionId: string, input: z.infer<typeof Open>) => {
        const project = requireNeoAskProject(input, resolveProject, knownProjects);
        return 'value' in project ? { value: { sessionId, projectId: project.value } } : project;
      },
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (
        { sessionId, projectId }: { sessionId: string; projectId: string | null },
        input: z.infer<typeof Open>
      ) => {
        const id = input.goalId ?? null;
        const goal = requireNeoAskGoal(id, sessionId, id ? readGoal(id) : null);
        return 'value' in goal ? { value: { sessionId, projectId, goalId: goal.value } } : goal;
      },
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      async (
        {
          sessionId,
          projectId,
          goalId,
        }: { sessionId: string; projectId: string | null; goalId: string | null },
        input: z.infer<typeof Open>,
        _caller: OperationCaller
      ): Promise<AskReceipt | Rejection> => {
        const policies = packs();
        const origin = null;
        const priorAsk = store.findAsk(sessionId, origin, input.title, goalId);
        const family = (ask: NeoAsk | null) =>
          ask
            ? [
                ...store.listTodos(ask.id),
                ...store.listChildAsks(ask.id).flatMap((child) => store.listTodos(child.id)),
              ]
            : [];
        const recorded = family(priorAsk);
        const readScope: NeoTodoPolicyScope = { ask: priorAsk };
        const storedScopes = new Map<string, NeoTodoPolicyScope>();
        const recordedRow = (
          todo: (typeof input.todos)[number],
          scope: NeoTodoPolicyScope = readScope
        ) => {
          const repo = neoTodoRepository(todo, policies, scope);
          const stored = (item: NeoTodo) => {
            let itemScope = storedScopes.get(item.id);
            if (!itemScope) {
              itemScope = { ask: null, todo: item };
              storedScopes.set(item.id, itemScope);
            }
            return neoTodoRepository(item, policies, itemScope);
          };
          const filed = (item: NeoTodo) =>
            neoTodoRepository(
              { check: item.check, named: item.named, target: sessions.get(item.id) },
              policies,
              scope
            );
          return recorded.find(
            (item) => item.title === todo.title && (stored(item) === repo || filed(item) === repo)
          );
        };
        const homeless =
          priorAsk && priorAsk.status !== 'open' && input.todos.find((todo) => !recordedRow(todo));
        if (priorAsk && homeless)
          return {
            ok: true,
            ask: priorAsk,
            todos: family(priorAsk),
            records: [
              `ask_settled: ${priorAsk.title} is settled and "${homeless.title}" has no open card in it; nothing was added. Open a new ask for it with a different title, since this title in this turn reaches the settled request.`,
            ],
          };
        const refused = input.todos
          .filter((todo) => !recordedRow(todo))
          .map((todo) => {
            const check = withAssignedEvidence(todo.check, todoEvidenceFile('pending'));
            const reason = neoEvidenceRefusal(
              check,
              neoTodoRepository(todo, policies, readScope),
              controls.userFolder ?? neoUserFolder()
            );
            return reason
              ? { reason: { ok: false as const, reason } }
              : planNeoTodoDraft({ ...todo, check }, policies);
          })
          .find((planned) => 'reason' in planned);
        if (refused && 'reason' in refused) return refused.reason;
        const existing = priorAsk ? store.listFamilyTodos(priorAsk.id) : [];
        const badAfter = input.todos
          .map((todo, index) => {
            const row = recordedRow(todo);
            if (row) return null;
            return neoTodoAfterRefusal(
              existing,
              index,
              todo.after?.map((ref) =>
                typeof ref === 'number' && ref < index && input.todos[ref]
                  ? (recordedRow(input.todos[ref])?.id ?? ref)
                  : ref
              )
            );
          })
          .find(Boolean);
        if (badAfter) return { ok: false as const, reason: badAfter };
        const drafts: ((typeof input.todos)[number] & { workerRemotes?: readonly string[] })[] = [];
        for (const todo of input.todos) {
          if (recordedRow(todo) || (priorAsk && priorAsk.status !== 'open')) {
            drafts.push(todo);
            continue;
          }
          const resolved = await resolveNeoTodoDraft(todo, controls.resolveTarget);
          if ('reason' in resolved) return resolved.reason;
          drafts.push(resolved.value);
        }
        const current = priorAsk
          ? store.getAsk(priorAsk.id)
          : store.findAsk(sessionId, origin, input.title, goalId);
        if (priorAsk && !current) return { ok: false, reason: 'not_found: no such ask.' };
        const taken = current
          ? null
          : neoAskMatterRefusal(
              { ...input, projectId },
              store.listOpenAsks().filter((ask) => ask.sessionId === sessionId),
              policies
            );
        if (taken) return { ok: false, reason: taken };
        const ask =
          current ??
          store.openAsk({
            id: crypto.randomUUID(),
            projectId,
            goalId,
            sessionId,
            originMessageId: origin,
            title: input.title,
            topic: input.topic ?? null,
            request: input.request,
            createdAt: Date.now(),
          });
        recorded.push(...family(ask));
        const records: string[] = [];
        const ids: (string | undefined)[] = [];
        const currentScope = priorAsk?.id === ask.id ? readScope : { ask };
        const rows = drafts.map((todo) => recordedRow(todo, currentScope));
        for (const [index, todo] of drafts.entries()) {
          const row = rows[index];
          const after = todo.after.map((ref) =>
            typeof ref === 'number' ? (ref < index ? (ids[ref] ?? `#${ref}`) : `#${ref}`) : ref
          );
          const added = !row
            ? await recordNeoTodo(
                store,
                sessions,
                controls,
                store.getAsk(ask.id)!,
                { ...todo, after },
                policies
              )
            : todo.start && isNeoTodoStartable(row)
              ? await startNeoTodoWhenFree(store, controls, store.approveTodo(row, Date.now()))
              : { ok: true as const };
          if (!added.ok) return added;
          if (row && [...after].sort().join() !== [...(row.dependsOn ?? [])].sort().join())
            records.push(
              `after_ignored: "${row.title}" already exists; change what it waits for with neo.todo.edit.`
            );
          ids.push(row?.id ?? ('todo' in added ? added.todo?.id : undefined));
          if ('records' in added && added.records) records.push(...added.records);
        }
        return {
          ok: true,
          ask: store.getAsk(ask.id) ?? ask,
          todos: family(ask),
          ...(records.length ? { records } : {}),
        };
      },
      ['outcome', 'input', 'caller'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Open>,
    caller: OperationCaller
  ) => Promise<AskReceipt | Rejection>;

  const recordOutcome = (superpipe({})('neo.ask.outcome') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) =>
        caller.source === 'mcp'
          ? requireNeoAskSession(caller, isNeoSession)
          : {
              reason: {
                ok: false as const,
                reason: 'neo_required: the owning Neo records the discussion outcome.',
              },
            },
      'caller',
      'result:outcome'
    )
    .pipe(
      (input: z.infer<typeof Outcome>) => requireNeoOpenAsk(store.getAsk(input.askId)),
      'input',
      'result:outcome'
    )
    .pipe(
      (ask: NeoAsk, caller: OperationCaller) => requireNeoAskOwner(ask, caller, isNeoSession),
      ['outcome', 'caller'],
      'result:outcome'
    )
    .pipe(
      (ask: NeoAsk): Gate<NeoAsk> =>
        ask.focusedSession
          ? { value: ask }
          : {
              reason: {
                ok: false,
                reason: 'not_focused: this ask has no focused discussion session.',
              },
            },
      'outcome',
      'result:outcome'
    )
    .pipe(
      (ask: NeoAsk, input: z.infer<typeof Outcome>): AskReceipt => ({
        ok: true,
        ask: store.recordAskOutcome(ask.id, input.outcome, Date.now()),
        todos: store.listTodos(ask.id),
      }),
      ['outcome', 'input'],
      'outcome'
    )
    .end('outcome') as (
    input: z.infer<typeof Outcome>,
    caller: OperationCaller
  ) => AskReceipt | Rejection;

  const setTopic = (superpipe({})('neo.ask.topic') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => requireNeoAskSession(caller, isNeoSession),
      'caller',
      'result:outcome'
    )
    .pipe(
      (input: z.infer<typeof TopicInput>) => requireNeoOpenAsk(store.getAsk(input.askId)),
      'input',
      'result:outcome'
    )
    .pipe(
      (ask: NeoAsk, caller: OperationCaller) => requireNeoAskOwner(ask, caller, isNeoSession),
      ['outcome', 'caller'],
      'result:outcome'
    )
    .pipe(
      (ask: NeoAsk, input: z.infer<typeof TopicInput>): AskReceipt => ({
        ok: true,
        ask: store.setAskTopic(ask.id, input.topic, Date.now()),
        todos: store.listTodos(ask.id),
      }),
      ['outcome', 'input'],
      'outcome'
    )
    .end('outcome') as (
    input: z.infer<typeof TopicInput>,
    caller: OperationCaller
  ) => AskReceipt | Rejection;

  const refKey = (ref: WorkRef | null) =>
    ref ? JSON.stringify([ref.adapter, ref.id, ref.daemon ?? null]) : null;
  const settle = (superpipe({})('neo.ask.settle') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      async (input: z.infer<typeof Settle>) => {
        const snapshot = await settlement.gateway.call(
          neoAskSettlementReads,
          'snapshot',
          input.askId
        );
        return requireNeoAskSettlement(snapshot, input);
      },
      'input',
      'result:outcome'
    )
    .pipe(
      async (
        { todos }: { todos: NeoTodo[] },
        input: z.infer<typeof Settle>
      ): Promise<AskReceipt | Rejection> => {
        const failed: string[] = [];
        const stopped: string[] = [];
        const swept = new Map<string, string | null>();
        for (const todo of todos) {
          const context = await sessions.read('stopContext', todo.id);
          swept.set(todo.id, refKey(context?.ref ?? null));
          const failure = await controls.stop(todo);
          if (failure) failed.push(`${todo.title}: ${failure}`);
          else if (context?.ref && !context.adopted) stopped.push(todo.title);
        }
        if (failed.length) {
          const current = await settlement.gateway.call(
            neoAskSettlementReads,
            'snapshot',
            input.askId
          );
          if ('ok' in current) return current;
          return {
            ok: false,
            reason: `${failed.join(' ')}; the ask is still open${
              stopped.length ? ` (stopped: ${stopped.join(', ')})` : ''
            }, and those sessions may still run.`,
          };
        }
        const committed = await settlement.gateway.call(
          neoAskSettlementWrites,
          'settle',
          input,
          Date.now()
        );
        if (!committed.ok) return committed;
        const { refs, ...receipt } = committed;
        settlement.changed();
        for (const { todoId, ref } of refs) {
          const todo = receipt.todos.find((todo) => todo.id === todoId);
          if (todo && ref && swept.get(todoId) !== refKey(ref)) await controls.stop(todo);
        }
        return receipt;
      },
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Settle>,
    caller: OperationCaller
  ) => Promise<AskReceipt | Rejection>;

  return [
    defineOperation({
      name: 'neo.ask.open',
      description: neoToolDescription('neo.ask.open'),
      inputSchema: Open,
      resultSchema: AskResult,
      policy: {
        safetyClass: 'mutate',
        roles: ['neo', 'workflow_worker', 'direct_task_worker', 'long_term_agent'],
      },
      execute: async (input, caller) => present(await open(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.outcome',
      description: neoToolDescription('neo.ask.outcome'),
      inputSchema: Outcome,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(recordOutcome(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.topic',
      description: neoToolDescription('neo.ask.topic'),
      inputSchema: TopicInput,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(setTopic(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.settle',
      description: neoToolDescription('neo.ask.settle'),
      inputSchema: Settle,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await settle(input, caller)),
    }),
  ];
}
