import type { CreateSpaceLongHorizonAgentReminderParams } from '@hyperneo/shared';
import { getNextRunAt, isValidCronExpression } from '../schedule/cron-utils.ts';

export interface AgentReminderCreateInput {
  spaceId: string;
  agentId: string;
  title: string;
  body?: string;
  triggerType: 'at' | 'cron';
  runAt?: number | null;
  cronExpression?: string | null;
  timezone?: string;
}

export function prepareAgentReminderCreateInput(
  params: AgentReminderCreateInput
): CreateSpaceLongHorizonAgentReminderParams {
  if (!params.spaceId) throw new Error('spaceId is required');
  if (!params.agentId) throw new Error('agentId is required');
  if (!params.title) throw new Error('title is required');
  if (!params.triggerType) throw new Error('triggerType is required');
  let nextRunAt: number | null = null;
  if (params.triggerType === 'at') {
    if (typeof params.runAt !== 'number') {
      throw new Error('runAt is required for triggerType "at"');
    }
    nextRunAt = params.runAt;
  } else {
    const expression = params.cronExpression;
    if (!expression) throw new Error('cronExpression is required for triggerType "cron"');
    if (!isValidCronExpression(expression)) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }
    const timezone = params.timezone ?? 'UTC';
    const firstRunAt = getNextRunAt(expression, timezone);
    if (firstRunAt === null) {
      throw new Error(`Invalid timezone or cron expression for reminder: ${timezone}`);
    }
    nextRunAt = firstRunAt;
  }
  return {
    spaceId: params.spaceId,
    agentId: params.agentId,
    title: params.title,
    body: params.body,
    triggerType: params.triggerType,
    runAt: params.runAt,
    cronExpression: params.cronExpression,
    timezone: params.timezone,
    nextRunAt,
  };
}
