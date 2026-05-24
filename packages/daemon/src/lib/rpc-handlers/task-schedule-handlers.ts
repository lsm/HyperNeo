/**
 * Task Schedule RPC Handlers
 *
 * Thin wrappers over `ScheduleService`. The service holds the validation,
 * atomic create+enqueue, and reschedule logic so the RPC handlers and the
 * agent-facing MCP tools both call into one place.
 *
 * Exposes CRUD operations for TaskSchedule over the MessageHub:
 *   taskSchedule.create  — create schedule + enqueue first job (atomic)
 *   taskSchedule.list    — list schedules for a space
 *   taskSchedule.get     — get schedule by id
 *   taskSchedule.update  — edit template/cron (cancel old job, enqueue new)
 *   taskSchedule.pause   — cancel pending job, set paused
 *   taskSchedule.resume  — re-enqueue, set active
 *   taskSchedule.delete  — cancel pending job + delete schedule row
 */

import type { MessageHub } from '@neokai/shared';
import type {
  TaskScheduleStatus,
  TaskScheduleTriggerType,
  SpaceTaskPriority,
} from '@neokai/shared';
import { Logger } from '../logger';
import type { ScheduleService } from '../space/schedule/schedule-service';
import type { SpaceManager } from '../space/managers/space-manager';

const log = new Logger('task-schedule-handlers');

export interface TaskScheduleHandlerDeps {
  scheduleService: ScheduleService;
  spaceManager: SpaceManager;
}

export function setupTaskScheduleHandlers(
  messageHub: MessageHub,
  deps: TaskScheduleHandlerDeps
): void {
  const { scheduleService, spaceManager } = deps;

  // Helper: load a schedule and verify it belongs to the supplied spaceId.
  // All mutating handlers go through this so cross-space mutation by ID is
  // not possible — even for callers holding a stale schedule ID from another
  // space.
  function requireScheduleInSpace(scheduleId: string, spaceId: string) {
    if (!scheduleId) throw new Error('scheduleId is required');
    if (!spaceId) throw new Error('spaceId is required');
    const schedule = scheduleService.getSchedule(scheduleId);
    if (!schedule || schedule.spaceId !== spaceId) {
      // Use the same error message regardless of cause so callers cannot
      // probe for the existence of schedules in spaces they don't own.
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    return schedule;
  }

  // ─── taskSchedule.create ───────────────────────────────────────────────────

  messageHub.onRequest('taskSchedule.create', async (data) => {
    const params = data as {
      spaceId: string;
      title: string;
      description?: string;
      priority?: SpaceTaskPriority;
      preferredWorkflowId?: string | null;
      labels?: string[];
      triggerType: TaskScheduleTriggerType;
      cronExpression?: string | null;
      runAt?: number | null;
      timezone?: string;
      createdByAgent?: string | null;
      createdBySession?: string | null;
    };

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    const schedule = scheduleService.createSchedule(params);
    log.debug('taskSchedule.create', {
      scheduleId: schedule.id,
      nextRunAt: schedule.nextRunAt,
      jobId: schedule.pendingJobId,
    });
    return { schedule };
  });

  // ─── taskSchedule.list ─────────────────────────────────────────────────────

  messageHub.onRequest('taskSchedule.list', async (data) => {
    const params = data as { spaceId: string; status?: TaskScheduleStatus };
    if (!params.spaceId) throw new Error('spaceId is required');

    const schedules = scheduleService.listSchedules(params.spaceId, params.status);
    return { schedules };
  });

  // ─── taskSchedule.get ──────────────────────────────────────────────────────

  messageHub.onRequest('taskSchedule.get', async (data) => {
    const params = data as { scheduleId: string; spaceId: string };
    const schedule = requireScheduleInSpace(params.scheduleId, params.spaceId);
    return { schedule };
  });

  // ─── taskSchedule.update ───────────────────────────────────────────────────

  messageHub.onRequest('taskSchedule.update', async (data) => {
    const params = data as {
      scheduleId: string;
      spaceId: string;
      title?: string;
      description?: string;
      priority?: SpaceTaskPriority;
      preferredWorkflowId?: string | null;
      labels?: string[];
      cronExpression?: string | null;
      runAt?: number | null;
      timezone?: string;
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _existing = requireScheduleInSpace(params.scheduleId, params.spaceId);
    const { scheduleId, spaceId: _spaceId, ...input } = params;
    const schedule = scheduleService.updateSchedule(scheduleId, input);
    return { schedule };
  });

  // ─── taskSchedule.pause ────────────────────────────────────────────────────

  messageHub.onRequest('taskSchedule.pause', async (data) => {
    const params = data as { scheduleId: string; spaceId: string };
    requireScheduleInSpace(params.scheduleId, params.spaceId);
    const schedule = scheduleService.pauseSchedule(params.scheduleId);
    return { schedule };
  });

  // ─── taskSchedule.resume ───────────────────────────────────────────────────

  messageHub.onRequest('taskSchedule.resume', async (data) => {
    const params = data as { scheduleId: string; spaceId: string };
    requireScheduleInSpace(params.scheduleId, params.spaceId);
    const schedule = scheduleService.resumeSchedule(params.scheduleId);
    return { schedule };
  });

  // ─── taskSchedule.delete ───────────────────────────────────────────────────

  messageHub.onRequest('taskSchedule.delete', async (data) => {
    const params = data as { scheduleId: string; spaceId: string };
    requireScheduleInSpace(params.scheduleId, params.spaceId);
    const ok = scheduleService.deleteSchedule(params.scheduleId);
    if (!ok) throw new Error(`Schedule not found: ${params.scheduleId}`);
    log.debug('taskSchedule.delete', { scheduleId: params.scheduleId });
    return { success: true };
  });
}
