import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import {
  SpaceGoalService,
  type ClaimOutcomeNotificationParams,
  type SpaceGoalServiceDeps,
} from '../../../src/lib/space/goals/goal-service';
import type { GoalOwnerResolutionDecision } from '../../../src/lib/space/goals/goal-owner-resolution';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceGoalOutcomeNotificationRepository } from '../../../src/storage/repositories/space-goal-outcome-notification-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import type { SpaceGoal, SpaceGoalOutcomeNotification, SpaceTask } from '@hyperneo/shared';
import type { ScheduleService } from '../../../src/lib/space/schedule/schedule-service';
import { coordinatorLongHorizonAgentId } from '../../../src/storage/repositories/space-long-horizon-agent-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('SpaceGoalService.claimOutcomeNotification', () => {
  let db: Database;
  let goalRepo: SpaceGoalRepository;
  let taskRepo: SpaceTaskRepository;
  let notificationRepo: SpaceGoalOutcomeNotificationRepository;
  let service: SpaceGoalService;
  let goal: SpaceGoal;
  let task: SpaceTask;
  let notification: SpaceGoalOutcomeNotification;
  let resolution: GoalOwnerResolutionDecision;

  function claimParams(
    overrides: Partial<ClaimOutcomeNotificationParams> = {}
  ): ClaimOutcomeNotificationParams {
    return {
      notificationId: notification.id,
      claimedGoalId: goal.id,
      claimedTaskId: task.id,
      actorAgentId: 'agent-1',
      humanAdmissionAllowed: false,
      mutatesGoalState: true,
      dispositionStatus: 'acknowledged',
      isResubmission: false,
      observedGoalRevision: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    goalRepo = new SpaceGoalRepository(db as never);
    taskRepo = new SpaceTaskRepository(db as never);
    notificationRepo = new SpaceGoalOutcomeNotificationRepository(db as never);
    const spaceRepo = new SpaceRepository(db as never);
    resolution = {
      action: 'resolved',
      owner: { agentId: 'agent-1', relationship: 'owner', createdAt: Date.now() },
      conflicts: [],
    };
    const longHorizonAgentRepo = {
      assignGoal: mock(() => null),
      getPrimaryGoalOwner: mock(() => resolution),
    } as unknown as SpaceGoalServiceDeps['longHorizonAgentRepo'];
    service = new SpaceGoalService({
      goalRepo,
      taskRepo,
      spaceRepo,
      scheduleService: {} as unknown as ScheduleService,
      db: db as never,
      outcomeNotificationRepo: notificationRepo,
      longHorizonAgentRepo,
    });
    const space = spaceRepo.createSpace({
      slug: 'test',
      workspacePath: '/workspace/test',
      name: 'Test Space',
    });
    goal = service.createGoal({ spaceId: space.id, title: 'Goal' });
    task = taskRepo.createTask({ spaceId: space.id, title: 'Task', goalId: goal.id });
    notification = notificationRepo.create({
      spaceId: space.id,
      goalId: goal.id,
      taskId: task.id,
      terminalGeneration: 1,
      goalRevision: goal.revision,
      payload: {
        summary: '',
        taskStatus: 'done',
        taskTitle: 'Task',
        goalTitle: 'Goal',
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  it('admits the owner and terminalizes the notification', () => {
    const result = service.claimOutcomeNotification(claimParams());

    expect(result).toMatchObject({ status: 'claimed' });
    if (result.status !== 'claimed') return;
    expect(result.notification.status).toBe('acknowledged');
    expect(notificationRepo.getById(notification.id)?.status).toBe('acknowledged');
  });

  it('returns the original result on retry without re-applying effects', () => {
    let applyCount = 0;
    const params = claimParams({
      apply: (g) => {
        applyCount += 1;
        return goalRepo.update(g.id, { summary: 'reviewed' }) as SpaceGoal;
      },
    });

    const first = service.claimOutcomeNotification(params);
    const retry = service.claimOutcomeNotification(params);

    expect(first).toMatchObject({ status: 'claimed' });
    expect(retry).toMatchObject({ status: 'already_applied' });
    expect(applyCount).toBe(1);
    expect(goalRepo.getById(goal.id)?.revision).toBe(goal.revision + 1);
  });

  it('denies a claim by a non-resolved actor', () => {
    const result = service.claimOutcomeNotification(claimParams({ actorAgentId: 'agent-2' }));

    expect(result).toEqual({
      status: 'denied',
      reason: 'unauthorized',
      currentGoalRevision: goal.revision,
      goal,
    });
    expect(notificationRepo.getById(notification.id)?.status).toBe('pending');
  });

  it('denies an initial claim whose notification revision is stale', () => {
    goalRepo.update(goal.id, { summary: 'advanced' });
    const freshGoal = goalRepo.getById(goal.id) as SpaceGoal;

    const result = service.claimOutcomeNotification(claimParams());

    expect(result).toEqual({
      status: 'denied',
      reason: 'stale_revision',
      currentGoalRevision: freshGoal.revision,
      goal: freshGoal,
    });
    expect(notificationRepo.getById(notification.id)?.status).toBe('pending');
  });

  it('applies a resubmission whose observed revision matches', () => {
    goalRepo.update(goal.id, { summary: 'advanced' });
    const freshGoal = goalRepo.getById(goal.id) as SpaceGoal;
    service.claimOutcomeNotification(claimParams());

    const result = service.claimOutcomeNotification(
      claimParams({ isResubmission: true, observedGoalRevision: freshGoal.revision })
    );

    expect(result).toMatchObject({ status: 'claimed' });
    if (result.status !== 'claimed') return;
    expect(result.notification.status).toBe('acknowledged');
  });

  it('skips the revision CAS for terminal-only dispositions', () => {
    goalRepo.update(goal.id, { summary: 'advanced' });

    const result = service.claimOutcomeNotification(claimParams({ mutatesGoalState: false }));

    expect(result).toMatchObject({ status: 'claimed' });
    if (result.status !== 'claimed') return;
    expect(result.notification.status).toBe('acknowledged');
  });

  it('does not run the apply hook on terminal-only claims', () => {
    let applyCount = 0;
    const params = claimParams({
      mutatesGoalState: false,
      apply: (g) => {
        applyCount += 1;
        return goalRepo.update(g.id, { summary: 'should-not-apply' }) as SpaceGoal;
      },
    });

    const result = service.claimOutcomeNotification(params);

    expect(result).toMatchObject({ status: 'claimed' });
    expect(applyCount).toBe(0);
  });

  it('rejects cross-goal identity mixing', () => {
    const result = service.claimOutcomeNotification(claimParams({ claimedGoalId: 'other-goal' }));

    expect(result).toMatchObject({ status: 'denied', reason: 'identity_mismatch' });
  });

  it('admits the coordinator fallback when no owner resolves', () => {
    resolution = { action: 'coordinator_fallback', coordinatorAgentId: 'coordinator-1' };

    const result = service.claimOutcomeNotification(claimParams({ actorAgentId: 'coordinator-1' }));

    expect(result).toMatchObject({ status: 'claimed' });
  });

  it('admits the coordinator identity without provisioning when resolution is degraded', () => {
    resolution = {
      action: 'degraded',
      reason: 'paused',
      owner: { agentId: 'agent-1', relationship: 'owner', createdAt: Date.now() },
      conflicts: [],
    };

    const result = service.claimOutcomeNotification(
      claimParams({ actorAgentId: coordinatorLongHorizonAgentId(goal.spaceId) })
    );

    expect(result).toMatchObject({ status: 'claimed' });
  });

  it('rejects an already-applied notification claimed by an unauthorized actor', () => {
    service.claimOutcomeNotification(claimParams());

    const result = service.claimOutcomeNotification(claimParams({ actorAgentId: 'agent-2' }));

    expect(result).toMatchObject({ status: 'denied', reason: 'unauthorized' });
  });

  it('binds identity on the already-applied retry path', () => {
    service.claimOutcomeNotification(claimParams());

    const result = service.claimOutcomeNotification(claimParams({ claimedGoalId: 'other-goal' }));

    expect(result).toMatchObject({ status: 'denied', reason: 'identity_mismatch' });
  });

  it('returns not_found for a missing notification', () => {
    const result = service.claimOutcomeNotification(
      claimParams({ notificationId: 'missing-notification' })
    );

    expect(result).toEqual({ status: 'not_found' });
  });
});
