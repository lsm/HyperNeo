import type { EvolutionScope } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
import type { SpaceGoalRepository } from '../../../storage/repositories/space-goal-repository';
import type { ScheduleService } from '../schedule/schedule-service';
import { readAutomationPolicyForScope } from './goal-automation-service';

export function readSelfNagScheduleScopeId(schedule: {
  metadata?: Record<string, unknown>;
}): string | null {
  const scopeId = schedule.metadata?.goalAutomationScopeId;
  return typeof scopeId === 'string' && scopeId.trim() ? scopeId : null;
}

function goalAutomationSelfNagMetadata(scopeId: string): Record<string, unknown> {
  return { goalAutomationKind: 'self_nag', goalAutomationScopeId: scopeId };
}

export function pauseScheduleStrict(scheduleService: ScheduleService, scheduleId: string): void {
  let result;
  try {
    result = scheduleService.pauseSchedule(scheduleId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|not active/i.test(message)) return;
    throw err;
  }
  if (result.status !== 'paused') {
    throw new Error(
      `Could not pause Forge self-nag schedule ${scheduleId} (concurrently fired/rescheduled). Retry the update.`
    );
  }
}

export function syncGoalAutomationSelfNagScheduleForScope(params: {
  goalRepo: SpaceGoalRepository;
  scheduleService: ScheduleService;
  scope: EvolutionScope;
  db?: BunDatabase;
}): void {
  const { goalRepo, scheduleService, scope, db } = params;
  const run = () => {
    const policy = readAutomationPolicyForScope(scope);
    const allScopeSchedules = scheduleService
      .listSchedules(scope.spaceId)
      .filter(
        (schedule) =>
          schedule.createdByAgent === 'goal-automation-service' &&
          readSelfNagScheduleScopeId(schedule) === scope.id
      );
    for (const sched of allScopeSchedules) {
      if (
        sched.status === 'active' &&
        sched.goalId !== null &&
        sched.goalId !== scope.spaceGoalId
      ) {
        pauseScheduleStrict(scheduleService, sched.id);
      }
    }

    if (!scope.spaceGoalId) {
      for (const sched of allScopeSchedules) {
        if (sched.status === 'active') {
          pauseScheduleStrict(scheduleService, sched.id);
        }
      }
      return;
    }
    const goal = goalRepo.getById(scope.spaceGoalId);
    if (!goal || goal.status !== 'active') return;
    const scopeLabel = `scope:${scope.id}`;
    const existing = allScopeSchedules
      .filter((schedule) => schedule.goalId === goal.id)
      .find((schedule) => schedule.status !== 'completed');
    if (!policy.selfNagCronExpression) {
      if (existing?.status === 'active') pauseScheduleStrict(scheduleService, existing.id);
      return;
    }
    if (existing) {
      scheduleService.updateSchedule(existing.id, {
        title: `Evolve self-nag: ${goal.title}`,
        description: `Run Evolve automation for goal: ${goal.title}`,
        priority: goal.priority,
        labels: ['forge', 'automation', `goal:${goal.id}`, scopeLabel],
        cronExpression: policy.selfNagCronExpression,
        timezone: policy.selfNagTimezone ?? 'UTC',
      });
      if (existing.status === 'paused') scheduleService.resumeSchedule(existing.id);
      return;
    }
    scheduleService.createGoalSchedule({
      spaceId: goal.spaceId,
      goalId: goal.id,
      title: `Evolve self-nag: ${goal.title}`,
      description: `Run Evolve automation for goal: ${goal.title}`,
      priority: goal.priority,
      labels: ['forge', 'automation', `goal:${goal.id}`, scopeLabel],
      metadata: goalAutomationSelfNagMetadata(scope.id),
      triggerType: 'cron',
      cronExpression: policy.selfNagCronExpression,
      timezone: policy.selfNagTimezone ?? 'UTC',
      createdByAgent: 'goal-automation-service',
    });
  };
  if (db) {
    db.transaction(run)();
  } else {
    run();
  }
}
