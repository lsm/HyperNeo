import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { resumedPromptUuid } from '../agent/restart-turn-recovery.ts';
import { NeoAskEntrySchema } from './ask-entries.ts';
import {
  addNeoTodo,
  type NeoTodoControls,
  NeoTodoDraftSchema,
  requireNeoOpenAsk,
} from './todo-operations.ts';
import { isNeoTodoStartable } from './todo-runner.ts';
import type { NeoPack } from './packs/types.ts';
import { neoSplitOutcome, neoTodoRepo } from './todo-repo.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type AskReceipt = { ok: true; ask: NeoAsk; todos: NeoTodo[] };

const Text = z.string().trim().min(1);

const Open = z.object({
  title: Text.max(200),
  request: Text.max(4000),
  projectId: Text.nullable().optional(),
  todos: z.array(NeoTodoDraftSchema).max(20).default([]),
});

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

function requireNeoAskTodosFinished(
  ask: NeoAsk,
  status: z.infer<typeof Settle>['status'],
  todos: readonly NeoTodo[]
): Gate<NeoAsk> {
  const unfinished = todos.filter(
    (todo) => todo.state !== 'done' && !(todo.state === 'removed' && todo.reason)
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
  packs: () => readonly NeoPack[] = () => []
) {
  const open = (superpipe({})('neo.ask.open') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => requireNeoAskSession(caller, isNeoSession),
      'caller',
      'result:outcome'
    )
    .pipe(
      (sessionId: string, input: z.infer<typeof Open>) => {
        const project = requireNeoAskProject(input, resolveProject, knownProjects);
        return 'value' in project ? { value: { sessionId, projectId: project.value } } : project;
      },
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      async (
        { sessionId, projectId }: { sessionId: string; projectId: string | null },
        input: z.infer<typeof Open>,
        caller: OperationCaller
      ): Promise<AskReceipt | Rejection> => {
        const origin = caller.neoTurn ? resumedPromptUuid(caller.neoTurn.messageId) : null;
        const ask =
          store.findAsk(sessionId, origin, input.title) ??
          store.openAsk({
            id: crypto.randomUUID(),
            projectId,
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
          return recorded.find((item) => item.title === todo.title && filed(item) === repo);
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
        }
        const parent = store.getAsk(ask.id) ?? ask;
        const children = store.listChildAsks(ask.id);
        if (split && parent.status === 'open' && !store.listTodos(ask.id).length && children.length)
          store.settleAsk(parent, 'done', neoSplitOutcome(children, family().length), Date.now());
        return { ok: true, ask: store.getAsk(ask.id) ?? ask, todos: family() };
      },
      ['outcome', 'input', 'caller'],
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Open>,
    caller: OperationCaller
  ) => Promise<AskReceipt | Rejection>;

  const settle = (superpipe({})('neo.ask.settle') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Settle>) => requireNeoOpenAsk(store.getAsk(input.askId)),
      'input',
      'result:outcome'
    )
    .pipe(
      (ask: NeoAsk, input: z.infer<typeof Settle>) =>
        requireNeoAskTodosFinished(ask, input.status, store.listTodos(ask.id)),
      ['outcome', 'input'],
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
        "Record a human request as an ask: a short title, request in the human's words, and optionally its todos (as in neo.todo.add). projectId names the project by its id (with or without the project: prefix) or its title; an unknown one is refused with the list of projects. A retry in the same turn returns the same ask. Reuse an open ask for the same request instead of opening another.",
      inputSchema: Open,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => open(input, caller),
    }),
    defineOperation({
      name: 'neo.ask.settle',
      description:
        'End an ask: done when its todos are done, dropped when the human drops it. done is refused while any todo is neither done nor removed with a reason; the refusal lists them. outcome is one short sentence the ask shows. Open questions are retired and running sessions stop.',
      inputSchema: Settle,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => settle(input, caller),
    }),
  ];
}
