import { describe, expect, mock, test } from 'bun:test';
import type { EvolutionScope, TaskSchedule } from '@hyperneo/shared';
import type { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository';
import type { ScheduleService } from '../../../../src/lib/space/schedule/schedule-service';
import {
  orderSelfNagSchedules,
  syncGoalAutomationSelfNagScheduleForScope,
} from '../../../../src/lib/space/goals/goal-automation-schedule-sync';

const SPACE_ID = 'space-1';
const GOAL_ID = 'goal-1';
const SCOPE_ID = 'scope-1';

function selfNagSchedule(id: string, createdAt: number, status: TaskSchedule['status']) {
  return {
    id,
    spaceId: SPACE_ID,
    goalId: GOAL_ID,
    status,
    createdAt,
    createdByAgent: 'goal-automation-service',
    metadata: { goalAutomationKind: 'self_nag', goalAutomationScopeId: SCOPE_ID },
  } as unknown as TaskSchedule;
}

function makeScope(selfNagCronExpression?: string): EvolutionScope {
  return {
    id: SCOPE_ID,
    spaceId: SPACE_ID,
    spaceGoalId: GOAL_ID,
    policy: selfNagCronExpression ? { automation: { selfNagCronExpression } } : {},
  } as unknown as EvolutionScope;
}

function makeHarness(schedules: TaskSchedule[]) {
  const paused: string[] = [];
  const scheduleService = {
    listSchedules: mock(() => schedules),
    pauseSchedule: mock((id: string) => {
      paused.push(id);
      return { ...schedules.find((s) => s.id === id), status: 'paused' } as TaskSchedule;
    }),
    updateSchedule: mock(() => {}),
    resumeSchedule: mock(() => {}),
    createGoalSchedule: mock(() => {}),
  } as unknown as ScheduleService;
  const goalRepo = {
    getById: mock(() => ({ id: GOAL_ID, spaceId: SPACE_ID, status: 'active', title: 'Goal' })),
  } as unknown as SpaceGoalRepository;
  return { paused, scheduleService, goalRepo };
}

describe('orderSelfNagSchedules', () => {
  test('breaks a created_at tie by id so the order is stable', () => {
    const a = selfNagSchedule('aaa', 1000, 'active');
    const b = selfNagSchedule('bbb', 1000, 'active');
    expect(orderSelfNagSchedules([b, a]).map((s) => s.id)).toEqual(['aaa', 'bbb']);
    expect(orderSelfNagSchedules([a, b]).map((s) => s.id)).toEqual(['aaa', 'bbb']);
  });

  test('still orders newest first when timestamps differ', () => {
    expect(
      orderSelfNagSchedules([
        selfNagSchedule('old', 1000, 'active'),
        selfNagSchedule('new', 2000, 'active'),
      ]).map((s) => s.id)
    ).toEqual(['new', 'old']);
  });
});

describe('syncGoalAutomationSelfNagScheduleForScope — clearing automation', () => {
  test('pauses every active self-nag schedule for the goal, not just the first', () => {
    const schedules = [
      selfNagSchedule('sched-a', 1000, 'active'),
      selfNagSchedule('sched-b', 1000, 'active'),
    ];
    const { paused, scheduleService, goalRepo } = makeHarness(schedules);

    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope: makeScope() });

    expect(paused.sort()).toEqual(['sched-a', 'sched-b']);
  });

  test('leaves an already-paused duplicate alone', () => {
    const schedules = [
      selfNagSchedule('sched-a', 1000, 'active'),
      selfNagSchedule('sched-b', 1000, 'paused'),
    ];
    const { paused, scheduleService, goalRepo } = makeHarness(schedules);

    syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope: makeScope() });

    expect(paused).toEqual(['sched-a']);
  });
});

describe('syncGoalAutomationSelfNagScheduleForScope — automation enabled', () => {
  test('pauses active duplicates so only the canonical schedule survives', () => {
    const schedules = [
      selfNagSchedule('sched-new', 2000, 'active'),
      selfNagSchedule('sched-old', 1000, 'active'),
    ];
    const { paused, scheduleService, goalRepo } = makeHarness(schedules);

    syncGoalAutomationSelfNagScheduleForScope({
      goalRepo,
      scheduleService,
      scope: makeScope('0 9 * * 1'),
    });

    expect(paused).toEqual(['sched-old']);
    expect(scheduleService.updateSchedule).toHaveBeenCalledWith(
      'sched-new',
      expect.objectContaining({ cronExpression: '0 9 * * 1' })
    );
  });

  test('resumes the canonical schedule only after pausing the other active duplicate', () => {
    const schedules = [
      selfNagSchedule('sched-new', 2000, 'paused'),
      selfNagSchedule('sched-old', 1000, 'active'),
    ];
    const { paused, scheduleService, goalRepo } = makeHarness(schedules);

    syncGoalAutomationSelfNagScheduleForScope({
      goalRepo,
      scheduleService,
      scope: makeScope('0 9 * * 1'),
    });

    expect(paused).toEqual(['sched-old']);
    expect(scheduleService.resumeSchedule).toHaveBeenCalledWith('sched-new');
  });
});
