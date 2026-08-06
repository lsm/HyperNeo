/**
 * Forge (Evolution) self-nag schedule reconciliation.
 *
 * Keeps a scope's goal-automation self-nag schedule aligned with the scope's
 * policy + goal linkage: pause/update/resume/create the cron schedule so it
 * fires for the currently-linked active goal with the current cadence.
 *
 * Shared by the RPC path (`evolution.scope.update` via its `onScopeSaved`
 * hook) and the MCP path (`update_forge_scope`) so both reconcile identically
 * after a scope save. Extracted here (rather than living only in the RPC
 * layer) so the `space-agent-tools` MCP handler can call it without importing
 * the RPC layer.
 */

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

export function syncGoalAutomationSelfNagScheduleForScope(params: {
  goalRepo: SpaceGoalRepository;
  scheduleService: ScheduleService;
  scope: EvolutionScope;
  db?: BunDatabase;
}): void {
  const { goalRepo, scheduleService, scope, db } = params;
  const run = () => {
    const policy = readAutomationPolicyForScope(scope);
    // Find all automation schedules for this scope across any goal, including
    // completed ones (so reconciliation can recreate after goal reactivation).
    const allScopeSchedules = scheduleService
      .listSchedules(scope.spaceId)
      .filter(
        (schedule) =>
          schedule.createdByAgent === 'goal-automation-service' &&
          readSelfNagScheduleScopeId(schedule) === scope.id
      );
    // Pause any active schedule whose goalId no longer matches the current scope
    // goal (e.g. scope was reassigned from goal A to goal B).
    for (const sched of allScopeSchedules) {
      if (
        sched.status === 'active' &&
        sched.goalId !== null &&
        sched.goalId !== scope.spaceGoalId
      ) {
        try {
          scheduleService.pauseSchedule(sched.id);
        } catch {
          // Schedule may have been concurrently modified; best-effort.
        }
      }
    }

    // If scope has no goal linkage or goal is inactive, pause active schedules
    // and stop — reconciliation on goal relink/resume will re-enable.
    if (!scope.spaceGoalId) {
      for (const sched of allScopeSchedules) {
        if (sched.status === 'active') {
          try {
            scheduleService.pauseSchedule(sched.id);
          } catch {
            // Best-effort.
          }
        }
      }
      return;
    }
    const goal = goalRepo.getById(scope.spaceGoalId);
    if (!goal || goal.status !== 'active') return;
    const scopeLabel = `scope:${scope.id}`;
    // Find the current-goal schedule (excluding completed — reconciliation recreates those).
    const existing = allScopeSchedules
      .filter((schedule) => schedule.goalId === goal.id)
      .find((schedule) => schedule.status !== 'completed');
    if (!policy.selfNagCronExpression) {
      if (existing?.status === 'active') scheduleService.pauseSchedule(existing.id);
      return;
    }
    if (existing) {
      // Update cron/timezone *before* resume so resumeSchedule computes
      // nextRunAt from the new (valid) trigger config instead of the
      // stale config persisted when the schedule was paused.
      scheduleService.updateSchedule(existing.id, {
        title: `Forge self-nag: ${goal.title}`,
        description: `Run Forge automation for goal: ${goal.title}`,
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
      title: `Forge self-nag: ${goal.title}`,
      description: `Run Forge automation for goal: ${goal.title}`,
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
