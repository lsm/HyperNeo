import type { MessageInputKind } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { ClearConversationCancelledError, type AgentSession } from '../../agent/agent-session.ts';
import {
  acquireContextClearBoundary,
  type ContextClearBoundaryOwner,
} from '../../agent/message-delivery.ts';
import { Logger } from '../../logger.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../../session-resolution/target.ts';
import type { AgentMessageDeliveryOutcome } from './agent-message-router.ts';
import type { MailboxHandoffArgs, MailboxHandoffOutcome } from './prompt-mailbox-handoff.ts';

const log = new Logger('agent-message-delivery');

export interface AgentMessageDeliveryDeps {
  workflowRunId: string;
  taskRepo: {
    getTask(taskId: string): { workflowRunId?: string | null; status?: string } | null;
  };
  nodeExecutionRepo: {
    listByWorkflowRun(runId: string): Array<{
      agentSessionId?: string | null;
      agentName: string;
      workflowNodeId?: string;
    }>;
  };
  resolveTerminalStatus(runId: string, taskId?: string): string | null;
  ensureSession(target: SessionTarget): Promise<EnsureSessionOutcome>;
  getSessionAsync(sessionId: string): Promise<AgentSession | null>;
  withSessionInjectLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  isRateOrUsageLimited(status: string): boolean;
  slotResetsContext(sessionId: string): boolean;
  hasActiveDeliveryJob(sessionId: string): boolean;
  hasUnconsumedDeliveredWork(sessionId: string, excludeMessageId?: string): boolean;
  hasHeldDeliveryBacklog(sessionId: string, excludeMessageId?: string): boolean;
  handoffToMailbox(args: Omit<MailboxHandoffArgs, 'deps'>): Promise<MailboxHandoffOutcome>;
  publishStatusChanged(
    sessionId: string,
    dbId: string,
    status: 'enqueued' | 'deferred'
  ): Promise<void>;
  recordActivity(sessionId: string): void;
}

export interface AgentMessageDeliveryArgs {
  deps: AgentMessageDeliveryDeps;
  target: SessionTarget;
  message: string;
  messageId: string;
}

export interface AgentMessageDeliveryPlan {
  shouldDefer: boolean;
  shouldClear: boolean;
}

interface AgentMessageDeliveryCtx extends AgentMessageDeliveryArgs {
  resolution?: EnsureSessionOutcome;
  session?: AgentSession | null;
  plan?: AgentMessageDeliveryPlan;
  clearOwner?: ContextClearBoundaryOwner | null;
  outcome?: AgentMessageDeliveryOutcome;
}

export interface LockedAgentMessageDeliveryCtx
  extends Omit<AgentMessageDeliveryCtx, 'resolution' | 'session'> {
  resolution: { kind: 'resolved'; sessionId: string; created: boolean };
  session: AgentSession;
}

function buildSyntheticDeliveryMessage(
  sessionId: string,
  messageId: string,
  text: string
): SDKUserMessage & { isSynthetic: boolean; inputKind: MessageInputKind } {
  return {
    type: 'user' as const,
    uuid: messageId as UUID,
    session_id: sessionId,
    parent_tool_use_id: null,
    isSynthetic: true,
    inputKind: 'task',
    message: {
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
    },
  };
}

function findWorkerExecution(
  deps: AgentMessageDeliveryDeps,
  target: Extract<SessionTarget, { kind: 'worker' }>,
  sessionId: string
) {
  return deps.nodeExecutionRepo
    .listByWorkflowRun(deps.workflowRunId)
    .find(
      (candidate) =>
        candidate.agentSessionId === sessionId &&
        candidate.agentName === target.agentName &&
        (target.workflowNodeId === undefined || candidate.workflowNodeId === target.workflowNodeId)
    );
}

export function guardRoutedWorkerRun(ctx: AgentMessageDeliveryCtx): AgentMessageDeliveryCtx {
  if (ctx.outcome || ctx.target.kind !== 'worker') return ctx;
  const { deps, target } = ctx;
  const task = deps.taskRepo.getTask(target.taskId);
  if (task?.workflowRunId !== deps.workflowRunId) {
    return {
      ...ctx,
      outcome: { state: 'not_found', messageId: ctx.messageId, error: 'workflow run changed' },
    };
  }
  const terminalStatus = deps.resolveTerminalStatus(deps.workflowRunId, target.taskId);
  if (terminalStatus) {
    return {
      ...ctx,
      outcome: {
        state: 'failed',
        messageId: ctx.messageId,
        error: `task/run is terminal (${terminalStatus})`,
      },
    };
  }
  return ctx;
}

export async function resolveDeliverySession(
  ctx: AgentMessageDeliveryCtx
): Promise<AgentMessageDeliveryCtx> {
  if (ctx.outcome) return ctx;
  const resolution = await ctx.deps.ensureSession(ctx.target);
  if (resolution.kind === 'unresolved') {
    const outcome: AgentMessageDeliveryOutcome = resolution.reason.startsWith('internal:')
      ? { state: 'failed', messageId: ctx.messageId, error: resolution.reason }
      : { state: 'not_found', messageId: ctx.messageId, error: resolution.reason };
    return { ...ctx, resolution, outcome };
  }
  return { ...ctx, resolution };
}

export async function loadDeliverySession(
  ctx: AgentMessageDeliveryCtx
): Promise<AgentMessageDeliveryCtx> {
  if (ctx.outcome || !ctx.resolution || ctx.resolution.kind !== 'resolved') return ctx;
  const session = await ctx.deps.getSessionAsync(ctx.resolution.sessionId);
  if (!session) {
    return {
      ...ctx,
      session: null,
      outcome: {
        state: 'not_found',
        messageId: ctx.messageId,
        error: 'resolved session unavailable',
      },
    };
  }
  return { ...ctx, session };
}

export function revalidateRoutedWorker(
  ctx: LockedAgentMessageDeliveryCtx
): LockedAgentMessageDeliveryCtx {
  if (ctx.outcome || ctx.target.kind !== 'worker') return ctx;
  const { deps, target } = ctx;
  const sessionId = ctx.resolution.sessionId;
  const task = deps.taskRepo.getTask(target.taskId);
  const execution = findWorkerExecution(deps, target, sessionId);
  if (task?.workflowRunId !== deps.workflowRunId || !execution) {
    return {
      ...ctx,
      outcome: { state: 'not_found', messageId: ctx.messageId, error: 'workflow run changed' },
    };
  }
  const terminalStatus = deps.resolveTerminalStatus(deps.workflowRunId, target.taskId);
  if (terminalStatus) {
    return {
      ...ctx,
      outcome: {
        state: 'failed',
        sessionId,
        messageId: ctx.messageId,
        error: `task/run is terminal (${terminalStatus})`,
      },
    };
  }
  return ctx;
}

export function planDeliveryAdmission(
  ctx: LockedAgentMessageDeliveryCtx
): LockedAgentMessageDeliveryCtx {
  if (ctx.outcome) return ctx;
  const { deps, target } = ctx;
  const sessionId = ctx.resolution.sessionId;
  const status = ctx.session.getProcessingState().status;
  const task = target.kind === 'worker' ? deps.taskRepo.getTask(target.taskId) : null;
  const shouldDefer =
    status === 'rate_limit_cooldown' ||
    (task !== null && deps.isRateOrUsageLimited(task.status ?? '')) ||
    deps.hasHeldDeliveryBacklog(sessionId, ctx.messageId);
  const isBusy =
    status === 'processing' ||
    status === 'queued' ||
    status === 'waiting_for_input' ||
    status === 'interrupted' ||
    status === 'rate_limit_cooldown';
  const shouldClear =
    !shouldDefer &&
    !isBusy &&
    Boolean(ctx.session.session.sdkSessionId) &&
    deps.slotResetsContext(sessionId) &&
    !deps.hasActiveDeliveryJob(sessionId) &&
    !deps.hasUnconsumedDeliveredWork(sessionId, ctx.messageId);
  return { ...ctx, plan: { shouldDefer, shouldClear } };
}

export async function applyDeliveryContextReset(
  ctx: LockedAgentMessageDeliveryCtx
): Promise<LockedAgentMessageDeliveryCtx> {
  if (ctx.outcome || ctx.plan?.shouldClear !== true) return ctx;
  const sessionId = ctx.resolution.sessionId;
  let clearOwner: ContextClearBoundaryOwner | null = null;
  try {
    clearOwner = await acquireContextClearBoundary(sessionId);
    await ctx.session.clearConversationContext(clearOwner);
  } catch (err) {
    clearOwner?.release();
    clearOwner = null;
    if (err instanceof ClearConversationCancelledError) throw err;
    log.warn(
      `agent-message-delivery: resetContextPerTurn clear failed for session ${sessionId}: ` +
        `${err instanceof Error ? err.message : String(err)} — delivering without clear`
    );
  }
  return { ...ctx, clearOwner };
}

export async function handoffDeliveryToMailbox(
  ctx: LockedAgentMessageDeliveryCtx
): Promise<LockedAgentMessageDeliveryCtx> {
  if (ctx.outcome) return ctx;
  const sessionId = ctx.resolution.sessionId;
  const shouldDefer = ctx.plan?.shouldDefer === true;
  const message = buildSyntheticDeliveryMessage(sessionId, ctx.messageId, ctx.message);
  try {
    const outcome = await ctx.deps.handoffToMailbox({
      target: {
        sessionId,
        messageId: ctx.messageId,
        message,
        origin: 'space_agent',
        ...(shouldDefer ? { defer: true } : {}),
      },
      ...(shouldDefer ? {} : { stateManager: ctx.session.stateManager }),
      publishStatusChanged: ctx.deps.publishStatusChanged,
    });
    if (outcome.state === 'stale') {
      throw new Error('Mailbox handoff became stale');
    }
    ctx.deps.recordActivity(sessionId);
    return { ...ctx, outcome: { state: 'delivered', sessionId, messageId: ctx.messageId } };
  } finally {
    ctx.clearOwner?.release();
  }
}

const runLockedAgentMessageDelivery = (
  superpipe({})('locked-agent-message-delivery') as PipelineAPI
)
  .input(['ctx'])
  .pipe(revalidateRoutedWorker, 'ctx', 'ctx')
  .pipe(planDeliveryAdmission, 'ctx', 'ctx')
  .pipe(applyDeliveryContextReset, 'ctx', 'ctx')
  .pipe(handoffDeliveryToMailbox, 'ctx', 'ctx')
  .endAsync('ctx') as (
  ctx: LockedAgentMessageDeliveryCtx
) => Promise<LockedAgentMessageDeliveryCtx>;

export async function deliverUnderSessionLock(
  ctx: AgentMessageDeliveryCtx
): Promise<AgentMessageDeliveryCtx> {
  if (ctx.outcome) return ctx;
  const { resolution, session } = ctx;
  if (!resolution || resolution.kind !== 'resolved' || !session) return ctx;
  const locked: LockedAgentMessageDeliveryCtx = { ...ctx, resolution, session };
  const delivered = await ctx.deps.withSessionInjectLock(resolution.sessionId, () =>
    runLockedAgentMessageDelivery(locked)
  );
  return { ...ctx, plan: delivered.plan, outcome: delivered.outcome };
}

const runAgentMessageDelivery = (superpipe({})('agent-message-delivery') as PipelineAPI)
  .input(['ctx'])
  .pipe(guardRoutedWorkerRun, 'ctx', 'ctx')
  .pipe(resolveDeliverySession, 'ctx', 'ctx')
  .pipe(loadDeliverySession, 'ctx', 'ctx')
  .pipe(deliverUnderSessionLock, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: AgentMessageDeliveryCtx) => Promise<AgentMessageDeliveryCtx>;

export async function deliverAgentMessageToTarget(
  args: AgentMessageDeliveryArgs
): Promise<AgentMessageDeliveryOutcome> {
  const ctx = await runAgentMessageDelivery(args);
  return (
    ctx.outcome ?? {
      state: 'failed',
      messageId: args.messageId,
      error: 'delivery unsettled',
    }
  );
}
