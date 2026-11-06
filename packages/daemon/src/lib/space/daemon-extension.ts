import { Database } from '../../storage/database.ts';
import { type DaemonInternalEventMap, type InternalEventBus } from '../internal-event-bus.ts';
import { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceAgentReminderRepository } from '../../storage/repositories/space-agent-reminder-repository.ts';
import { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository.ts';
import { SpaceManager } from '../../../../space/src/managers/space-manager.ts';
import type { SpaceRuntimeService } from '../../../../space/src/runtime/space-runtime-service.ts';
import type { SpaceWorktreeManager } from '../workspaces/worktree-manager.ts';
import { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { JobQueueProcessor } from '../../storage/job-queue-processor.ts';
import { LONG_HORIZON_AGENT_REMINDER_FIRE, TASK_SCHEDULE_FIRE } from '../job-queue-constants.ts';
import { handleTaskScheduleFire } from '../../../../space/src/job-handlers/task-schedule-fire.handler.ts';
import {
  backfillLongHorizonAgentReminderNextRunAt,
  enqueueLongHorizonAgentReminderScanIfMissing,
  handleLongHorizonAgentReminderFire,
} from '../job-handlers/long-horizon-agent-reminder-fire.handler.ts';
import { readReminderOccurrenceState } from '../agents/reminder-delivery-registry.ts';
import { resolveAgentSessionId } from '../session-resolution/long-term-agent-session.ts';
import { TaskScheduleRepository } from '../../storage/repositories/task-schedule-repository.ts';
import { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository.ts';
import type { DaemonExtension } from '../extensions/contract.ts';
import {
  createSpaceAdapter,
  spaceTaskControl,
} from '../../../../space/src/drivers/space-adapter.ts';
import type { SessionManager } from '../session/session-manager.ts';
import type { TaskAgentManager } from './runtime/task-agent-manager.ts';
import { hostname } from 'node:os';
import type { ReactiveDatabase } from '../../storage/reactive-database.ts';
import type { SpaceAgentInactivityWatchdogService } from '../agents/inactivity-watchdog-service.ts';
import type { SpaceGoalService } from '../../../../space/src/goals/service.ts';
import type { GoalAutomationService } from '../../../../space/src/goals/automation-service.ts';

interface SpaceDaemonExtensionDeps {
  db: Database;
  reactiveDb: ReactiveDatabase;
  jobQueue: JobQueueRepository;
  jobProcessor: JobQueueProcessor;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  spaceManager: SpaceManager;
  spaceWorktreeManager: SpaceWorktreeManager;
  spaceAgentInactivityWatchdog: SpaceAgentInactivityWatchdogService;
  spaceRuntimeService: SpaceRuntimeService;
  spaceRuntimeReadyPromise: Promise<unknown>;
  spaceGoalService: SpaceGoalService;
  goalAutomationService: GoalAutomationService;
  cancelInactivityWatchdog: () => void;
  logInfo: (...args: unknown[]) => void;
  logError: (...args: unknown[]) => void;
  sessionManager: Pick<SessionManager, 'getOperationRegistry'>;
  taskAgentManager: TaskAgentManager;
}

export function createSpaceDaemonExtension({
  db,
  reactiveDb,
  jobQueue,
  jobProcessor,
  internalEventBus,
  spaceManager,
  spaceWorktreeManager,
  spaceAgentInactivityWatchdog,
  spaceRuntimeService,
  spaceRuntimeReadyPromise,
  spaceGoalService,
  goalAutomationService,
  cancelInactivityWatchdog,
  logInfo,
  logError,
  sessionManager,
  taskAgentManager,
}: SpaceDaemonExtensionDeps): DaemonExtension {
  let reaperTimer: ReturnType<typeof setInterval> | null = null;
  let inactivityWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  let inactivityScan: Promise<void> | null = null;
  let inactivityShutdownStarted = false;
  const start = async () => {
    const taskScheduleRepo = new TaskScheduleRepository(db.getDatabase());
    const taskScheduleSpaceRepo = new SpaceRepository(db.getDatabase());
    const taskScheduleTaskRepo = new SpaceTaskRepository(db.getDatabase(), reactiveDb);
    jobProcessor.register(TASK_SCHEDULE_FIRE, async (job) => {
      return handleTaskScheduleFire(job, {
        db: db.getDatabase(),
        scheduleRepo: taskScheduleRepo,
        jobQueue,
        spaceRepo: taskScheduleSpaceRepo,
        taskRepo: taskScheduleTaskRepo,
        eventHub: internalEventBus,
        goalService: spaceGoalService,
        goalRepo: new SpaceGoalRepository(db.getDatabase(), reactiveDb),
        goalAutomationService,
      });
    });

    const lhAgentReminderRepo = new SpaceAgentReminderRepository(
      db.getDatabase(),
      new SpaceAgentRepository(db.getDatabase())
    );
    const lhAgentReminderSpaceRepo = new SpaceRepository(db.getDatabase());
    const lhAgentReminderAgentRepo = new SpaceLongHorizonAgentRepository(db.getDatabase());
    jobProcessor.register(LONG_HORIZON_AGENT_REMINDER_FIRE, async (job) => {
      return handleLongHorizonAgentReminderFire(job, {
        reminderRepo: lhAgentReminderRepo,
        spaceRepo: lhAgentReminderSpaceRepo,
        jobQueue,
        deliver: (args) => spaceRuntimeService.deliverLongHorizonAgentReminder(args),
        getOccurrenceDeliveryState: (spaceId, agentId, idempotencyKey) => {
          const sessionId = resolveAgentSessionId(lhAgentReminderAgentRepo, spaceId, agentId);
          return sessionId
            ? readReminderOccurrenceState(reactiveDb?.db, sessionId, idempotencyKey)
            : 'absent';
        },
      });
    });

    if (process.env.NODE_ENV !== 'test') {
      const now = Date.now();

      const isJobLost = (status: string | undefined): boolean =>
        status === undefined ||
        status === 'completed' ||
        status === 'failed' ||
        status === 'dead' ||
        status === 'cancelled';

      const reseedSchedule = (scheduleId: string, scheduleNextRunAt: number | null): void => {
        const runAt =
          scheduleNextRunAt !== null && scheduleNextRunAt > now ? scheduleNextRunAt : now;
        const newJob = jobQueue.enqueue({
          queue: TASK_SCHEDULE_FIRE,
          payload: { scheduleId },
          runAt,
        });
        taskScheduleRepo.updatePendingJobId(scheduleId, newJob.id);
        logInfo('[Daemon] Re-seeded lost job for schedule', {
          scheduleId,
          newJobId: newJob.id,
        });
      };

      try {
        const activeSchedules = taskScheduleRepo.listActiveWithPendingJob();
        for (const schedule of activeSchedules) {
          if (!schedule.pendingJobId) continue;
          const job = jobQueue.getJob(schedule.pendingJobId);
          if (isJobLost(job?.status)) {
            reseedSchedule(schedule.id, schedule.nextRunAt);
          }
        }

        const RECOVERY_PAGE_SIZE = 200;
        let totalReseeded = 0;
        while (true) {
          const dueSchedules = taskScheduleRepo.listActiveDue(now, RECOVERY_PAGE_SIZE);
          let pageReseeded = 0;
          for (const schedule of dueSchedules) {
            if (schedule.pendingJobId) continue;
            reseedSchedule(schedule.id, schedule.nextRunAt);
            pageReseeded++;
          }
          totalReseeded += pageReseeded;
          if (dueSchedules.length < RECOVERY_PAGE_SIZE || pageReseeded === 0) break;
        }
        if (totalReseeded > 0) {
          logInfo('[Daemon] Re-seeded due schedules with no pending job', {
            count: totalReseeded,
          });
        }
      } catch (err) {
        logError('[Daemon] Task schedule startup re-seed failed (non-fatal):', err);
      }
    }

    enqueueLongHorizonAgentReminderScanIfMissing(jobQueue, Date.now());
    logInfo('[Daemon] Ensured initial longHorizonAgentReminder.fire scan job');
    if (process.env.NODE_ENV !== 'test') {
      try {
        const backfilled = backfillLongHorizonAgentReminderNextRunAt(lhAgentReminderRepo);
        if (backfilled > 0) {
          logInfo('[Daemon] Backfilled next_run_at for LH agent reminders', {
            count: backfilled,
          });
        }
      } catch (err) {
        logError('[Daemon] LH agent reminder backfill failed (non-fatal):', err);
      }
    }

    if (process.env.NODE_ENV !== 'test') {
      const worktreeStartupCleanup = async () => {
        try {
          const spaces = await spaceManager.listSpaces(false);
          for (const space of spaces) {
            await spaceWorktreeManager.cleanupOrphaned(space.id);
          }
          logInfo('[Daemon] Worktree orphan cleanup complete');
        } catch (err) {
          logError('[Daemon] Worktree orphan cleanup failed:', err);
        }

        try {
          await spaceWorktreeManager.reapExpiredWorktrees();
          logInfo('[Daemon] Worktree TTL reaper complete');
        } catch (err) {
          logError('[Daemon] Worktree TTL reaper failed:', err);
        }
      };
      void worktreeStartupCleanup();

      const WORKTREE_REAPER_INTERVAL_MS = 60 * 60 * 1000;
      reaperTimer = setInterval(() => {
        spaceWorktreeManager.reapExpiredWorktrees().catch((err) => {
          logError('[Daemon] Periodic worktree TTL reaper failed:', err);
        });
      }, WORKTREE_REAPER_INTERVAL_MS);
      reaperTimer.unref();
    }

    if (process.env.NODE_ENV !== 'test') {
      const scanInactivityWatchdog = (): Promise<void> => {
        if (inactivityScan !== null) return inactivityScan;
        const run = (async () => {
          try {
            const spaces = await spaceManager.listSpaces(false);
            for (const space of spaces) {
              await spaceAgentInactivityWatchdog.scanSpace(space.id);
            }
          } catch (err) {
            logError('[Daemon] Inactivity watchdog scan failed:', err);
          }
        })();
        inactivityScan = run;
        void run.finally(() => {
          inactivityScan = null;
        });
        return run;
      };
      let inactivitySpaceRuntimeReady = false;
      void spaceRuntimeReadyPromise.then(() => {
        inactivitySpaceRuntimeReady = true;
        if (!inactivityShutdownStarted) {
          void scanInactivityWatchdog();
        }
      });
      const INACTIVITY_WATCHDOG_SCAN_INTERVAL_MS = 5 * 60 * 1000;
      inactivityWatchdogTimer = setInterval(() => {
        if (inactivitySpaceRuntimeReady) {
          void scanInactivityWatchdog();
        }
      }, INACTIVITY_WATCHDOG_SCAN_INTERVAL_MS);
      inactivityWatchdogTimer.unref();
    }
  };
  const stop = async () => {
    if (reaperTimer !== null) {
      clearInterval(reaperTimer);
      reaperTimer = null;
    }
    if (inactivityWatchdogTimer !== null) {
      clearInterval(inactivityWatchdogTimer);
      inactivityWatchdogTimer = null;
    }
    inactivityShutdownStarted = true;
    cancelInactivityWatchdog();
    if (inactivityScan !== null) {
      await Promise.race([inactivityScan, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
  };
  return {
    id: 'space',
    start,
    stop,
    adapters: ({ searchChats }) => [
      createSpaceAdapter({
        readTurnEnds: (sessionId, since) => db.readHyperneoTurnEndsAsync(sessionId, since),
        db: () => db.getDatabase(),
        machine: hostname(),
        searchChats,
        tasks: spaceTaskControl({
          deps: { sessionManager, db },
          spaceRuntimeService,
          taskAgentManager,
        }),
      }),
    ],
  };
}
