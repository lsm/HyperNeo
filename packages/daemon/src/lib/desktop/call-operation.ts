import type { Session } from '@hyperneo/shared';
import { randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { McpAuditLogRepository } from '../../storage/repositories/mcp-audit-log-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { getDataDir } from '../data-dir.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { DesktopDispatchReply, dispatchDesktopCall } from './host-dispatch.ts';
import { desktopOptIn, readDesktopTodos, type DesktopTodoRow } from './opt-in.ts';
import catalog from './tool-catalog.json' with { type: 'json' };

const arm = (tool: { name: string; description: string; inputSchema: unknown }) =>
  z
    .object({
      tool: z.literal(tool.name).describe(tool.description),
      args: z.fromJSONSchema(tool.inputSchema as z.core.JSONSchema.JSONSchema) as z.ZodType<
        Record<string, unknown>
      >,
    })
    .strict();
const [first, ...rest] = catalog.map(arm);
const Input = z.discriminatedUnion('tool', [first, ...rest]);
const Refusal = z.object({
  ok: z.literal(false),
  decision: z.literal('refused'),
  reason: z.string(),
  dispatched: z.literal(false),
});
const refuse = (reason: string) => ({
  reason: { ok: false, decision: 'refused', reason, dispatched: false },
});
type Binding = { todo: string; worker: string; workDir: string };
type Facts = {
  todo: DesktopTodoRow | null;
  worker: string;
  workDir: string | null;
  finished?: boolean;
  ambiguous?: boolean;
};

export function decideDesktopCall(facts: Facts) {
  if (!facts.todo && facts.ambiguous) return refuse('todo_ambiguous');
  if (!facts.todo && facts.finished) return refuse('todo_not_active');
  if (!facts.todo || !facts.workDir) return refuse('desktop_not_enabled');
  return { value: { todo: facts.todo.id, worker: facts.worker, workDir: facts.workDir } };
}

export function createDesktopCallOperation(
  db: Database,
  options: {
    getSession: (id: string) => Pick<Session, 'workspacePath' | 'worktree'> | null;
    dataDir?: string;
  }
) {
  const audit = new McpAuditLogRepository(db);
  const call = (superpipe({})('desktop.call') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) =>
        caller.source === 'mcp' &&
        !!caller.sessionId &&
        !!caller.role &&
        caller.role !== 'neo' &&
        caller.principal === undefined
          ? { value: caller.sessionId! }
          : refuse('desktop_worker_only'),
      'caller',
      'result:outcome'
    )
    .pipe(
      (worker: string): Facts => {
        const session = options.getSession(worker);
        const rows = readDesktopTodos(db, worker);
        const todo = desktopOptIn(rows, worker);
        const active = rows.filter((row) => row.active);
        return {
          todo,
          ambiguous:
            !active.some((row) => row.doing) &&
            active.filter((row) => JSON.parse(row.named ?? '{}').desktopControl === true).length >
              1,
          finished:
            !todo &&
            !rows.some((row) => row.active) &&
            rows.some(
              (row) => row.finished && JSON.parse(row.named ?? '{}').desktopControl === true
            ),
          worker,
          workDir: session?.worktree?.worktreePath ?? session?.workspacePath ?? null,
        };
      },
      'outcome',
      'facts'
    )
    .pipe(decideDesktopCall, 'facts', 'result:outcome')
    .pipe(
      (input: z.infer<typeof Input>, binding: Binding) =>
        dispatchDesktopCall(options.dataDir ?? getDataDir(), {
          worker: binding.worker,
          workDir: binding.workDir,
          tool: input.tool,
          arguments: input.args,
          callId: randomUUID(),
        }),
      ['input', 'outcome'],
      'reply'
    )
    .pipe(
      (
        input: z.infer<typeof Input>,
        binding: Binding,
        reply: z.infer<typeof DesktopDispatchReply>,
        caller: OperationCaller
      ) => {
        audit.createEntry({
          sessionId: binding.worker,
          agentName: caller.agentName,
          spaceId: caller.spaceId,
          toolName: 'desktop.call',
          paramsSummary: JSON.stringify({
            todo: binding.todo,
            session: binding.worker,
            tool: input.tool,
            app: reply.bundle_id,
            class: reply.class,
            decision: reply.decision,
            reason: reply.reason,
            dispatched: reply.dispatched,
          }),
        });
        return { ...reply, ok: reply.decision === 'allowed' && reply.reason === null };
      },
      ['input', 'outcome', 'reply', 'caller'],
      'outcome'
    )
    .endAsync('outcome');
  return defineOperation({
    name: 'desktop.call',
    description:
      'Run an allowed desktop action for this in-process session’s approved, opted-in todo. Only a worker session can call it; Neo gets desktop_worker_only and has no switch to turn it on.',
    inputSchema: Input,
    resultSchema: z.union([DesktopDispatchReply.extend({ ok: z.boolean() }), Refusal]),
    policy: { safetyClass: 'mutate' },
    execute: call,
  });
}
