import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { NeoAskEntrySchema } from './ask-entries.ts';
import {
  addNeoTodo,
  type NeoTodoControls,
  NeoTodoDraftSchema,
  planNeoTodoDraft,
  requireNeoOpenAsk,
} from './todo-operations.ts';
import { isNeoTodoStartable } from './todo-runner.ts';
import type { NeoPack } from './pack-contract.ts';
import { neoSplitOutcome, neoTodoRepo } from './todo-repo.ts';
import type { SessionGoal } from '@hyperneo/shared/types/session-goal';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type AskReceipt = { ok: true; ask: NeoAsk; todos: NeoTodo[]; records?: string[] };

const Text = z.string().trim().min(1);

const Open = z.object({
  title: Text.max(200),
  request: Text.max(4000),
  projectId: Text.nullable().optional(),
  goalId: Text.nullable().optional(),
  todos: z.array(NeoTodoDraftSchema).max(20).default([]),
});

const Outcome = z.object({ askId: Text, outcome: Text.max(4000) });

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
  return caller.sessionId
    ? { value: caller.sessionId }
    : { reason: { ok: false, reason: 'no_session: opening an ask needs a session.' } };
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

function requireNeoAskTodosFinished(
  ask: NeoAsk,
  status: z.infer<typeof Settle>['status'],
  todos: readonly NeoTodo[]
): Gate<NeoAsk> {
  const unfinished = todos.filter(
    (todo) =>
      !['done', 'closed_unverified'].includes(todo.state) &&
      !(todo.state === 'removed' && todo.reason)
  );
  if (status !== 'done' || !unfinished.length) return { value: ask };
  const listed = unfinished.map((todo) => `"${todo.title}" (${todo.id}, ${todo.state})`);
  return {
    reason: {
      ok: false,
      reason: `todos_unfinished: finish or remove these todos first: ${listed.join(', ')}.`,
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

export function createNeoAskRecordOperations(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: NeoTodoControls,
  resolveProject: (projectId: string) => string | null,
  isNeoSession: (sessionId: string) => boolean,
  knownProjects: () => readonly { id: string; title: string }[],
  packs: () => readonly NeoPack[] = () => [],
  readGoal: (id: string) => SessionGoal | null = () => null,
  project: <T extends NeoTodo>(todos: readonly T[]) => Promise<T[]> = async (todos) => [...todos]
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
        const origin = null;
        const ask =
          store.findAsk(sessionId, origin, input.title, goalId) ??
          store.openAsk({
            id: crypto.randomUUID(),
            projectId,
            goalId,
            sessionId,
            originMessageId: origin,
            title: input.title,
            request: input.request,
            createdAt: Date.now(),
          });
        const family = () => [
          ...store.listTodos(ask.id),
          ...store.listChildAsks(ask.id).flatMap((child) => store.listTodos(child.id)),
        ];
        const recorded = family();
        const split =
          store.listChildAsks(ask.id).length > 0 ||
          new Set(input.todos.map((todo) => neoTodoRepo(todo, packs(), ask)).filter(Boolean)).size >
            1;
        const recordedRow = (todo: (typeof input.todos)[number]) => {
          const repo = neoTodoRepo(todo, packs(), ask);
          const filed = (item: NeoTodo) =>
            neoTodoRepo(
              { check: item.check, named: item.named, target: sessions.get(item.id) },
              packs(),
              ask
            );
          return recorded.find(
            (item) => item.title === todo.title && (item.repo === repo || filed(item) === repo)
          );
        };
        const homeless =
          ask.status !== 'open' &&
          input.todos.find((todo) => {
            const repo = neoTodoRepo(todo, packs(), ask);
            return !recordedRow(todo) && (!repo || !store.childAsk(ask.id, repo));
          });
        if (homeless)
          return {
            ok: false,
            reason: `ask_settled: ${ask.title} is settled and "${homeless.title}" has no open card in it; nothing was added. Open a new ask for it with a different title, since this title in this turn reaches the settled request.`,
          };
        const refused = input.todos
          .filter((todo) => !recordedRow(todo))
          .map((todo) => planNeoTodoDraft(todo, packs()))
          .find((planned) => 'reason' in planned);
        if (refused && 'reason' in refused) return refused.reason;
        const records: string[] = [];
        for (const todo of input.todos) {
          const row = recordedRow(todo);
          const added = !row
            ? await addNeoTodo(
                store,
                sessions,
                controls.start,
                store.getAsk(ask.id)!,
                todo,
                packs(),
                split
              )
            : todo.start && isNeoTodoStartable(row)
              ? await controls.start(row.id)
              : { ok: true as const };
          if (!added.ok) return added;
          if ('records' in added && added.records) records.push(...added.records);
        }
        const parent = store.getAsk(ask.id) ?? ask;
        const children = store.listChildAsks(ask.id);
        if (split && parent.status === 'open' && !store.listTodos(ask.id).length && children.length)
          store.settleAsk(parent, 'done', neoSplitOutcome(children, family().length), Date.now());
        return {
          ok: true,
          ask: store.getAsk(ask.id) ?? ask,
          todos: family(),
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
      (ask: NeoAsk, caller: OperationCaller): Gate<NeoAsk> =>
        ask.sessionId !== caller.sessionId
          ? { reason: { ok: false, reason: 'not_owned: this ask belongs to another Neo.' } }
          : ask.focusedSession
            ? { value: ask }
            : {
                reason: {
                  ok: false,
                  reason: 'not_focused: this ask has no focused discussion session.',
                },
              },
      ['outcome', 'caller'],
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

  const settle = (superpipe({})('neo.ask.settle') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Settle>) => requireNeoOpenAsk(store.getAsk(input.askId)),
      'input',
      'result:outcome'
    )
    .pipe(
      (ask: NeoAsk, input: z.infer<typeof Settle>, caller: OperationCaller) =>
        caller.source === 'rpc' && caller.principal === 'local'
          ? { value: ask }
          : requireNeoAskTodosFinished(ask, input.status, store.listTodos(ask.id)),
      ['outcome', 'input', 'caller'],
      'result:outcome'
    )
    .pipe(
      async (ask: NeoAsk, input: z.infer<typeof Settle>): Promise<AskReceipt | Rejection> => {
        const failed: string[] = [];
        const stopped: string[] = [];
        const swept = new Set<string>();
        for (const todo of store.listTodos(ask.id)) {
          if (sessions.readRef(todo.id)) swept.add(todo.id);
          const failure = await controls.stop(todo);
          if (failure) failed.push(`${todo.title}: ${failure}`);
          else if (swept.has(todo.id)) stopped.push(todo.title);
        }
        if (failed.length)
          return {
            ok: false,
            reason: `${failed.join(' ')}; the ask is still open${
              stopped.length ? ` (stopped: ${stopped.join(', ')})` : ''
            }, and those sessions may still run.`,
          };
        const settled = store.settleAsk(ask, input.status, input.outcome, Date.now());
        for (const todo of store.listTodos(ask.id))
          if (!swept.has(todo.id) && sessions.readRef(todo.id)) await controls.stop(todo);
        return { ok: true, ask: settled, todos: store.listTodos(ask.id) };
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
      description:
        "Record a human request as an ask: a short title, request in the human's words, and optionally its todos (as in neo.todo.add). Any daemon session opens asks; goalId links work in a goal cycle to a goal any session owns. projectId names the project by its id (with or without the project: prefix) or its title; an unknown one is refused with the list of projects. A retry in the same turn returns the same ask. Reuse an open ask for the same request instead of opening another.",
      inputSchema: Open,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await open(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.outcome',
      description:
        'Record the settled focused discussion outcome on an open ask owned by this Neo. Use only an explicit report from ask.focusedSession after the human says the discussion is settled, naming this ask and its decision, documents and PRs. outcome is concise Markdown with document/PR references, not inferred approval from a relayed turn. This keeps the ask and its todos open, preserves its session link and does not stop or dispatch work. Track agreed execution using existing todos and pack checks; neo.ask.settle still requires them finished.',
      inputSchema: Outcome,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(recordOutcome(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.settle',
      description:
        'End an ask: done when its todos are done or explicitly closed unverified, dropped when the human drops it. Unverified todos keep that label and never count as done. Agent completion is refused while a todo is still open or failed; a local human may explicitly confirm done. outcome is one short sentence the ask shows. Open questions are retired and running sessions stop.',
      inputSchema: Settle,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => present(await settle(input, caller)),
    }),
  ];
}
