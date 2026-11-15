import type { Session } from '@hyperneo/shared';
import { randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { McpAuditLogRepository } from '../../storage/repositories/mcp-audit-log-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { getDataDir } from '../data-dir.ts';
import {
  defineOperation,
  isAgentSessionCaller,
  type OperationCaller,
} from '../operations/registry.ts';
import { DesktopDispatchReply, dispatchDesktopCall } from './host-dispatch.ts';
import { desktopOptIn, readDesktopTodos, type DesktopTodoRow } from './opt-in.ts';
import catalog from './tool-catalog.json' with { type: 'json' };

const Input = z
  .object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()) })
  .strict();
const Refusal = z.object({
  ok: z.literal(false),
  decision: z.literal('refused'),
  reason: z.string(),
  dispatched: z.literal(false),
});
const tools = new Set(catalog.map((tool) => tool.name));
const refuse = (reason: string) => ({
  reason: { ok: false, decision: 'refused', reason, dispatched: false },
});
type Binding = { todo: string; worker: string; workDir: string };
type Facts = {
  todo: DesktopTodoRow | null;
  worker: string;
  workDir: string | null;
  toolAllowed: boolean;
};

export function decideDesktopCall(facts: Facts) {
  if (!facts.todo || !facts.workDir) return refuse('desktop_not_enabled');
  if (!facts.toolAllowed) return refuse('tool_not_allowed');
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
        isAgentSessionCaller(caller) && caller.principal === undefined
          ? { value: caller.sessionId! }
          : refuse('desktop_not_enabled'),
      'caller',
      'result:outcome'
    )
    .pipe(
      (worker: string, input: z.infer<typeof Input>): Facts => {
        const session = options.getSession(worker);
        return {
          todo: desktopOptIn(readDesktopTodos(db, worker), worker),
          worker,
          workDir: session?.worktree?.worktreePath ?? session?.workspacePath ?? null,
          toolAllowed: tools.has(input.tool),
        };
      },
      ['outcome', 'input'],
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
      'Run an allowed desktop action for this in-process session’s approved, opted-in todo.',
    inputSchema: Input,
    resultSchema: z.union([DesktopDispatchReply.extend({ ok: z.boolean() }), Refusal]),
    policy: { safetyClass: 'mutate' },
    execute: call,
  });
}
