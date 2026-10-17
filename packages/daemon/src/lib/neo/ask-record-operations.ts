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
  requireNeoAskOwner,
  requireNeoHumanStart,
} from './todo-operations.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type AskReceipt = { ok: true; ask: NeoAsk; todos: NeoTodo[] };

const Text = z.string().trim().min(1);

const Open = z.object({
  title: Text.max(200),
  request: Text,
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
    todos: NeoAskEntrySchema.shape.todos.element.omit({ status: true, link: true }).array(),
  }),
]);

export function requireNeoAskSession(caller: OperationCaller): Gate<string> {
  return caller.sessionId
    ? { value: caller.sessionId }
    : { reason: { ok: false, reason: 'no_session: only a Neo session opens an ask.' } };
}

export function requireNeoAskProject(
  input: { projectId?: string | null },
  sessionId: string,
  projectOf: (sessionId: string) => string | null,
  resolveProject: (projectId: string) => string | null
): Gate<string | null> {
  const bound = projectOf(sessionId);
  if (input.projectId === undefined) return { value: bound };
  const projectId = input.projectId === null ? null : resolveProject(input.projectId);
  if (input.projectId !== null && !projectId)
    return { reason: { ok: false, reason: `unknown_project: no project ${input.projectId}.` } };
  return bound !== null && projectId !== bound
    ? { reason: { ok: false, reason: `wrong_project: this session holds project ${bound}.` } }
    : { value: projectId };
}

export function createNeoAskRecordOperations(
  store: NeoAskTodoRepository,
  sessions: NeoTodoSessionRepository,
  controls: NeoTodoControls,
  projectOf: (sessionId: string) => string | null,
  resolveProject: (projectId: string) => string | null
) {
  const open = (superpipe({})('neo.ask.open') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Open>, caller: OperationCaller) =>
        requireNeoHumanStart({ start: input.todos.some((todo) => todo.start) }, caller),
      ['input', 'caller'],
      'result:outcome'
    )
    .pipe(requireNeoAskSession, 'caller', 'result:outcome')
    .pipe(
      (sessionId: string, input: z.infer<typeof Open>) => {
        const project = requireNeoAskProject(input, sessionId, projectOf, resolveProject);
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
        const origin = caller.neoTurn?.messageId ?? null;
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
        for (const [index, todo] of input.todos.entries()) {
          const row = recorded[index];
          const added = !row
            ? await addNeoTodo(store, sessions, controls.start, ask.id, todo)
            : todo.start && row.state === 'todo'
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
      (input: z.infer<typeof Settle>, caller: OperationCaller) =>
        requireNeoAskOwner(store.getAsk(input.askId), caller),
      ['input', 'caller'],
      'result:outcome'
    )
    .pipe(
      async (ask: NeoAsk, input: z.infer<typeof Settle>): Promise<AskReceipt> => {
        for (const todo of store.listTodos(ask.id)) await controls.stop(todo);
        const settled = store.settleAsk(ask, input.status, input.outcome, Date.now());
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
        "Record a human request as an ask: a short title, request in the human's words, and optionally its todos (as in neo.todo.add). A retry in the same turn returns the same ask. Reuse an open ask for the same request instead of opening another.",
      inputSchema: Open,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => open(input, caller),
    }),
    defineOperation({
      name: 'neo.ask.settle',
      description:
        'End an ask you own: done when its todos are done, dropped when the human drops it. outcome is one short sentence the ask shows. Open questions are retired and running sessions stop.',
      inputSchema: Settle,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => settle(input, caller),
    }),
  ];
}
