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

/**
 * Pause a schedule and verify it actually paused.
 *
 * `ScheduleService.pauseSchedule` returns the (still-active) schedule rather
 * than throwing when its pending-job compare-and-swap loses to a concurrent
 * fire/reschedule. Ignoring that leaves a stale schedule firing alongside any
 * replacement. Treat a vanished or already-non-active schedule as success
 * (nothing to pause) but throw on a lost CAS so the caller can retry instead
 * of silently keeping the old schedule active.
 */
function pauseScheduleStrict(scheduleService: ScheduleService, scheduleId: string): void {
  let result;
  try {
    result = scheduleService.pauseSchedule(scheduleId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|not active/i.test(message)) return; // benign: gone or already paused
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
        pauseScheduleStrict(scheduleService, sched.id);
      }
    }

    // If scope has no goal linkage or goal is inactive, pause active schedules
    // and stop — reconciliation on goal relink/resume will re-enable.
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
    // Find the current-goal schedule (excluding completed — reconciliation recreates those).
    const existing = allScopeSchedules
      .filter((schedule) => schedule.goalId === goal.id)
      .find((schedule) => schedule.status !== 'completed');
    if (!policy.selfNagCronExpression) {
      if (existing?.status === 'active') pauseScheduleStrict(scheduleService, existing.id);
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
