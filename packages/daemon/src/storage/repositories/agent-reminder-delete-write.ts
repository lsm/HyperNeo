import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { SpaceAgentRepository } from './space-agent-repository.ts';
import { SpaceAgentReminderRepository } from './space-agent-reminder-repository.ts';

class AgentReminderDeleteWriter {
  constructor(
    private readonly db: Database,
    private readonly changes?: ReactiveDatabase
  ) {}

  delete(id: string): void {
    const reminders = new SpaceAgentReminderRepository(this.db, new SpaceAgentRepository(this.db));
    if (!reminders.getReminder(id)) throw new Error(`Reminder not found: ${id}`);
    reminders.deleteReminder(id);
    this.changes?.notifyChange('space_long_horizon_agent_reminders');
  }
}

export const agentReminderDeleteWrites = defineRepositoryOp(
  'agent.reminder.delete.write',
  'write',
  AgentReminderDeleteWriter,
  ['delete'] as const
);
