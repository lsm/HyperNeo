import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import {
  SpaceGoalService,
  type ClaimOutcomeNotificationParams,
  type SpaceGoalServiceDeps,
} from '../../../src/lib/space/goals/goal-service';
import type { GoalOwnerResolutionDecision } from '../../../src/lib/space/goals/goal-owner-resolution';
import { SpaceGoalEventRepository } from '../../../src/storage/repositories/space-goal-event-repository';
import { SpaceGoalRepository } from '../../../src/storage/repositories/space-goal-repository';
import { SpaceGoalOutcomeNotificationRepository } from '../../../src/storage/repositories/space-goal-outcome-notification-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import type { SpaceGoal, SpaceGoalOutcomeNotification, SpaceTask } from '@hyperneo/shared';
import type { ScheduleService } from '../../../src/lib/space/schedule/schedule-service';
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
  let resolutions: Record<string, GoalOwnerResolutionDecision>;
  let coordinatorAgent: { id: string; handle: string; status: string } | null;

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
    resolutions = {};
    coordinatorAgent = { id: 'coordinator-1', handle: 'coordinator', status: 'active' };
    const longHorizonAgentRepo = {
      assignGoal: mock(() => null),
      getPrimaryGoalOwner: mock((goalId: string) => resolutions[goalId] ?? resolution),
      getCoordinator: mock(() => coordinatorAgent),
      getById: mock((id: string) =>
        coordinatorAgent && id === coordinatorAgent.id ? coordinatorAgent : null
      ),
    } as unknown as SpaceGoalServiceDeps['longHorizonAgentRepo'];
    service = new SpaceGoalService({
      goalRepo,
      goalEventRepo: new SpaceGoalEventRepository(db as never),
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

  it('admits the existing coordinator when the owner is degraded', () => {
    resolution = {
      action: 'degraded',
      reason: 'paused',
      owner: { agentId: 'agent-1', relationship: 'owner', createdAt: Date.now() },
      conflicts: [],
    };

    const result = service.claimOutcomeNotification(claimParams({ actorAgentId: 'coordinator-1' }));

    expect(result).toMatchObject({ status: 'claimed' });
  });

  it('denies a degraded-owner claim when no coordinator exists', () => {
    resolution = {
      action: 'degraded',
      reason: 'archived',
      owner: { agentId: 'agent-1', relationship: 'owner', createdAt: Date.now() },
      conflicts: [],
    };
    coordinatorAgent = null;

    const result = service.claimOutcomeNotification(claimParams({ actorAgentId: 'coordinator-1' }));

    expect(result).toMatchObject({ status: 'denied', reason: 'unauthorized' });
  });

  it('denies a degraded-owner claim when the coordinator is inactive', () => {
    resolution = {
      action: 'degraded',
      reason: 'paused',
      owner: { agentId: 'agent-1', relationship: 'owner', createdAt: Date.now() },
      conflicts: [],
    };
    coordinatorAgent = { id: 'coordinator-1', handle: 'coordinator', status: 'paused' };

    const result = service.claimOutcomeNotification(claimParams({ actorAgentId: 'coordinator-1' }));

    expect(result).toMatchObject({ status: 'denied', reason: 'unauthorized' });
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

  describe('listClaimableOutcomeNotifications', () => {
    it('discovers the pending notification for the resolved owner', () => {
      const notifications = service.listClaimableOutcomeNotifications({
        spaceId: goal.spaceId,
        callerAgentId: 'agent-1',
        humanAdmissionAllowed: false,
      });

      expect(notifications.map((n) => n.id)).toEqual([notification.id]);
    });

    it('excludes goals the caller does not own', () => {
      const otherGoal = service.createGoal({ spaceId: goal.spaceId, title: 'Other' });
      resolutions[otherGoal.id] = {
        action: 'resolved',
        owner: { agentId: 'agent-2', relationship: 'owner', createdAt: Date.now() },
        conflicts: [],
      };
      const otherTask = taskRepo.createTask({
        spaceId: goal.spaceId,
        title: 'Other task',
        goalId: otherGoal.id,
      });
      notificationRepo.create({
        spaceId: goal.spaceId,
        goalId: otherGoal.id,
        taskId: otherTask.id,
        terminalGeneration: 1,
        goalRevision: otherGoal.revision,
        payload: {
          summary: '',
          taskStatus: 'done',
          taskTitle: 'Other task',
          goalTitle: 'Other',
        },
      });

      const notifications = service.listClaimableOutcomeNotifications({
        spaceId: goal.spaceId,
        callerAgentId: 'agent-1',
        humanAdmissionAllowed: false,
      });

      expect(notifications.map((n) => n.goalId)).toEqual([goal.id]);
    });

    it('returns nothing for an unauthorized caller', () => {
      const notifications = service.listClaimableOutcomeNotifications({
        spaceId: goal.spaceId,
        callerAgentId: 'agent-2',
        humanAdmissionAllowed: false,
      });

      expect(notifications).toEqual([]);
    });

    it('discovers notifications the active coordinator can claim as fallback', () => {
      resolution = { action: 'coordinator_fallback', coordinatorAgentId: 'coordinator-1' };

      const notifications = service.listClaimableOutcomeNotifications({
        spaceId: goal.spaceId,
        callerAgentId: 'coordinator-1',
        humanAdmissionAllowed: false,
      });

      expect(notifications.map((n) => n.id)).toEqual([notification.id]);
    });
  });

  describe('applyOutcomeGoalUpdate', () => {
    it('applies summary, next steps, and progress atomically', () => {
      const updated = service.applyOutcomeGoalUpdate({
        goalId: goal.id,
        summary: 'Reviewed',
        nextSteps: ['Next'],
        progress: 50,
        sourceTaskId: task.id,
      });

      expect(updated.summary).toBe('Reviewed');
      expect(updated.nextSteps).toEqual(['Next']);
      expect(updated.progress).toBe(50);
      expect(updated.revision).toBe(goal.revision + 1);
    });

    it('replaces metric values and accumulates numeric observations as deltas', () => {
      service.applyOutcomeGoalUpdate({ goalId: goal.id, metrics: { activated: 5 } });
      const updated = service.applyOutcomeGoalUpdate({
        goalId: goal.id,
        observations: [
          { key: 'activated', value: 3 },
          { key: 'converted', value: 2 },
        ],
      });

      expect(updated.metrics.activated).toBe(8);
      expect(updated.metrics.converted).toBe(2);
    });

    it('preserves recurring-goal progress when not part of the update', () => {
      const recurring = service.createGoal({
        spaceId: goal.spaceId,
        title: 'Recurring',
        type: 'recurring',
        progress: 10,
      });

      const updated = service.applyOutcomeGoalUpdate({
        goalId: recurring.id,
        summary: 'Reviewed',
      });

      expect(updated.progress).toBe(10);
    });

    it('records a goal event referencing the reviewed task', () => {
      service.applyOutcomeGoalUpdate({
        goalId: goal.id,
        summary: 'Reviewed',
        sourceTaskId: task.id,
      });

      const events = new SpaceGoalEventRepository(db as never).listByGoal(goal.id);
      expect(events.some((e) => e.eventType === 'updated' && e.sourceTaskId === task.id)).toBe(
        true
      );
    });
  });
});
