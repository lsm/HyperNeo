import type { MessageHub } from '@hyperneo/shared';
import type { SpaceAgentReminderRepository } from '../../storage/repositories/space-agent-reminder-repository.ts';
import {
  prepareAgentReminderCreateInput,
  type AgentReminderCreateInput,
} from '../agents/reminder-create-input.ts';

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
    const params = prepareAgentReminderCreateInput(data as AgentReminderCreateInput);
    const reminder = deps.reminders.createReminder(params);
    return { reminder };
  });

  messageHub.onRequest(method('delete'), async (data) => {
    const params = data as { reminderId: string };
    if (!params.reminderId) throw new Error('reminderId is required');
    await deps.reminders.deleteReminderAsync(params.reminderId);
    return { success: true };
  });
}
