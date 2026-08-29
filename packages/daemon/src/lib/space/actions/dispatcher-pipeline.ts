import superpipe, { type PipelineAPI } from 'superpipe';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import {
  decideAutonomyAdmission,
  resolveEffectiveAutonomyLevel,
} from '../tools/tool-admission-gates.ts';
import { jsonResult, type ToolResult } from '../tools/tool-result.ts';
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
  family?: string;
  safetyClass?: string;
  role: SpaceMcpSessionRole;
  spaceId: string;
  agentName?: string | null;
  sessionId?: string | null;
  taskId?: string;
  workflowRunId?: string;
  outcome: 'dispatched' | 'denied' | 'failed';
  reason?: string;
  elapsedMs?: number;
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
  resolveTaskId?: (
    params: Record<string, unknown>
  ) => string | undefined | Promise<string | undefined>;
  resolveRunId?: (taskId: string) => string | undefined | Promise<string | undefined>;
  validateTargets?: (
    params: unknown,
    spaceId: string,
    action?: RegisteredAction
  ) => string | undefined | Promise<string | undefined>;
  auditReads?: boolean;
}

export interface DispatchActionCtx extends DispatchActionInput {
  deps: DispatchActionDeps;
  action?: RegisteredAction;
  parsedParams?: unknown;
  contextualTaskId?: string;
  isMutating?: boolean;
  rawResult?: unknown;
  outcome?: DispatchActionOutcome;
}

const SPACE_ADMISSION_FAMILIES = [
  'space',
  'sessions',
  'workflows',
  'tasks',
  'scheduled',
  'external_events',
  'inactivity',
] as const;

const ROLE_ACTION_FAMILY_ALLOWLIST: Record<SpaceMcpSessionRole, readonly string[]> = {
  coordinator: SPACE_ADMISSION_FAMILIES,
  ad_hoc_member: SPACE_ADMISSION_FAMILIES,
  workflow_worker: ['node', 'space'],
  long_term_agent: SPACE_ADMISSION_FAMILIES,
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
    const next: DispatchActionCtx = {
      ...ctx,
      outcome: deniedOutcome('unknown_action', `Action not found: ${ctx.actionName}`),
    };
    writeAuditEntry(next, true);
    return next;
  }
  const parsed = action.paramsSchema.safeParse(ctx.params);
  if (!parsed.success) {
    const next: DispatchActionCtx = {
      ...ctx,
      action,
      isMutating: isMutatingSafetyClass(action.safetyClass),
      outcome: deniedOutcome(
        'invalid_params',
        `Invalid parameters for ${action.name}: ${parsed.error.message}`
      ),
    };
    writeAuditEntry(next, true);
    return next;
  }
  const parsedParams = parsed.data as Record<string, unknown> | null;
  const hasTaskId =
    parsedParams !== null &&
    typeof parsedParams.task_id === 'string' &&
    parsedParams.task_id.length > 0;
  const suppressTaskId =
    action.taskIdPreference === 'task_number' &&
    parsedParams !== null &&
    typeof parsedParams.task_number === 'number';
  const targetTaskId =
    hasTaskId && !suppressTaskId && parsedParams !== null
      ? (parsedParams.task_id as string)
      : undefined;
  const parsedRunId =
    parsedParams !== null &&
    typeof parsedParams.run_id === 'string' &&
    parsedParams.run_id.length > 0
      ? parsedParams.run_id
      : undefined;
  const parsedWorkflowRunId =
    parsedParams !== null &&
    typeof parsedParams.workflow_run_id === 'string' &&
    parsedParams.workflow_run_id.length > 0
      ? parsedParams.workflow_run_id
      : undefined;
  const parsedCamelRunId =
    parsedParams !== null &&
    typeof parsedParams.workflowRunId === 'string' &&
    parsedParams.workflowRunId.length > 0
      ? parsedParams.workflowRunId
      : undefined;
  const targetRunId = parsedRunId ?? parsedWorkflowRunId ?? parsedCamelRunId;
  const taskTargetChanged =
    targetTaskId !== undefined && ctx.taskId !== undefined && targetTaskId !== ctx.taskId;
  const runTargetChanged = targetRunId !== undefined && targetRunId !== ctx.workflowRunId;
  return {
    ...ctx,
    action,
    parsedParams: parsed.data,
    contextualTaskId: ctx.taskId,
    taskId: targetTaskId ?? (runTargetChanged ? undefined : ctx.taskId),
    workflowRunId: targetRunId ?? (taskTargetChanged ? undefined : ctx.workflowRunId),
  };
}

export async function resolveTargets(ctx: DispatchActionCtx): Promise<DispatchActionCtx> {
  if (ctx.outcome) return ctx;
  const action = ctx.action!;
  const params = (ctx.parsedParams ?? null) as Record<string, unknown> | null;
  const contextualTaskId = ctx.contextualTaskId;
  let taskId = ctx.taskId;
  let numericLookupMissed = false;
  if (params !== null) {
    const hasTaskId = typeof params.task_id === 'string' && params.task_id.length > 0;
    const prefersNumber = action.taskIdPreference === 'task_number' || !hasTaskId;
    if (typeof params.task_number === 'number' && prefersNumber) {
      if (ctx.deps.resolveTaskId) {
        try {
          taskId = await ctx.deps.resolveTaskId(params);
          if (taskId === undefined) numericLookupMissed = true;
        } catch {
          taskId = undefined;
          numericLookupMissed = true;
        }
      } else {
        taskId = undefined;
        numericLookupMissed = true;
      }
    }
  }
  const explicitRunTarget =
    params !== null &&
    ((typeof params.run_id === 'string' && params.run_id.length > 0) ||
      (typeof params.workflow_run_id === 'string' && params.workflow_run_id.length > 0) ||
      (typeof params.workflowRunId === 'string' && params.workflowRunId.length > 0));
  const targetsTask =
    params !== null &&
    ((typeof params.task_id === 'string' && params.task_id.length > 0) ||
      typeof params.task_number === 'number');
  let workflowRunId = ctx.workflowRunId;
  if (!explicitRunTarget && (numericLookupMissed || targetsTask)) {
    if (taskId !== contextualTaskId) workflowRunId = undefined;
    if (ctx.deps.resolveRunId && taskId !== undefined) {
      try {
        workflowRunId = (await ctx.deps.resolveRunId(taskId)) ?? undefined;
      } catch {}
    }
  }
  return { ...ctx, taskId, workflowRunId };
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
    const next: DispatchActionCtx = {
      ...ctx,
      outcome: deniedOutcome(
        'role_denied',
        `Action ${action.name} (family "${action.family}") is not available for role ${ctx.role}.`
      ),
    };
    writeAuditEntry(denialAuditCtx(next), true);
    return next;
  }
  return ctx;
}

export async function applyAutonomyGate(ctx: DispatchActionCtx): Promise<DispatchActionCtx> {
  if (ctx.outcome) return ctx;
  const action = ctx.action!;
  if (action.autonomyRequirement === undefined) {
    return { ...ctx, spaceLevel: ctx.spaceLevel ?? 1 };
  }
  let spaceLevel = ctx.spaceLevel ?? null;
  if (spaceLevel === null) {
    if (!ctx.deps.getSpaceAutonomyLevel) {
      spaceLevel = 1;
    } else {
      try {
        spaceLevel = await ctx.deps.getSpaceAutonomyLevel(ctx.spaceId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const next: DispatchActionCtx = { ...ctx, outcome: failedOutcome(error) };
        writeAuditEntry(denialAuditCtx(next), true);
        return next;
      }
    }
  }
  const agentLevel = ctx.agentLevel ?? null;
  const effective = resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel });
  let required: number;
  if (typeof action.autonomyRequirement === 'function') {
    try {
      required = await action.autonomyRequirement(ctx.parsedParams);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const next: DispatchActionCtx = {
        ...ctx,
        spaceLevel,
        agentLevel,
        outcome: failedOutcome(error),
      };
      writeAuditEntry(denialAuditCtx(next), true);
      return next;
    }
  } else {
    required = action.autonomyRequirement;
  }
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
  const denied: DispatchActionCtx = {
    ...ctx,
    spaceLevel,
    agentLevel,
    outcome: deniedOutcome('autonomy_denied', admission.message),
  };
  writeAuditEntry(denialAuditCtx(denied), true);
  return denied;
}

export async function applyRateAndAudit(ctx: DispatchActionCtx): Promise<DispatchActionCtx> {
  if (ctx.outcome) return ctx;
  const action = ctx.action!;
  if (typeof action.autonomyRequirement === 'function') {
    let required: number;
    try {
      required = await action.autonomyRequirement(ctx.parsedParams);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const next: DispatchActionCtx = { ...ctx, outcome: failedOutcome(error) };
      writeAuditEntry(denialAuditCtx(next), true);
      return next;
    }
    const spaceLevel = ctx.spaceLevel ?? 1;
    const agentLevel = ctx.agentLevel ?? null;
    const effective = resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel });
    const admission = decideAutonomyAdmission({
      toolName: action.name,
      level: effective.level,
      required,
      agentLevel,
      spaceLevel,
    });
    if (admission.action !== 'allow') {
      const denied: DispatchActionCtx = {
        ...ctx,
        spaceLevel,
        agentLevel,
        outcome: deniedOutcome('autonomy_denied', admission.message),
      };
      writeAuditEntry(denialAuditCtx(denied), true);
      return denied;
    }
  }
  if (ctx.deps.isWithinRateBudget) {
    let ok: boolean;
    try {
      ok = await ctx.deps.isWithinRateBudget();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const next: DispatchActionCtx = { ...ctx, outcome: failedOutcome(error) };
      writeAuditEntry(denialAuditCtx(next), true);
      return next;
    }
    if (!ok) {
      const denied: DispatchActionCtx = {
        ...ctx,
        outcome: deniedOutcome(
          'rate_limited',
          `Action ${action.name} is currently rate limited. Please retry later.`
        ),
      };
      writeAuditEntry(denialAuditCtx(denied), true);
      return denied;
    }
  }
  if (ctx.deps.validateTargets) {
    let message: string | undefined;
    try {
      message = await ctx.deps.validateTargets(ctx.parsedParams, ctx.spaceId, ctx.action);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const next: DispatchActionCtx = { ...ctx, outcome: failedOutcome(error) };
      writeAuditEntry(denialAuditCtx(next), true);
      return next;
    }
    if (message) {
      writeAuditEntry(denialAuditCtx(ctx), true);
      return { ...ctx, outcome: deniedOutcome('invalid_params', message) };
    }
  }
  writeAuditEntry(ctx);
  return ctx;
}

function denialAuditCtx(ctx: DispatchActionCtx): DispatchActionCtx {
  if (typeof ctx.parsedParams !== 'object' || ctx.parsedParams === null) return ctx;
  const record = ctx.parsedParams as Record<string, unknown>;
  const explicitTaskId =
    typeof record.task_id === 'string' && record.task_id.length > 0 ? record.task_id : undefined;
  const numericResolved =
    typeof record.task_number === 'number' &&
    (ctx.action?.taskIdPreference === 'task_number' || !explicitTaskId);
  const runTargetPresent =
    (typeof record.run_id === 'string' && record.run_id.length > 0) ||
    (typeof record.workflow_run_id === 'string' && record.workflow_run_id.length > 0) ||
    (typeof record.workflowRunId === 'string' && record.workflowRunId.length > 0);
  const retainTask = !explicitTaskId || numericResolved || explicitTaskId === ctx.contextualTaskId;
  const taskId = retainTask ? ctx.taskId : undefined;
  const workflowRunId = runTargetPresent ? undefined : ctx.workflowRunId;
  return { ...ctx, taskId, workflowRunId };
}

function writeAuditEntry(ctx: DispatchActionCtx, forceExempt = false): void {
  if (!ctx.deps.auditLogRepo) return;
  const toolName = ctx.action?.name ?? ctx.actionName;
  if (!forceExempt && ctx.action?.auditExempt) return;
  if (!ctx.isMutating && !ctx.deps.auditReads) return;
  try {
    const summaryParams = { ...(ctx.parsedParams as Record<string, unknown> | null) };
    for (const key of ctx.action?.auditRedactKeys ?? []) {
      delete summaryParams[key];
    }
    ctx.deps.auditLogRepo.createEntry({
      agentName: ctx.agentName ?? null,
      sessionId: ctx.sessionId ?? null,
      toolName,
      paramsSummary: JSON.stringify(summaryParams),
      spaceId: ctx.spaceId,
      taskId: ctx.taskId ?? null,
      workflowRunId: ctx.workflowRunId ?? null,
    });
  } catch {}
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

function isToolResult(value: unknown): value is ToolResult {
  if (typeof value !== 'object' || value === null) return false;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { type?: unknown }).type === 'text' &&
      typeof (entry as { text?: unknown }).text === 'string'
  );
}

export function formatResult(ctx: DispatchActionCtx): DispatchActionCtx {
  if (ctx.outcome) return ctx;
  if (ctx.rawResult === undefined) {
    return { ...ctx, outcome: failedOutcome('Missing action result') };
  }
  return {
    ...ctx,
    outcome: {
      action: 'dispatched',
      result: isToolResult(ctx.rawResult) ? ctx.rawResult : jsonResult(ctx.rawResult),
    },
  };
}

export function buildDispatchTelemetryEvent(
  input: DispatchActionInput,
  action: RegisteredAction | undefined,
  outcome: DispatchActionOutcome,
  elapsedMs?: number
): DispatchTelemetryEvent {
  return {
    actionName: action?.name ?? input.actionName,
    family: action?.family,
    safetyClass: action?.safetyClass,
    role: input.role,
    spaceId: input.spaceId,
    agentName: input.agentName,
    sessionId: input.sessionId,
    taskId: input.taskId,
    workflowRunId: input.workflowRunId,
    outcome: outcome.action,
    reason: outcome.action === 'denied' ? outcome.reason : undefined,
    elapsedMs,
    timestamp: Date.now(),
  };
}

export async function emitDispatchTelemetry(
  deps: DispatchActionDeps,
  input: DispatchActionInput,
  action: RegisteredAction | undefined,
  outcome: DispatchActionOutcome,
  elapsedMs?: number
): Promise<void> {
  if (!deps.emitTelemetry) return;
  const event = buildDispatchTelemetryEvent(input, action, outcome, elapsedMs);
  try {
    await deps.emitTelemetry(event);
  } catch {}
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
  .pipe(resolveTargets, 'ctx', 'ctx')
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
  const startedAt = Date.now();
  try {
    const ctx = await run({ ...input, deps });
    const outcome = ctx.outcome ?? failedOutcome('Missing dispatch outcome');
    if (ctx.action?.auditExempt && outcome.action === 'dispatched') {
      writeAuditEntry(ctx, true);
    }
    await emitDispatchTelemetry(
      deps,
      { ...input, taskId: ctx.taskId, workflowRunId: ctx.workflowRunId },
      ctx.action,
      outcome,
      Date.now() - startedAt
    );
    return outcome;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const outcome = failedOutcome(error);
    const action = deps.registry.get(input.actionName);
    await emitDispatchTelemetry(deps, input, action, outcome, Date.now() - startedAt);
    return outcome;
  }
}
