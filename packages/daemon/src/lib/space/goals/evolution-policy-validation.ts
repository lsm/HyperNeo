/**
 * Forge (Evolution) automation-policy validation.
 *
 * Shared by the RPC path (`evolution.scope.update` via its `beforeScopeUpdate`
 * hook) and the MCP path (`update_forge_scope`) so both entry points reject the
 * same invalid `automation.*` configuration — UI-editable fields like
 * `completedTaskThreshold` and `completedTaskAutomationEnabled`, plus the
 * self-nag cron/timezone. Extracted here (rather than living only in the RPC
 * layer) so the `space-agent-tools` MCP handler can validate identically
 * without importing the RPC layer.
 */

import type { EvolutionScope } from '@hyperneo/shared';
import { getNextRunAt, isValidCronExpression } from '../schedule/cron-utils';
import { readAutomationPolicyForScope } from './goal-automation-service';

export function validateCompletedTaskThreshold(policy: EvolutionScope['policy'] | undefined): void {
  const automation = policy?.automation;
  if (
    automation !== undefined &&
    (typeof automation !== 'object' || Array.isArray(automation) || automation === null)
  ) {
    throw new Error('Automation policy must be an object');
  }
  const threshold = automation?.completedTaskThreshold;
  if (threshold !== undefined && (!Number.isInteger(threshold) || threshold <= 0)) {
    throw new Error('Completed-task automation threshold must be a positive integer');
  }
}

export function validateGoalAutomationSelfNagPolicy(params: {
  policy?: EvolutionScope['policy'];
}): void {
  validateCompletedTaskThreshold(params.policy);
  const enabled = params.policy?.automation?.completedTaskAutomationEnabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error('completedTaskAutomationEnabled must be a boolean');
  }
  const policy = readAutomationPolicyForScope({
    policy: params.policy ?? {},
  } as EvolutionScope);
  const expression = policy.selfNagCronExpression;
  if (!expression) return;
  if (!isValidCronExpression(expression)) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }
  const timezone = policy.selfNagTimezone ?? 'UTC';
  if (getNextRunAt(expression, timezone) === null) {
    throw new Error(`Invalid timezone or cron expression for self-nag schedule: ${timezone}`);
  }
}
