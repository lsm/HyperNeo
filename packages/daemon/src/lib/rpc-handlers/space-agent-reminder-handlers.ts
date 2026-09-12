import type { MessageHub } from '@hyperneo/shared';
import type { SpaceAgentReminderRepository } from '../../storage/repositories/space-agent-reminder-repository.ts';
import { getNextRunAt, isValidCronExpression } from '../space/schedule/cron-utils.ts';

const METHOD_PREFIX = 'spaceAgentReminder';

export interface SpaceAgentReminderDeps {
  reminders: SpaceAgentReminderRepository;
}

export function setupSpaceAgentReminderHandlers(
  messageHub: MessageHub,
  deps: SpaceAgentReminderDeps
): void {
  const method = (name: string): string => `${METHOD_PREFIX}.${name}`;

  messageHub.onRequest(method('listCounts'), async (data) => {
    const params = data as { agentIds: string[] };
    if (!Array.isArray(params.agentIds)) throw new Error('agentIds is required');
    const counts: Record<string, number> = {};
    for (const agentId of params.agentIds) {
      const reminders = deps.reminders.listReminders(agentId);
      counts[agentId] = reminders.filter((r) => r.status === 'active').length;
    }
    return { counts };
  });

  messageHub.onRequest(method('create'), async (data) => {
    const params = data as {
      spaceId: string;
      agentId: string;
      title: string;
      body?: string;
      triggerType: 'at' | 'cron';
      runAt?: number | null;
      cronExpression?: string | null;
      timezone?: string;
    };
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
    const reminder = deps.reminders.createReminder({
      spaceId: params.spaceId,
      agentId: params.agentId,
      title: params.title,
      body: params.body,
      triggerType: params.triggerType,
      runAt: params.runAt,
      cronExpression: params.cronExpression,
      timezone: params.timezone,
      nextRunAt,
    });
    return { reminder };
  });

  messageHub.onRequest(method('delete'), async (data) => {
    const params = data as { reminderId: string };
    if (!params.reminderId) throw new Error('reminderId is required');
    const existing = deps.reminders.getReminder(params.reminderId);
    if (!existing) throw new Error(`Reminder not found: ${params.reminderId}`);
    deps.reminders.deleteReminder(params.reminderId);
    return { success: true };
  });
}
