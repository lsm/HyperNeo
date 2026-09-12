import { beforeEach, describe, expect, test } from 'bun:test';
import type { CreateSpaceLongHorizonAgentReminderParams } from '@hyperneo/shared';
import { SpaceAgentReminderRepository } from '../../../src/storage/repositories/space-agent-reminder-repository';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { Database as BunDatabase } from '../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../helpers/space-test-db';

function seedSpace(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, id, Date.now(), Date.now());
}

function reminderParams(
  overrides: Partial<CreateSpaceLongHorizonAgentReminderParams> = {}
): CreateSpaceLongHorizonAgentReminderParams {
  return {
    spaceId: 'space-1',
    agentId: 'agent-1',
    title: 'Check the PR',
    triggerType: 'cron',
    ...overrides,
  };
}

describe('SpaceAgentReminderRepository', () => {
  let db: BunDatabase;
  let agents: SpaceAgentRepository;
  let repo: SpaceAgentReminderRepository;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    seedSpace(db, 'space-1');
    seedSpace(db, 'space-2');
    agents = new SpaceAgentRepository(db);
    repo = new SpaceAgentReminderRepository(db, agents);
    db.prepare(
      `INSERT INTO space_long_horizon_agents
         (id, space_id, handle, display_name, status, autonomy_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 2, ?, ?)`
    ).run('agent-1', 'space-1', 'researcher', 'Researcher', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO space_long_horizon_agents
         (id, space_id, handle, display_name, status, autonomy_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 2, ?, ?)`
    ).run('agent-2', 'space-2', 'reviewer', 'Reviewer', Date.now(), Date.now());
  });

  describe('createReminder', () => {
    test('round-trips every field', () => {
      const created = repo.createReminder(
        reminderParams({
          body: 'Is it merged yet?',
          status: 'paused',
          cronExpression: '*/15 * * * *',
          timezone: 'Europe/Berlin',
          nextRunAt: 1000,
          lastFiredAt: 900,
          createdBySession: 'session-9',
        })
      );

      expect(created.spaceId).toBe('space-1');
      expect(created.agentId).toBe('agent-1');
      expect(created.title).toBe('Check the PR');
      expect(created.body).toBe('Is it merged yet?');
      expect(created.status).toBe('paused');
      expect(created.triggerType).toBe('cron');
      expect(created.cronExpression).toBe('*/15 * * * *');
      expect(created.timezone).toBe('Europe/Berlin');
      expect(created.nextRunAt).toBe(1000);
      expect(created.lastFiredAt).toBe(900);
      expect(created.createdBySession).toBe('session-9');
      expect(repo.getReminder(created.id)).toEqual(created);
    });

    test('applies defaults for omitted fields', () => {
      const created = repo.createReminder(reminderParams());

      expect(created.body).toBe('');
      expect(created.status).toBe('active');
      expect(created.timezone).toBe('UTC');
      expect(created.runAt).toBeNull();
      expect(created.nextRunAt).toBeNull();
      expect(created.createdBySession).toBeNull();
    });

    test('rejects an unknown agent', () => {
      expect(() => repo.createReminder(reminderParams({ agentId: 'missing' }))).toThrow(
        'Long-horizon agent not found: missing'
      );
    });

    test('rejects an agent that belongs to a different space', () => {
      expect(() => repo.createReminder(reminderParams({ agentId: 'agent-2' }))).toThrow(
        'Long-horizon agent agent-2 does not belong to space space-1'
      );
    });
  });

  test('getReminder returns null for an unknown id', () => {
    expect(repo.getReminder('nope')).toBeNull();
  });

  test('listReminders is scoped to one agent', () => {
    const first = repo.createReminder(reminderParams({ title: 'first' }));
    const second = repo.createReminder(reminderParams({ title: 'second' }));
    repo.createReminder(reminderParams({ spaceId: 'space-2', agentId: 'agent-2' }));

    expect(repo.listReminders('agent-1').map((r) => r.id)).toEqual([first.id, second.id]);
  });

  test('countActiveRemindersByAgent counts only active rows in the space', () => {
    repo.createReminder(reminderParams());
    repo.createReminder(reminderParams());
    repo.createReminder(reminderParams({ status: 'cancelled' }));
    repo.createReminder(reminderParams({ spaceId: 'space-2', agentId: 'agent-2' }));

    const counts = repo.countActiveRemindersByAgent('space-1');

    expect(counts.get('agent-1')).toBe(2);
    expect(counts.has('agent-2')).toBe(false);
  });

  describe('listDueReminders', () => {
    test('returns only active rows that are due, oldest first', () => {
      const later = repo.createReminder(reminderParams({ nextRunAt: 500 }));
      const sooner = repo.createReminder(reminderParams({ nextRunAt: 100 }));
      repo.createReminder(reminderParams({ nextRunAt: 5000 }));
      repo.createReminder(reminderParams({ nextRunAt: 100, status: 'paused' }));
      repo.createReminder(reminderParams({ nextRunAt: null }));

      expect(repo.listDueReminders(1000).map((r) => r.id)).toEqual([sooner.id, later.id]);
    });

    test('honours excludeIds and limit', () => {
      const first = repo.createReminder(reminderParams({ nextRunAt: 100 }));
      const second = repo.createReminder(reminderParams({ nextRunAt: 200 }));

      expect(repo.listDueReminders(1000, 100, [first.id]).map((r) => r.id)).toEqual([second.id]);
      expect(repo.listDueReminders(1000, 1).map((r) => r.id)).toEqual([first.id]);
    });

    test('skips reminders whose agent is not active', () => {
      repo.createReminder(reminderParams({ nextRunAt: 100 }));
      db.prepare(`UPDATE space_long_horizon_agents SET status = 'archived' WHERE id = ?`).run(
        'agent-1'
      );

      expect(repo.listDueReminders(1000)).toEqual([]);
    });
  });

  describe('advanceReminderAfterFire', () => {
    test('applies the update when next_run_at still matches', () => {
      const reminder = repo.createReminder(reminderParams({ nextRunAt: 100 }));

      const applied = repo.advanceReminderAfterFire(reminder.id, 100, {
        status: 'active',
        nextRunAt: 200,
        lastFiredAt: 150,
      });

      expect(applied).toBe(true);
      const reloaded = repo.getReminder(reminder.id);
      expect(reloaded?.nextRunAt).toBe(200);
      expect(reloaded?.lastFiredAt).toBe(150);
    });

    test('refuses the update when next_run_at has moved', () => {
      const reminder = repo.createReminder(reminderParams({ nextRunAt: 100 }));

      const applied = repo.advanceReminderAfterFire(reminder.id, 999, {
        status: 'fired',
        nextRunAt: null,
        lastFiredAt: 150,
      });

      expect(applied).toBe(false);
      expect(repo.getReminder(reminder.id)?.nextRunAt).toBe(100);
    });
  });

  test('listActiveRemindersWithNullNextRunAt finds unscheduled active rows', () => {
    const unscheduled = repo.createReminder(reminderParams({ nextRunAt: null }));
    repo.createReminder(reminderParams({ nextRunAt: 100 }));
    repo.createReminder(reminderParams({ nextRunAt: null, status: 'cancelled' }));

    expect(repo.listActiveRemindersWithNullNextRunAt().map((r) => r.id)).toEqual([unscheduled.id]);
  });

  test('setReminderNextRunAt reschedules a row', () => {
    const reminder = repo.createReminder(reminderParams({ nextRunAt: null }));

    repo.setReminderNextRunAt(reminder.id, 4242);

    expect(repo.getReminder(reminder.id)?.nextRunAt).toBe(4242);
  });

  test('deleteReminder removes the row', () => {
    const reminder = repo.createReminder(reminderParams());

    repo.deleteReminder(reminder.id);

    expect(repo.getReminder(reminder.id)).toBeNull();
  });
});
