import superpipe, { type PipelineAPI } from 'superpipe';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import { jsonResult, type ToolResult } from '../tools/tool-result.ts';
import {
  decideAutonomyAdmission,
  resolveEffectiveAutonomyLevel,
} from '../tools/tool-admission-gates.ts';
import type { ActionRegistry, RegisteredAction } from './registry.ts';
import { isMutatingSafetyClass } from './safety.ts';

export type DispatchDenyReason =
  | 'unknown_action'
  | 'invalid_params'
  | 'role_denied'
  | 'autonomy_denied'
  | 'rate_limited';

export type DispatchActionOutcome =
  | { action: 'dispatched'; result: ToolResult }
  | { action: 'denied'; reason: DispatchDenyReason; message: string }
  | { action: 'failed'; error: string };

export type DispatchTelemetryEvent = {
  actionName: string;
  family: string;
  safetyClass: string;
  role: SpaceMcpSessionRole;
  spaceId: string;
  taskId?: string;
  workflowRunId?: string;
  outcome: 'dispatched' | 'denied' | 'failed';
  reason?: string;
  timestamp: number;
};

export interface DispatchActionInput {
  actionName: string;
  params: unknown;
  role: SpaceMcpSessionRole;
  spaceId: string;
  taskId?: string;
  workflowRunId?: string;
  agentName?: string | null;
  sessionId?: string | null;
  spaceLevel?: number | null;
  agentLevel?: number | null;
}

export interface DispatchActionDeps {
  registry: ActionRegistry;
  auditLogRepo?: Pick<McpAuditLogRepository, 'createEntry'>;
  getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;
  emitTelemetry?: (event: DispatchTelemetryEvent) => void | Promise<void>;
  isWithinRateBudget?: () => boolean | Promise<boolean>;
}

export interface DispatchActionCtx extends DispatchActionInput {
  deps: DispatchActionDeps;
  action?: RegisteredAction;
  parsedParams?: unknown;
  isMutating?: boolean;
  rawResult?: unknown;
  outcome?: DispatchActionOutcome;
}

const ROLE_ACTION_FAMILY_ALLOWLIST: Record<SpaceMcpSessionRole, readonly string[]> = {
  coordinator: ['space'],
  ad_hoc_member: ['space'],
  workflow_worker: ['node', 'space'],
  long_term_agent: ['space'],
  legacy_task_agent: [],
  outside_space: [],
};

function deniedOutcome(reason: DispatchDenyReason, message: string): DispatchActionOutcome {
  return { action: 'denied', reason, message };
}

function failedOutcome(error: string): DispatchActionOutcome {
  return { action: 'failed', error };
}

export function resolveAction(ctx: DispatchActionCtx): DispatchActionCtx {
  const action = ctx.deps.registry.get(ctx.actionName);
  if (!action) {
    return {
      ...ctx,
      outcome: deniedOutcome('unknown_action', `Action not found: ${ctx.actionName}`),
    };
  }
  const parsed = action.paramsSchema.safeParse(ctx.params);
  if (!parsed.success) {
    return {
      ...ctx,
      action,
      outcome: deniedOutcome(
        'invalid_params',
        `Invalid parameters for ${action.name}: ${parsed.error.message}`
      ),
    };
  }
  return { ...ctx, action, parsedParams: parsed.data };
}

export function applySafetyClass(ctx: DispatchActionCtx): DispatchActionCtx {
  if (ctx.outcome) return ctx;
  return { ...ctx, isMutating: isMutatingSafetyClass(ctx.action!.safetyClass) };
}

export function applyRoleAdmission(ctx: DispatchActionCtx): DispatchActionCtx {
  if (ctx.outcome) return ctx;
  const action = ctx.action!;
  const allowed = ROLE_ACTION_FAMILY_ALLOWLIST[ctx.role] ?? [];
  if (!allowed.includes(action.family)) {
    return {
      ...ctx,
      outcome: deniedOutcome(
        'role_denied',
        `Action ${action.name} (family "${action.family}") is not available for role ${ctx.role}.`
      ),
    };
  }
  return ctx;
}

export async function applyAutonomyGate(ctx: DispatchActionCtx): Promise<DispatchActionCtx> {
  if (ctx.outcome) return ctx;
  const action = ctx.action!;
  const spaceLevel =
    ctx.spaceLevel ??
    (ctx.deps.getSpaceAutonomyLevel ? await ctx.deps.getSpaceAutonomyLevel(ctx.spaceId) : 1);
  const agentLevel = ctx.agentLevel ?? null;
  const effective = resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel });
  const required =
    action.autonomyRequirement === undefined
      ? 1
      : typeof action.autonomyRequirement === 'function'
        ? await action.autonomyRequirement(ctx.parsedParams)
        : action.autonomyRequirement;
  const admission = decideAutonomyAdmission({
    toolName: action.name,
    level: effective.level,
    required,
    agentLevel,
    spaceLevel,
  });
  if (admission.action === 'allow') {
    return { ...ctx, spaceLevel, agentLevel };
  }
  return {
    ...ctx,
    spaceLevel,
    agentLevel,
    outcome: deniedOutcome('autonomy_denied', admission.message),
  };
}

export async function applyRateAndAudit(ctx: DispatchActionCtx): Promise<DispatchActionCtx> {
  if (ctx.outcome) return ctx;
  const action = ctx.action!;
  if (ctx.deps.isWithinRateBudget) {
    const ok = await ctx.deps.isWithinRateBudget();
    if (!ok) {
      return {
        ...ctx,
        outcome: deniedOutcome(
          'rate_limited',
          `Action ${action.name} is currently rate limited. Please retry later.`
        ),
      };
    }
  }
  if (ctx.isMutating && ctx.deps.auditLogRepo) {
    try {
      ctx.deps.auditLogRepo.createEntry({
        agentName: ctx.agentName ?? null,
        sessionId: ctx.sessionId ?? null,
        toolName: action.name,
        paramsSummary: JSON.stringify(ctx.parsedParams ?? {}),
        spaceId: ctx.spaceId,
        taskId: ctx.taskId ?? null,
        workflowRunId: ctx.workflowRunId ?? null,
      });
    } catch {}
  }
  if (ctx.deps.emitTelemetry) {
    const telemetryEntry: DispatchTelemetryEvent = {
      actionName: action.name,
      family: action.family,
      safetyClass: action.safetyClass,
      role: ctx.role,
      spaceId: ctx.spaceId,
      taskId: ctx.taskId,
      workflowRunId: ctx.workflowRunId,
      outcome: 'dispatched',
      timestamp: Date.now(),
    };
    await Promise.resolve(ctx.deps.emitTelemetry(telemetryEntry)).catch(() => {});
  }
  return ctx;
}

export async function executeAction(ctx: DispatchActionCtx): Promise<DispatchActionCtx> {
  if (ctx.outcome) return ctx;
  const action = ctx.action!;
  try {
    const rawResult = await action.handler(ctx.parsedParams);
    return { ...ctx, rawResult };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ...ctx, outcome: failedOutcome(error) };
  }
}

export function formatResult(ctx: DispatchActionCtx): DispatchActionCtx {
  if (ctx.outcome) return ctx;
  if (ctx.rawResult === undefined) {
    return { ...ctx, outcome: failedOutcome('Missing action result') };
  }
  return {
    ...ctx,
    outcome: { action: 'dispatched', result: jsonResult(ctx.rawResult) },
  };
}

const run = (
  superpipe<{ hasOutcome: (ctx: DispatchActionCtx) => boolean }>({
    hasOutcome: (ctx) => ctx.outcome !== undefined,
  })('dispatch-action') as PipelineAPI
)
  .input(['ctx'])
  .pipe(resolveAction, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(applySafetyClass, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(applyRoleAdmission, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(applyAutonomyGate, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(applyRateAndAudit, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(executeAction, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(formatResult, 'ctx', 'ctx')
  .endAsync('ctx') as (
  input: DispatchActionInput & { deps: DispatchActionDeps }
) => Promise<DispatchActionCtx>;

export async function runDispatchAction(
  deps: DispatchActionDeps,
  input: DispatchActionInput
): Promise<DispatchActionOutcome> {
  try {
    const ctx = await run({ ...input, deps });
    return ctx.outcome ?? failedOutcome('Missing dispatch outcome');
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return failedOutcome(error);
  }
}
