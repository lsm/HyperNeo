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
  knownProjects: () => readonly { id: string; title: string }[]
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
        const recorded = store.listTodos(ask.id);
        for (const todo of input.todos) {
          const row = recorded.find((item) => item.title === todo.title);
          const added = !row
            ? await addNeoTodo(store, sessions, controls.start, ask.id, todo)
            : todo.start && isNeoTodoStartable(row)
              ? await controls.start(row.id)
              : { ok: true as const };
          if (!added.ok) return added;
        }
        return { ok: true, ask, todos: store.listTodos(ask.id) };
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
        'End an ask: done when its todos are done, dropped when the human drops it. outcome is one short sentence the ask shows. Open questions are retired and running sessions stop.',
      inputSchema: Settle,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => settle(input, caller),
    }),
  ];
}
