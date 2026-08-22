import { decisionRun } from '../runtime/decision-pipeline';
import type { SpaceTaskStatus } from '@hyperneo/shared';

export const TERMINAL_TASK_STATUSES: readonly SpaceTaskStatus[] = [
  'done',
  'blocked',
  'cancelled',
  'archived',
];

export type ReportableTerminalDecision =
  | { action: 'none'; reason: 'not_terminal' | 'administrative' | 'no_outcome_change' }
  | { action: 'notify' }
  | { action: 'supersede_notify' };

export interface ReportableTerminalCtx {
  fromStatus: SpaceTaskStatus | null;
  toStatus: SpaceTaskStatus;
  hasStartGeneration: boolean;
  hasPriorTerminalGeneration: boolean;
  decision: ReportableTerminalDecision | null;
}

export type ReportableTerminalInput = Omit<ReportableTerminalCtx, 'decision'>;

function decided(
  ctx: ReportableTerminalCtx,
  decision: ReportableTerminalDecision
): ReportableTerminalCtx {
  return { ...ctx, decision };
}

function isTerminalStatus(status: SpaceTaskStatus | null): boolean {
  return status !== null && TERMINAL_TASK_STATUSES.includes(status);
}

export function applyNotTerminalGate(ctx: ReportableTerminalCtx): ReportableTerminalCtx {
  return isTerminalStatus(ctx.toStatus)
    ? ctx
    : decided(ctx, { action: 'none', reason: 'not_terminal' });
}

export function applyAdministrativeGate(ctx: ReportableTerminalCtx): ReportableTerminalCtx {
  return ctx.hasStartGeneration ? ctx : decided(ctx, { action: 'none', reason: 'administrative' });
}

export function applySameOutcomeGate(ctx: ReportableTerminalCtx): ReportableTerminalCtx {
  return ctx.fromStatus === ctx.toStatus
    ? decided(ctx, { action: 'none', reason: 'no_outcome_change' })
    : ctx;
}

export function applySupersedeGate(ctx: ReportableTerminalCtx): ReportableTerminalCtx {
  return ctx.hasPriorTerminalGeneration ? decided(ctx, { action: 'supersede_notify' }) : ctx;
}

export function applyNotifyGate(ctx: ReportableTerminalCtx): ReportableTerminalCtx {
  return decided(ctx, { action: 'notify' });
}

const reportableTerminalRun = decisionRun('reportable-terminal', [
  applyNotTerminalGate,
  applyAdministrativeGate,
  applySameOutcomeGate,
  applySupersedeGate,
  applyNotifyGate,
]);

export function decideReportableTerminal(
  input: ReportableTerminalInput
): ReportableTerminalDecision {
  const ctx = reportableTerminalRun(input);
  return ctx.decision ?? { action: 'none', reason: 'not_terminal' };
}
