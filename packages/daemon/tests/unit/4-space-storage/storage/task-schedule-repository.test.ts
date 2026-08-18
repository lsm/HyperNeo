import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository';
import { createSpaceTables } from '../../helpers/space-test-db';
import type { CreateTaskScheduleParams } from '../../../../src/storage/repositories/task-schedule-repository';

function makeCronParams(
  overrides: Partial<CreateTaskScheduleParams> = {}
): CreateTaskScheduleParams {
  return {
    spaceId: 'space-1',
    title: 'Daily Standup',
    description: 'Create daily standup task',
    priority: 'normal',
    triggerType: 'cron',
    cronExpression: '0 9 * * 1-5',
    timezone: 'UTC',
    nextRunAt: Date.now() + 3600_000,
    ...overrides,
  };
}

function makeAtParams(overrides: Partial<CreateTaskScheduleParams> = {}): CreateTaskScheduleParams {
  return {
    spaceId: 'space-1',
    title: 'One-Shot Task',
    triggerType: 'at',
    runAt: Date.now() + 60_000,
    nextRunAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('TaskScheduleRepository', () => {
  let db: Database;
  let spaceRepo: SpaceRepository;
  let repo: TaskScheduleRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    spaceRepo = new SpaceRepository(db as never);
    repo = new TaskScheduleRepository(db as never);

    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/test',
      slug: 'test',
      name: 'Test Space',
    });
    spaceId = space.id;
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('creates a cron schedule with all fields populated', () => {
      const now = Date.now();
      const nextRunAt = now + 3600_000;

      const schedule = repo.create(makeCronParams({ spaceId, nextRunAt }));

      expect(schedule.id).toBeString();
      expect(schedule.spaceId).toBe(spaceId);
      expect(schedule.title).toBe('Daily Standup');
      expect(schedule.description).toBe('Create daily standup task');
      expect(schedule.priority).toBe('normal');
      expect(schedule.triggerType).toBe('cron');
      expect(schedule.cronExpression).toBe('0 9 * * 1-5');
      expect(schedule.runAt).toBeNull();
      expect(schedule.timezone).toBe('UTC');
      expect(schedule.nextRunAt).toBe(nextRunAt);
      expect(schedule.lastRunAt).toBeNull();
      expect(schedule.lastCreatedTaskId).toBeNull();
      expect(schedule.pendingJobId).toBeNull();
      expect(schedule.status).toBe('active');
      expect(schedule.createdByAgent).toBeNull();
      expect(schedule.createdBySession).toBeNull();
      expect(schedule.createdAt).toBeGreaterThan(0);
      expect(schedule.updatedAt).toBeGreaterThan(0);
    });

    it('creates a one-shot (at) schedule', () => {
      const runAt = Date.now() + 60_000;
      const schedule = repo.create(makeAtParams({ spaceId, runAt, nextRunAt: runAt }));

      expect(schedule.triggerType).toBe('at');
      expect(schedule.runAt).toBe(runAt);
      expect(schedule.cronExpression).toBeNull();
    });

    it('applies defaults for optional fields', () => {
      const schedule = repo.create({
        spaceId,
        title: 'Minimal',
        triggerType: 'cron',
      });

      expect(schedule.description).toBe('');
      expect(schedule.priority).toBe('normal');
      expect(schedule.labels).toEqual([]);
      expect(schedule.preferredWorkflowId).toBeNull();
      expect(schedule.timezone).toBe('UTC');
      expect(schedule.nextRunAt).toBeNull();
    });

    it('stores labels as a JSON array', () => {
      const schedule = repo.create(makeCronParams({ spaceId, labels: ['bug', 'recurring'] }));
      expect(schedule.labels).toEqual(['bug', 'recurring']);
    });

    it('stores metadata as a JSON object', () => {
      const schedule = repo.create(
        makeCronParams({
          spaceId,
          metadata: { goalAutomationScopeId: 'scope-1' },
        })
      );
      expect(schedule.metadata).toEqual({ goalAutomationScopeId: 'scope-1' });
    });

    it('stores createdByAgent and createdBySession', () => {
      const schedule = repo.create(
        makeCronParams({ spaceId, createdByAgent: 'agent-1', createdBySession: 'session-1' })
      );
      expect(schedule.createdByAgent).toBe('agent-1');
      expect(schedule.createdBySession).toBe('session-1');
    });
  });

  describe('getById', () => {
    it('returns the schedule by ID', () => {
      const created = repo.create(makeCronParams({ spaceId }));
      const found = repo.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null for an unknown ID', () => {
      expect(repo.getById('no-such-id')).toBeNull();
    });
  });

  describe('listBySpace', () => {
    it('lists all schedules for a space', () => {
      repo.create(makeCronParams({ spaceId, title: 'A' }));
      repo.create(makeCronParams({ spaceId, title: 'B' }));

      const list = repo.listBySpace(spaceId);
      expect(list.length).toBe(2);
    });

    it('filters by status', () => {
      const s1 = repo.create(makeCronParams({ spaceId }));
      repo.updateStatus(s1.id, 'paused');
      repo.create(makeCronParams({ spaceId, title: 'Active' }));

      const active = repo.listBySpace(spaceId, 'active');
      expect(active.length).toBe(1);
      expect(active[0].status).toBe('active');

      const paused = repo.listBySpace(spaceId, 'paused');
      expect(paused.length).toBe(1);
      expect(paused[0].status).toBe('paused');
    });

    it('returns empty array for a space with no schedules', () => {
      expect(repo.listBySpace('unknown-space')).toEqual([]);
    });

    it('does not return schedules from another space', () => {
      const otherSpace = spaceRepo.createSpace({
        workspacePath: '/workspace/other',
        slug: 'other',
        name: 'Other',
      });
      repo.create(makeCronParams({ spaceId: otherSpace.id }));

      expect(repo.listBySpace(spaceId)).toEqual([]);
    });
  });

  describe('listActiveDue', () => {
    it('returns schedules whose nextRunAt is in the past or now', () => {
      const now = Date.now();
      const s1 = repo.create(makeCronParams({ spaceId, nextRunAt: now - 1000 }));
      const s2 = repo.create(makeCronParams({ spaceId, nextRunAt: now - 1 }));
      repo.create(makeCronParams({ spaceId, nextRunAt: now + 60_000 }));

      const due = repo.listActiveDue(now);
      const ids = due.map((s) => s.id);
      expect(ids).toContain(s1.id);
      expect(ids).toContain(s2.id);
      expect(due.length).toBe(2);
    });

    it('excludes paused and completed schedules', () => {
      const now = Date.now();
      const s1 = repo.create(makeCronParams({ spaceId, nextRunAt: now - 1 }));
      repo.updateStatus(s1.id, 'paused');

      expect(repo.listActiveDue(now)).toHaveLength(0);
    });

    it('respects the limit parameter', () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        repo.create(makeCronParams({ spaceId, nextRunAt: now - 1000 }));
      }
      expect(repo.listActiveDue(now, 3)).toHaveLength(3);
    });

    it('excludes schedules that already have a pendingJobId linked', () => {
      const now = Date.now();
      const s1 = repo.create(makeCronParams({ spaceId, nextRunAt: now - 1000 }));
      const s2 = repo.create(makeCronParams({ spaceId, nextRunAt: now - 500 }));
      repo.updatePendingJobId(s1.id, 'job-already-linked');

      const due = repo.listActiveDue(now);
      expect(due.map((s) => s.id)).toEqual([s2.id]);
    });
  });

  describe('listActiveWithPendingJob', () => {
    it('returns active schedules that have a pendingJobId set', () => {
      const s1 = repo.create(makeCronParams({ spaceId }));
      repo.updatePendingJobId(s1.id, 'job-abc');
      repo.create(makeCronParams({ spaceId }));

      const withJob = repo.listActiveWithPendingJob();
      expect(withJob.length).toBe(1);
      expect(withJob[0].id).toBe(s1.id);
      expect(withJob[0].pendingJobId).toBe('job-abc');
    });

    it('excludes paused schedules even if they have a pendingJobId', () => {
      const s1 = repo.create(makeCronParams({ spaceId }));
      repo.updatePendingJobId(s1.id, 'job-xyz');
      repo.updateStatus(s1.id, 'paused');

      expect(repo.listActiveWithPendingJob()).toHaveLength(0);
    });
  });

  describe('listActiveBySpace', () => {
    it('returns only active schedules for the given space', () => {
      const s1 = repo.create(makeCronParams({ spaceId }));
      const s2 = repo.create(makeCronParams({ spaceId }));
      const paused = repo.create(makeCronParams({ spaceId }));
      repo.updateStatus(paused.id, 'paused');

      const otherSpace = spaceRepo.createSpace({
        workspacePath: '/workspace/other',
        slug: 'other',
        name: 'Other',
      });
      repo.create(makeCronParams({ spaceId: otherSpace.id }));

      const active = repo.listActiveBySpace(spaceId);
      const ids = active.map((s) => s.id).sort();
      expect(ids).toEqual([s1.id, s2.id].sort());
    });
  });

  describe('update', () => {
    it('updates title and description', () => {
      const s = repo.create(makeCronParams({ spaceId }));
      const updated = repo.update(s.id, { title: 'New Title', description: 'New desc' });

      expect(updated!.title).toBe('New Title');
      expect(updated!.description).toBe('New desc');
    });

    it('updates nextRunAt to null', () => {
      const s = repo.create(makeCronParams({ spaceId, nextRunAt: Date.now() + 3600_000 }));
      const updated = repo.update(s.id, { nextRunAt: null });
      expect(updated!.nextRunAt).toBeNull();
    });

    it('returns null for unknown ID', () => {
      expect(repo.update('no-such-id', { title: 'X' })).toBeNull();
    });

    it('returns the schedule unchanged when no fields are provided', () => {
      const s = repo.create(makeCronParams({ spaceId }));
      const result = repo.update(s.id, {});
      expect(result!.title).toBe(s.title);
    });
  });

  describe('updatePendingJobId', () => {
    it('sets a pendingJobId', () => {
      const s = repo.create(makeCronParams({ spaceId }));
      repo.updatePendingJobId(s.id, 'job-1');
      expect(repo.getById(s.id)!.pendingJobId).toBe('job-1');
    });

    it('clears the pendingJobId to null', () => {
      const s = repo.create(makeCronParams({ spaceId }));
      repo.updatePendingJobId(s.id, 'job-1');
      repo.updatePendingJobId(s.id, null);
      expect(repo.getById(s.id)!.pendingJobId).toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('transitions active → paused', () => {
      const s = repo.create(makeCronParams({ spaceId }));
      repo.updateStatus(s.id, 'paused');
      expect(repo.getById(s.id)!.status).toBe('paused');
    });

    it('transitions paused → active', () => {
      const s = repo.create(makeCronParams({ spaceId }));
      repo.updateStatus(s.id, 'paused');
      repo.updateStatus(s.id, 'active');
      expect(repo.getById(s.id)!.status).toBe('active');
    });

    it('transitions active → completed', () => {
      const s = repo.create(makeCronParams({ spaceId }));
      repo.updateStatus(s.id, 'completed');
      expect(repo.getById(s.id)!.status).toBe('completed');
    });
  });

  describe('updateAfterFire', () => {
    it('records fire state for a cron schedule (stays active)', () => {
      const s = repo.create(makeCronParams({ spaceId }));
      const nextRunAt = Date.now() + 3600_000;

      repo.updateAfterFire(s.id, {
        lastCreatedTaskId: 'task-abc',
        lastRunAt: Date.now(),
        nextRunAt,
        status: 'active',
        pendingJobId: 'job-next',
      });

      const updated = repo.getById(s.id)!;
      expect(updated.lastCreatedTaskId).toBe('task-abc');
      expect(updated.lastRunAt).toBeGreaterThan(0);
      expect(updated.nextRunAt).toBe(nextRunAt);
      expect(updated.status).toBe('active');
      expect(updated.pendingJobId).toBe('job-next');
    });

    it('records fire state for a one-shot schedule (marks completed)', () => {
      const s = repo.create(makeAtParams({ spaceId }));

      repo.updateAfterFire(s.id, {
        lastCreatedTaskId: 'task-xyz',
        lastRunAt: Date.now(),
        nextRunAt: null,
        status: 'completed',
        pendingJobId: null,
      });

      const updated = repo.getById(s.id)!;
      expect(updated.status).toBe('completed');
      expect(updated.nextRunAt).toBeNull();
      expect(updated.pendingJobId).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes an existing schedule and returns true', () => {
      const s = repo.create(makeCronParams({ spaceId }));
      expect(repo.delete(s.id)).toBe(true);
      expect(repo.getById(s.id)).toBeNull();
    });

    it('returns false for an unknown ID', () => {
      expect(repo.delete('no-such-id')).toBe(false);
    });
  });
});
