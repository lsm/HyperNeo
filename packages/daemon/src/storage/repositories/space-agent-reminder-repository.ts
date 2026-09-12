import type {
  CreateSpaceLongHorizonAgentReminderParams,
  SpaceLongHorizonAgentReminder,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SpaceAgentRepository } from './space-agent-repository.ts';

export class SpaceAgentReminderRepository {
  constructor(
    private db: BunDatabase,
    private agents: Pick<SpaceAgentRepository, 'getById'>
  ) {}

  createReminder(params: CreateSpaceLongHorizonAgentReminderParams): SpaceLongHorizonAgentReminder {
    this.requireAgentInSpace(params.agentId, params.spaceId);
    const id = generateUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_long_horizon_agent_reminders (
           id, space_id, agent_id, title, body, status, trigger_type, run_at, cron_expression,
           timezone, next_run_at, last_fired_at, created_by_session, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.spaceId,
        params.agentId,
        params.title,
        params.body ?? '',
        params.status ?? 'active',
        params.triggerType,
        params.runAt ?? null,
        params.cronExpression ?? null,
        params.timezone ?? 'UTC',
        params.nextRunAt ?? null,
        params.lastFiredAt ?? null,
        params.createdBySession ?? null,
        now,
        now
      );
    return this.getReminder(id) as SpaceLongHorizonAgentReminder;
  }

  getReminder(id: string): SpaceLongHorizonAgentReminder | null {
    const row = this.db
      .prepare(`SELECT * FROM space_long_horizon_agent_reminders WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToReminder(row) : null;
  }

  countActiveRemindersByAgent(spaceId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT agent_id, COUNT(*) AS reminder_count
         FROM space_long_horizon_agent_reminders
         WHERE space_id = ? AND status = 'active'
         GROUP BY agent_id`
      )
      .all(spaceId) as { agent_id: string; reminder_count: number }[];
    return new Map(rows.map((row) => [row.agent_id, Number(row.reminder_count)]));
  }

  listReminders(agentId: string): SpaceLongHorizonAgentReminder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_long_horizon_agent_reminders WHERE agent_id = ? ORDER BY created_at ASC`
      )
      .all(agentId) as Record<string, unknown>[];
    return rows.map(rowToReminder);
  }

  listDueReminders(
    now: number,
    limit = 100,
    excludeIds: string[] = []
  ): SpaceLongHorizonAgentReminder[] {
    const excludeClause =
      excludeIds.length > 0 ? `AND r.id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
    const rows = this.db
      .prepare(
        `SELECT r.* FROM space_long_horizon_agent_reminders r
           INNER JOIN space_long_horizon_agents a ON a.id = r.agent_id
           INNER JOIN spaces s ON s.id = r.space_id
           WHERE r.status = 'active' AND r.next_run_at IS NOT NULL AND r.next_run_at <= ?
             AND a.status = 'active'
             AND s.status = 'active' AND s.paused = 0 AND s.stopped = 0
             ${excludeClause}
           ORDER BY r.next_run_at ASC
           LIMIT ?`
      )
      .all(now, ...excludeIds, limit) as Record<string, unknown>[];
    return rows.map(rowToReminder);
  }

  advanceReminderAfterFire(
    id: string,
    expectedNextRunAt: number,
    updates: {
      status: SpaceLongHorizonAgentReminder['status'];
      nextRunAt: number | null;
      lastFiredAt: number;
    }
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE space_long_horizon_agent_reminders
            SET status = ?, next_run_at = ?, last_fired_at = ?, updated_at = ?
            WHERE id = ? AND status = 'active' AND next_run_at = ?`
      )
      .run(
        updates.status,
        updates.nextRunAt,
        updates.lastFiredAt,
        Date.now(),
        id,
        expectedNextRunAt
      );
    return result.changes > 0;
  }

  listActiveRemindersWithNullNextRunAt(): SpaceLongHorizonAgentReminder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_long_horizon_agent_reminders
           WHERE status = 'active' AND next_run_at IS NULL`
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToReminder);
  }

  setReminderNextRunAt(id: string, nextRunAt: number): void {
    this.db
      .prepare(
        `UPDATE space_long_horizon_agent_reminders SET next_run_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(nextRunAt, Date.now(), id);
  }

  deleteReminder(id: string): void {
    this.db.prepare(`DELETE FROM space_long_horizon_agent_reminders WHERE id = ?`).run(id);
  }

  private requireAgentInSpace(agentId: string, spaceId: string): void {
    const agent = this.agents.getById(agentId);
    if (!agent) throw new Error(`Long-horizon agent not found: ${agentId}`);
    if (agent.spaceId !== spaceId) {
      throw new Error(`Long-horizon agent ${agentId} does not belong to space ${spaceId}`);
    }
  }
}

function rowToReminder(row: Record<string, unknown>): SpaceLongHorizonAgentReminder {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    agentId: row.agent_id as string,
    title: row.title as string,
    body: (row.body as string | null) ?? '',
    status: row.status as SpaceLongHorizonAgentReminder['status'],
    triggerType: row.trigger_type as SpaceLongHorizonAgentReminder['triggerType'],
    runAt: (row.run_at as number | null) ?? null,
    cronExpression: (row.cron_expression as string | null) ?? null,
    timezone: row.timezone as string,
    nextRunAt: (row.next_run_at as number | null) ?? null,
    lastFiredAt: (row.last_fired_at as number | null) ?? null,
    createdBySession: (row.created_by_session as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
