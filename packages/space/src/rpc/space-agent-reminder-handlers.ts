import type { MessageHub } from '@hyperneo/shared';
import type { SpaceAgentReminderRepository } from '../../../daemon/src/storage/repositories/space-agent-reminder-repository.ts';
import {
  prepareAgentReminderCreateInput,
  type AgentReminderCreateInput,
} from '../../../daemon/src/lib/agents/reminder-create-input.ts';

export interface SpaceAgentReminderDeps {
  reminders: SpaceAgentReminderRepository;
}

export function setupSpaceAgentReminderHandlers(
  messageHub: MessageHub,
  deps: SpaceAgentReminderDeps
): void {
  messageHub.onRequest('spaceAgentReminder.listCounts', async (data) => {
    const params = data as { agentIds: string[] };
    if (!Array.isArray(params.agentIds)) throw new Error('agentIds is required');
    const counts: Record<string, number> = {};
    for (const agentId of params.agentIds) {
      const reminders = deps.reminders.listReminders(agentId);
      counts[agentId] = reminders.filter((r) => r.status === 'active').length;
    }
    return { counts };
  });

  messageHub.onRequest('spaceAgentReminder.create', async (data) => {
    const params = prepareAgentReminderCreateInput(data as AgentReminderCreateInput);
    const reminder = deps.reminders.createReminder(params);
    return { reminder };
  });

  messageHub.onRequest('spaceAgentReminder.delete', async (data) => {
    const params = data as { reminderId: string };
    if (!params.reminderId) throw new Error('reminderId is required');
    await deps.reminders.deleteReminderAsync(params.reminderId);
    return { success: true };
  });
}
