import type { TaskSchedule } from '@hyperneo/shared';
import { getNextRunAt, isValidCronExpression } from './cron-utils.ts';
import type { CreateScheduleInput, UpdateScheduleInput } from './schedule-service.ts';

export function validateCreateTrigger(input: CreateScheduleInput): void {
  if (!input.spaceId) throw new Error('spaceId is required');
  if (!input.title?.trim()) throw new Error('title is required');
  if (!input.triggerType) throw new Error('triggerType is required');

  if (input.triggerType === 'cron') {
    if (!input.cronExpression) throw new Error('cronExpression is required for cron triggers');
    if (!isValidCronExpression(input.cronExpression)) {
      throw new Error(`Invalid cron expression: ${input.cronExpression}`);
    }
  } else if (input.triggerType === 'at') {
    if (!input.runAt) throw new Error('runAt is required for at triggers');
    if (input.runAt < Date.now()) throw new Error('runAt must be in the future');
  } else {
    throw new Error(
      `Unsupported triggerType: ${String(input.triggerType)} (expected 'cron' or 'at')`
    );
  }
}

export function computeInitialNextRun(input: CreateScheduleInput, tz: string): number {
  let nextRunAt: number | null;
  if (input.triggerType === 'cron') {
    nextRunAt = getNextRunAt(input.cronExpression as string, tz);
  } else {
    nextRunAt = input.runAt as number;
  }
  if (nextRunAt === null) {
    throw new Error('Could not compute next run time from the provided expression');
  }
  return nextRunAt;
}

export function validateScheduleUpdate(existing: TaskSchedule, input: UpdateScheduleInput): void {
  if (input.title !== undefined && !input.title.trim()) {
    throw new Error('title must be a non-empty string');
  }

  if (
    existing.triggerType === 'cron' &&
    'cronExpression' in input &&
    input.cronExpression === null
  ) {
    throw new Error(
      'Cannot clear cronExpression on a cron schedule. Delete and recreate, or change triggerType.'
    );
  }

  if (input.cronExpression !== undefined && input.cronExpression !== null) {
    if (!isValidCronExpression(input.cronExpression)) {
      throw new Error(`Invalid cron expression: ${input.cronExpression}`);
    }
  }
  if (input.runAt !== undefined && input.runAt !== null) {
    if (input.runAt < Date.now()) throw new Error('runAt must be in the future');
  }
}

export function computeResumeNextRun(schedule: TaskSchedule): number | null {
  const tz = schedule.timezone;
  if (schedule.triggerType === 'cron' && schedule.cronExpression) {
    const nextRunAt = getNextRunAt(schedule.cronExpression, tz);
    if (nextRunAt === null) {
      throw new Error(
        `Cannot resume cron schedule: no next run computable from "${schedule.cronExpression}" with timezone "${tz}". Fix the trigger config and try again.`
      );
    }
    return nextRunAt;
  }
  if (schedule.triggerType === 'at' && schedule.runAt) {
    return schedule.runAt < Date.now() ? null : schedule.runAt;
  }
  return null;
}
