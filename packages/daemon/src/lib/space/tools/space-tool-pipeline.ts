import { decisionRun } from '../runtime/decision-pipeline';
import type { TaskUpdateRouting, TaskUpdateRoutingInput } from './task-transition-routing';
import { routeTaskUpdate } from './task-transition-routing';
import type { AutonomyAdmissionDecision } from './tool-admission-gates';
import { decideAutonomyAdmission, getToolAutonomyRequirement } from './tool-admission-gates';

export type SpaceToolDecision =
  | Extract<AutonomyAdmissionDecision, { action: 'deny' }>
  | TaskUpdateRouting;

export interface SpaceToolCtx extends TaskUpdateRoutingInput {
  toolName: string;
  level: number;
  agentLevel: number | null;
  spaceLevel: number;
  decision: SpaceToolDecision | null;
}

export type SpaceToolInput = Omit<SpaceToolCtx, 'decision'>;

function decided(ctx: SpaceToolCtx, decision: SpaceToolDecision): SpaceToolCtx {
  return { ...ctx, decision };
}

export function applyAutonomyGate(ctx: SpaceToolCtx): SpaceToolCtx {
  const required = getToolAutonomyRequirement(ctx.toolName);
  if (required === undefined) return ctx;
  const admission = decideAutonomyAdmission({
    toolName: ctx.toolName,
    level: ctx.level,
    required,
    agentLevel: ctx.agentLevel,
    spaceLevel: ctx.spaceLevel,
  });
  return admission.action === 'allow' ? ctx : decided(ctx, admission);
}

export function applyArgChangesGate(ctx: SpaceToolCtx): SpaceToolCtx {
  return ctx.hasChanges ? ctx : decided(ctx, routeTaskUpdate(ctx));
}

export function applyTargetGate(ctx: SpaceToolCtx): SpaceToolCtx {
  return ctx.taskExists && ctx.taskInSpace ? ctx : decided(ctx, routeTaskUpdate(ctx));
}

export function applyRoutingArbiter(ctx: SpaceToolCtx): SpaceToolCtx {
  return decided(ctx, routeTaskUpdate(ctx));
}

const updateTaskDecisionRun = decisionRun('space-tool-update-task', [
  applyAutonomyGate,
  applyArgChangesGate,
  applyTargetGate,
  applyRoutingArbiter,
]);

export function decideUpdateTask(input: SpaceToolInput): SpaceToolDecision {
  const ctx = updateTaskDecisionRun(input);
  return ctx.decision ?? routeTaskUpdate(input);
}
