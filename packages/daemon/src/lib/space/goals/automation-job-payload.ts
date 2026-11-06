import type { GoalAutomationExecutePayload } from '../job-handlers/goal-automation-execute.handler.ts';

export function uniqueJobMatchPayload(
  payload: GoalAutomationExecutePayload
): Record<string, unknown> {
  const matchPayload: Record<string, unknown> = {
    goalId: payload.goalId,
    scopeId: payload.scopeId,
    triggerKind: payload.triggerKind,
    triggerKey: payload.triggerKey,
  };
  if (payload.externalEventId !== undefined) {
    matchPayload.externalEventId = payload.externalEventId;
  }
  return matchPayload;
}
