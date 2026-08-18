import type { MessageHub } from '@hyperneo/shared';
import type {
  TaskScheduleStatus,
  TaskScheduleTriggerType,
  SpaceTaskPriority,
} from '@hyperneo/shared';
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

  function requireScheduleInSpace(scheduleId: string, spaceId: string) {
    if (!scheduleId) throw new Error('scheduleId is required');
    if (!spaceId) throw new Error('spaceId is required');
    const schedule = scheduleService.getSchedule(scheduleId);
    if (!schedule || schedule.spaceId !== spaceId) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    return schedule;
  }

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

  messageHub.onRequest('taskSchedule.list', async (data) => {
    const params = data as { spaceId: string; status?: TaskScheduleStatus };
    if (!params.spaceId) throw new Error('spaceId is required');

    const schedules = scheduleService.listSchedules(params.spaceId, params.status);
    return { schedules };
  });

  messageHub.onRequest('taskSchedule.get', async (data) => {
    const params = data as { scheduleId: string; spaceId: string };
    if (!params.scheduleId) throw new Error('scheduleId is required');
    if (!params.spaceId) throw new Error('spaceId is required');
    const schedule = scheduleService.getSchedule(params.scheduleId);
    return { schedule: schedule && schedule.spaceId === params.spaceId ? schedule : null };
  });

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

  messageHub.onRequest('taskSchedule.pause', async (data) => {
    const params = data as { scheduleId: string; spaceId: string };
    requireScheduleInSpace(params.scheduleId, params.spaceId);
    const schedule = scheduleService.pauseSchedule(params.scheduleId);
    return { schedule };
  });

  messageHub.onRequest('taskSchedule.resume', async (data) => {
    const params = data as { scheduleId: string; spaceId: string };
    requireScheduleInSpace(params.scheduleId, params.spaceId);
    const schedule = scheduleService.resumeSchedule(params.scheduleId);
    return { schedule };
  });

  messageHub.onRequest('taskSchedule.delete', async (data) => {
    const params = data as { scheduleId: string; spaceId: string };
    requireScheduleInSpace(params.scheduleId, params.spaceId);
    const ok = scheduleService.deleteSchedule(params.scheduleId);
    if (!ok) throw new Error(`Schedule not found: ${params.scheduleId}`);
    log.debug('taskSchedule.delete', { scheduleId: params.scheduleId });
    return { success: true };
  });
}
