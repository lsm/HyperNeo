import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { TaskScheduleRepository } from '../../../src/storage/repositories/task-schedule-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { ScheduleService } from '../../../src/lib/space/schedule/schedule-service';
import { createSpaceTables } from '../helpers/space-test-db';

describe('ScheduleService', () => {
  let db: Database;
  let scheduleRepo: TaskScheduleRepository;
  let jobQueue: JobQueueRepository;
  let spaceRepo: SpaceRepository;
  let service: ScheduleService;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    db.exec(`
			CREATE TABLE IF NOT EXISTS job_queue (
				id TEXT PRIMARY KEY,
				queue TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
				payload TEXT NOT NULL DEFAULT '{}',
				result TEXT,
				error TEXT,
				priority INTEGER NOT NULL DEFAULT 0,
				max_retries INTEGER NOT NULL DEFAULT 3,
				retry_count INTEGER NOT NULL DEFAULT 0,
				run_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				heartbeat_at INTEGER,
				completed_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
		`);

    spaceRepo = new SpaceRepository(db as never);
    scheduleRepo = new TaskScheduleRepository(db as never);
    jobQueue = new JobQueueRepository(db as never);
    service = new ScheduleService({ db: db as never, scheduleRepo, jobQueue, spaceRepo });

    const space = spaceRepo.createSpace({
      slug: 'test',
      workspacePath: '/workspace/test',
      name: 'Test',
      description: 'Test space',
    });
    spaceId = space.id;
  });

  afterEach(() => {
    db.close();
  });

  describe('createSchedule', () => {
    it('atomically creates the schedule, enqueues the first fire job, and links pendingJobId', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Daily Standup',
        triggerType: 'cron',
        cronExpression: '0 9 * * 1-5',
        timezone: 'UTC',
      });

      expect(schedule.status).toBe('active');
      expect(schedule.goalId).toBeNull();
      expect(schedule.nextRunAt).not.toBeNull();
      expect(schedule.pendingJobId).not.toBeNull();

      const job = jobQueue.getJob(schedule.pendingJobId as string);
      expect(job).not.toBeNull();
      expect(job?.queue).toBe('taskSchedule.fire');
      expect((job?.payload as { scheduleId: string }).scheduleId).toBe(schedule.id);
    });

    it('ignores hidden goalId fields on public schedule creation', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Public schedule',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
        goalId: 'goal-1',
      } as Parameters<ScheduleService['createSchedule']>[0] & { goalId: string });

      expect(schedule.goalId).toBeNull();
    });

    it('links goals only through the internal goal schedule path', () => {
      const schedule = service.createGoalSchedule({
        spaceId,
        title: 'Goal schedule',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
        goalId: 'goal-1',
      });

      expect(schedule.goalId).toBe('goal-1');
    });

    it('rejects an invalid cron expression', () => {
      expect(() =>
        service.createSchedule({
          spaceId,
          title: 'Bad cron',
          triggerType: 'cron',
          cronExpression: 'not-a-cron',
        })
      ).toThrow(/Invalid cron expression/);
    });

    it('rejects an `at` schedule without a runAt', () => {
      expect(() =>
        service.createSchedule({ spaceId, title: 'No runAt', triggerType: 'at' })
      ).toThrow(/runAt is required/);
    });

    it('rejects an `at` schedule whose runAt is in the past', () => {
      expect(() =>
        service.createSchedule({
          spaceId,
          title: 'Past',
          triggerType: 'at',
          runAt: Date.now() - 60_000,
        })
      ).toThrow(/runAt must be in the future/);
    });

    it('rejects an unsupported triggerType', () => {
      expect(() =>
        service.createSchedule({
          spaceId,
          title: 'Bad trigger',
          // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing TS to simulate
          triggerType: 'webhook' as any,
        })
      ).toThrow(/Unsupported triggerType/);
    });

    it('rejects creation in an archived space', () => {
      spaceRepo.archiveSpace(spaceId);
      expect(() =>
        service.createSchedule({
          spaceId,
          title: 'Archived',
          triggerType: 'cron',
          cronExpression: '0 9 * * *',
        })
      ).toThrow(/non-active space/);
    });
  });

  describe('updateSchedule', () => {
    it('rejects clearing the title to empty/whitespace', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });

      expect(() => service.updateSchedule(schedule.id, { title: '' })).toThrow(
        /title must be a non-empty string/
      );
      expect(() => service.updateSchedule(schedule.id, { title: '   ' })).toThrow(
        /title must be a non-empty string/
      );

      const after = scheduleRepo.getById(schedule.id);
      expect(after?.title).toBe('Cron');
    });

    it('rejects setting cronExpression to null on a cron schedule', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });

      expect(() => service.updateSchedule(schedule.id, { cronExpression: null })).toThrow(
        /Cannot clear cronExpression/
      );
    });

    it('cancels the previous pending job and enqueues a new one when timing changes', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      const oldJobId = schedule.pendingJobId as string;

      const updated = service.updateSchedule(schedule.id, { cronExpression: '0 10 * * *' });

      expect(updated.pendingJobId).not.toBeNull();
      expect(updated.pendingJobId).not.toBe(oldJobId);
      expect(jobQueue.getJob(oldJobId)).toBeNull();
    });

    it('does not touch the pending job when only descriptive fields change', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      const oldJobId = schedule.pendingJobId;

      const updated = service.updateSchedule(schedule.id, { title: 'Renamed' });

      expect(updated.title).toBe('Renamed');
      expect(updated.pendingJobId).toBe(oldJobId);
    });

    it('does not clear trigger fields when updating unrelated metadata', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
        preferredWorkflowId: 'wf-1',
      });

      const updated = service.updateSchedule(schedule.id, { title: 'Renamed' });

      expect(updated.title).toBe('Renamed');
      expect(updated.cronExpression).toBe('0 9 * * *');
      expect(updated.preferredWorkflowId).toBe('wf-1');
    });

    it('rejects timing edits whose merged trigger config produces no nextRunAt', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
      });
      const oldJobId = schedule.pendingJobId as string;

      expect(() => service.updateSchedule(schedule.id, { timezone: 'Not/A_Real_Zone' })).toThrow(
        /Could not compute next run/
      );

      const after = scheduleRepo.getById(schedule.id);
      expect(after?.pendingJobId).toBe(oldJobId);
      expect(after?.timezone).toBe('UTC');
      expect(jobQueue.getJob(oldJobId)).not.toBeNull();
    });

    it('rejects invalid timezone edits even when the schedule is paused', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
      });
      service.pauseSchedule(schedule.id);

      expect(() => service.updateSchedule(schedule.id, { timezone: 'Not/A_Real_Zone' })).toThrow(
        /Could not compute next run/
      );

      const after = scheduleRepo.getById(schedule.id);
      expect(after?.timezone).toBe('UTC');
      expect(after?.status).toBe('paused');
    });

    it('rolls back the old pending job linkage if enqueue throws mid-update', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      const oldJobId = schedule.pendingJobId as string;

      const breakingService = new ScheduleService({
        db: db as never,
        scheduleRepo,
        jobQueue: {
          ...jobQueue,
          enqueue: () => {
            throw new Error('synthetic enqueue failure');
          },
          deleteJob: jobQueue.deleteJob.bind(jobQueue),
          getJob: jobQueue.getJob.bind(jobQueue),
        } as unknown as typeof jobQueue,
      });

      expect(() =>
        breakingService.updateSchedule(schedule.id, { cronExpression: '0 10 * * *' })
      ).toThrow('synthetic enqueue failure');

      const after = scheduleRepo.getById(schedule.id);
      expect(after?.status).toBe('active');
      expect(after?.pendingJobId).toBe(oldJobId);
      expect(jobQueue.getJob(oldJobId)).not.toBeNull();
      expect(after?.cronExpression).toBe('0 9 * * *');
    });
  });

  describe('pause/resume/delete', () => {
    it('pause cancels the pending job and clears pendingJobId', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      const jobId = schedule.pendingJobId as string;

      const paused = service.pauseSchedule(schedule.id);

      expect(paused.status).toBe('paused');
      expect(paused.pendingJobId).toBeNull();
      expect(jobQueue.getJob(jobId)).toBeNull();
    });

    it('pause CAS tolerates a concurrent fire that advanced pendingJobId', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      const originalJobId = schedule.pendingJobId as string;

      const newJob = jobQueue.enqueue({
        queue: 'taskSchedule.fire',
        payload: { scheduleId: schedule.id },
        runAt: Date.now() + 3600_000,
      });
      scheduleRepo.updatePendingJobId(schedule.id, newJob.id);

      const staleRepo = new Proxy(scheduleRepo, {
        get(target, prop, recv) {
          if (prop === 'getById') {
            return (id: string) => {
              const fresh = target.getById(id);
              if (!fresh) return fresh;
              return { ...fresh, pendingJobId: originalJobId };
            };
          }
          return Reflect.get(target, prop, recv);
        },
      }) as typeof scheduleRepo;

      const casService = new ScheduleService({
        db: db as never,
        scheduleRepo: staleRepo,
        jobQueue,
        spaceRepo,
      });

      const result = casService.pauseSchedule(schedule.id);
      const dbState = scheduleRepo.getById(schedule.id);
      expect(dbState?.status).toBe('active');
      expect(dbState?.pendingJobId).toBe(newJob.id);
      expect(jobQueue.getJob(newJob.id)).not.toBeNull();
    });

    it('resume re-enqueues a fresh fire job', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      service.pauseSchedule(schedule.id);

      const resumed = service.resumeSchedule(schedule.id);

      expect(resumed.status).toBe('active');
      expect(resumed.pendingJobId).not.toBeNull();
      expect(jobQueue.getJob(resumed.pendingJobId as string)).not.toBeNull();
    });

    it('resume of an already-passed `at` schedule transitions to completed (no job)', () => {
      const future = Date.now() + 60_000;
      const schedule = service.createSchedule({
        spaceId,
        title: 'One Shot',
        triggerType: 'at',
        runAt: future,
      });
      service.pauseSchedule(schedule.id);

      scheduleRepo.update(schedule.id, { runAt: Date.now() - 60_000 });

      const resumed = service.resumeSchedule(schedule.id);
      expect(resumed.status).toBe('completed');
      expect(resumed.pendingJobId).toBeNull();
    });

    it('resume of a cron schedule with an unrecoverable timezone throws (preserves paused)', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      service.pauseSchedule(schedule.id);

      scheduleRepo.update(schedule.id, { timezone: 'Not/A_Real_Zone' });

      expect(() => service.resumeSchedule(schedule.id)).toThrow(/Cannot resume cron schedule/);
      const after = scheduleRepo.getById(schedule.id);
      expect(after?.status).toBe('paused');
      expect(after?.pendingJobId).toBeNull();
    });

    it('delete cancels the pending job and removes the schedule row', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      const jobId = schedule.pendingJobId as string;

      const ok = service.deleteSchedule(schedule.id);

      expect(ok).toBe(true);
      expect(scheduleRepo.getById(schedule.id)).toBeNull();
      expect(jobQueue.getJob(jobId)).toBeNull();
    });

    it('delete CAS tolerates a concurrent fire that advanced pendingJobId', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      const originalJobId = schedule.pendingJobId as string;

      const newJob = jobQueue.enqueue({
        queue: 'taskSchedule.fire',
        payload: { scheduleId: schedule.id },
        runAt: Date.now() + 3600_000,
      });
      scheduleRepo.updatePendingJobId(schedule.id, newJob.id);

      const staleRepo = new Proxy(scheduleRepo, {
        get(target, prop, recv) {
          if (prop === 'getById') {
            return (id: string) => {
              const fresh = target.getById(id);
              if (!fresh) return fresh;
              return { ...fresh, pendingJobId: originalJobId };
            };
          }
          return Reflect.get(target, prop, recv);
        },
      }) as typeof scheduleRepo;

      const casService = new ScheduleService({
        db: db as never,
        scheduleRepo: staleRepo,
        jobQueue,
        spaceRepo,
      });

      const ok = casService.deleteSchedule(schedule.id);
      expect(ok).toBe(false);

      const after = scheduleRepo.getById(schedule.id);
      expect(after).not.toBeNull();
      expect(after?.pendingJobId).toBe(newJob.id);
      expect(jobQueue.getJob(newJob.id)).not.toBeNull();
      expect(jobQueue.getJob(originalJobId)).toBeNull();
    });
  });

  describe('recoverSchedulesForSpace', () => {
    it('re-enqueues active cron schedules whose pendingJobId was cleared', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
      });

      scheduleRepo.updatePendingJobId(schedule.id, null);

      const recovered = service.recoverSchedulesForSpace(spaceId);
      expect(recovered).toBe(1);

      const after = scheduleRepo.getById(schedule.id);
      expect(after?.pendingJobId).not.toBeNull();
      expect(after?.status).toBe('active');
      expect(jobQueue.getJob(after?.pendingJobId as string)).not.toBeNull();
    });

    it('re-enqueues `at` schedules whose runAt is still in the future', () => {
      const future = Date.now() + 60_000;
      const schedule = service.createSchedule({
        spaceId,
        title: 'One Shot',
        triggerType: 'at',
        runAt: future,
      });
      scheduleRepo.updatePendingJobId(schedule.id, null);

      const recovered = service.recoverSchedulesForSpace(spaceId);
      expect(recovered).toBe(1);

      const after = scheduleRepo.getById(schedule.id);
      expect(after?.pendingJobId).not.toBeNull();
      expect(after?.status).toBe('active');
    });

    it('marks `at` schedules whose deadline expired during the outage as completed', () => {
      const future = Date.now() + 60_000;
      const schedule = service.createSchedule({
        spaceId,
        title: 'One Shot',
        triggerType: 'at',
        runAt: future,
      });
      scheduleRepo.updatePendingJobId(schedule.id, null);
      scheduleRepo.update(schedule.id, { runAt: Date.now() - 60_000 });

      const recovered = service.recoverSchedulesForSpace(spaceId);
      expect(recovered).toBe(0);

      const after = scheduleRepo.getById(schedule.id);
      expect(after?.status).toBe('completed');
      expect(after?.pendingJobId).toBeNull();
    });

    it('skips schedules that already have a pending job linked', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      const originalJobId = schedule.pendingJobId;

      const recovered = service.recoverSchedulesForSpace(spaceId);
      expect(recovered).toBe(0);

      const after = scheduleRepo.getById(schedule.id);
      expect(after?.pendingJobId).toBe(originalJobId);
    });

    it('leaves an unrecoverable cron config alone for the operator to fix', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
      });
      scheduleRepo.updatePendingJobId(schedule.id, null);
      scheduleRepo.update(schedule.id, { timezone: 'Not/A_Real_Zone' });

      const recovered = service.recoverSchedulesForSpace(spaceId);
      expect(recovered).toBe(0);

      const after = scheduleRepo.getById(schedule.id);
      expect(after?.status).toBe('active');
      expect(after?.pendingJobId).toBeNull();
    });

    it('skips schedules that were paused between snapshot and reseed', () => {
      const schedule = service.createSchedule({
        spaceId,
        title: 'Cron',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
      });
      scheduleRepo.updatePendingJobId(schedule.id, null);

      scheduleRepo.updateStatus(schedule.id, 'paused');

      const recovered = service.recoverSchedulesForSpace(spaceId);
      expect(recovered).toBe(0);

      const after = scheduleRepo.getById(schedule.id);
      expect(after?.status).toBe('paused');
      expect(after?.pendingJobId).toBeNull();
    });
  });
});
