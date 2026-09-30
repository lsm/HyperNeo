import type { SpaceTaskStatus } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export const TERMINAL_TASK_STATUSES: readonly SpaceTaskStatus[] = [
  'done',
  'blocked',
  'cancelled',
  'archived',
];

export const REPORTABLE_TERMINAL_PREDICATE_VERSION = 1;

export type ReportableTerminalNoneReason = 'not_terminal' | 'administrative' | 'no_outcome_change';

export type ReportableTerminalDecision =
  | { action: 'none'; reason: ReportableTerminalNoneReason }
  | { action: 'notify'; predicateVersion: number }
  | { action: 'supersede_notify'; predicateVersion: number };

export interface ReportableTerminalInput {
  fromStatus: SpaceTaskStatus | null;
  toStatus: SpaceTaskStatus;
  hasStartGeneration: boolean;
  hasPriorTerminalGeneration: boolean;
}

export function isTerminalStatus(status: SpaceTaskStatus | null): boolean {
  return status !== null && TERMINAL_TASK_STATUSES.includes(status);
}

export function isAdministrativeTransition(input: ReportableTerminalInput): boolean {
  if (!input.hasStartGeneration) return true;
  return input.toStatus === 'archived' && isTerminalStatus(input.fromStatus);
}

export function classifyReportableTerminal(
  input: ReportableTerminalInput
): ReportableTerminalDecision {
  if (!isTerminalStatus(input.toStatus)) return { action: 'none', reason: 'not_terminal' };
  if (isAdministrativeTransition(input)) return { action: 'none', reason: 'administrative' };
  if (input.fromStatus === input.toStatus) return { action: 'none', reason: 'no_outcome_change' };
  if (input.hasPriorTerminalGeneration && isTerminalStatus(input.fromStatus)) {
    return {
      action: 'supersede_notify',
      predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION,
    };
  }
  return { action: 'notify', predicateVersion: REPORTABLE_TERMINAL_PREDICATE_VERSION };
}

export const decideReportableTerminal = (superpipe({})('reportable-terminal') as PipelineAPI)
  .input(['input'])
  .pipe(classifyReportableTerminal, 'input', 'decision')
  .end('decision') as (input: ReportableTerminalInput) => ReportableTerminalDecision;
