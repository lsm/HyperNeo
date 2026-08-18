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
  const rawAutomation = params.policy?.automation;
  if (rawAutomation && typeof rawAutomation === 'object' && !Array.isArray(rawAutomation)) {
    const record = rawAutomation as Record<string, unknown>;
    if (
      record.selfNagCronExpression !== undefined &&
      record.selfNagCronExpression !== null &&
      typeof record.selfNagCronExpression !== 'string'
    ) {
      throw new Error('selfNagCronExpression must be a string or null');
    }
    if (
      record.selfNagTimezone !== undefined &&
      record.selfNagTimezone !== null &&
      typeof record.selfNagTimezone !== 'string'
    ) {
      throw new Error('selfNagTimezone must be a string or null');
    }
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
