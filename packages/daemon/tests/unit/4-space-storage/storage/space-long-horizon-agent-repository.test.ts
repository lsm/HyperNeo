import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import {
  coordinatorLongHorizonAgentId,
  coordinatorSessionId,
  SpaceLongHorizonAgentRepository,
} from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('SpaceLongHorizonAgentRepository', () => {
  let db: BunDatabase;
  let repo: SpaceLongHorizonAgentRepository;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    db.prepare(
      `INSERT INTO spaces (
				id, slug, workspace_path, name, description, background_context, instructions,
				allowed_models, session_ids, status, paused, stopped, autonomy_level,
				max_concurrent_tasks, created_at, updated_at
			) VALUES (?, ?, ?, ?, '', '', '', '[]', '[]', 'active', 0, 0, 1, 1, ?, ?)`
    ).run('space-1', 'space-1', '/tmp/space-1', 'Space 1', 1, 1);
    repo = new SpaceLongHorizonAgentRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test('ensures default Coordinator row once with stable session identity', () => {
    const coordinator = repo.ensureCoordinator('space-1');
    const again = repo.ensureCoordinator('space-1');

    expect(coordinator).toEqual(again);
    expect(coordinator.id).toBe(coordinatorLongHorizonAgentId('space-1'));
    expect(coordinator.handle).toBe('coordinator');
    expect(coordinator.displayName).toBe('Coordinator');
    expect(coordinator.templateKey).toBe('coordinator.default');
    expect(coordinator.status).toBe('active');
    expect(coordinator.sessionId).toBe(coordinatorSessionId('space-1'));
    expect(coordinator.instructions).toContain('Coordinate long-horizon Space activity');
    expect(coordinator.autonomyLevel).toBe(2);
    expect(coordinator.toolPermissions).toEqual({});
    expect(repo.listBySpaceId('space-1')).toHaveLength(1);
  });

  test('ignores archived rows when fetching by handle', () => {
    const archived = repo.create({
      spaceId: 'space-1',
      handle: 'coordinator',
      displayName: 'Archived Coordinator',
      status: 'archived',
    });

    const coordinator = repo.ensureCoordinator('space-1');

    expect(archived.status).toBe('archived');
    expect(coordinator.id).toBe(coordinatorLongHorizonAgentId('space-1'));
    expect(coordinator.status).toBe('active');
    expect(repo.getByHandle('space-1', 'coordinator')?.id).toBe(coordinator.id);
    expect(repo.listBySpaceId('space-1')).toHaveLength(2);
  });

  test('unarchives deterministic Coordinator row instead of inserting duplicate id', () => {
    const archived = repo.ensureCoordinator('space-1');
    repo.update(archived.id, { status: 'archived' });

    const coordinator = repo.ensureCoordinator('space-1');

    expect(coordinator.id).toBe(coordinatorLongHorizonAgentId('space-1'));
    expect(coordinator.status).toBe('active');
    expect(repo.listBySpaceId('space-1')).toHaveLength(1);
  });

  test('persists agent fields and updates nullable policy fields', () => {
    const agent = repo.create({
      spaceId: 'space-1',
      handle: 'forge-steward',
      displayName: 'Forge Steward',
      templateKey: 'forge.steward',
      status: 'paused',
      sessionId: 'space:lh:forge-steward',
      instructions: 'Watch Forge scopes.',
      autonomyLevel: 3,
      provider: 'openrouter',
      settingSources: ['project'],
      toolPermissions: { forge: { write: true } },
    });

    expect(repo.getByHandle('space-1', 'forge-steward')).toMatchObject({
      id: agent.id,
      displayName: 'Forge Steward',
      templateKey: 'forge.steward',
      status: 'paused',
      sessionId: 'space:lh:forge-steward',
      instructions: 'Watch Forge scopes.',
      autonomyLevel: 3,
      provider: 'openrouter',
      settingSources: ['project'],
      toolPermissions: { forge: { write: true } },
    });

    expect(
      repo.update(agent.id, {
        status: 'active',
        autonomyLevel: null,
        provider: null,
        settingSources: null,
        toolPermissions: null,
      })
    ).toMatchObject({
      status: 'active',
      autonomyLevel: null,
      provider: null,
      settingSources: null,
      toolPermissions: {},
    });
  });

  test('rejects cross-space goal, Forge scope, reminder, and subscription links', () => {
    db.prepare(
      `INSERT INTO spaces (
				id, slug, workspace_path, name, description, background_context, instructions,
				allowed_models, session_ids, status, paused, stopped, autonomy_level,
				max_concurrent_tasks, created_at, updated_at
			) VALUES (?, ?, ?, ?, '', '', '', '[]', '[]', 'active', 0, 0, 1, 1, ?, ?)`
    ).run('space-2', 'space-2', '/tmp/space-2', 'Space 2', 1, 1);
    const agent = repo.ensureCoordinator('space-1');
    db.prepare(
      `INSERT INTO space_goals (
				id, space_id, title, description, status, type, priority, labels, metrics,
				summary, progress, next_steps, auto_trigger_next, pending_next_run, created_at, updated_at
			) VALUES (?, ?, ?, '', 'active', 'one_shot', 'normal', '[]', '{}', '', 0, '[]', 0, 0, ?, ?)`
    ).run('goal-2', 'space-2', 'Goal 2', 1, 1);
    db.prepare(
      `INSERT INTO evolution_scopes (
				id, space_id, kind, name, objective, metric_definitions_json, policy_json, created_at, updated_at
			) VALUES (?, ?, 'mission', ?, ?, '[]', '{}', ?, ?)`
    ).run('scope-2', 'space-2', 'Scope 2', 'Improve Forge', 1, 1);

    expect(() => repo.assignGoal(agent.id, 'goal-2')).toThrow(
      'Goal goal-2 does not belong to space space-1'
    );
    expect(() => repo.assignForgeScope(agent.id, 'scope-2')).toThrow(
      'Forge scope scope-2 does not belong to space space-1'
    );
    expect(() =>
      repo.createReminder({
        spaceId: 'space-2',
        agentId: agent.id,
        title: 'Wrong space',
        triggerType: 'at',
      })
    ).toThrow(`Long-horizon agent ${agent.id} does not belong to space space-2`);
    expect(() =>
      repo.createSubscription({
        spaceId: 'space-2',
        agentId: agent.id,
        source: 'github',
        topic: 'pull_request.*',
      })
    ).toThrow(`Long-horizon agent ${agent.id} does not belong to space space-2`);
  });

  test('persists managed goals, Forge scopes, reminders, and event subscriptions', () => {
    const agent = repo.ensureCoordinator('space-1');
    db.prepare(
      `INSERT INTO space_goals (
				id, space_id, title, description, status, type, priority, labels, metrics,
				summary, progress, next_steps, auto_trigger_next, pending_next_run, created_at, updated_at
			) VALUES (?, ?, ?, '', 'active', 'one_shot', 'normal', '[]', '{}', '', 0, '[]', 0, 0, ?, ?)`
    ).run('goal-1', 'space-1', 'Goal 1', 1, 1);
    db.prepare(
      `INSERT INTO evolution_scopes (
				id, space_id, kind, name, objective, metric_definitions_json, policy_json, created_at, updated_at
			) VALUES (?, ?, 'mission', ?, ?, '[]', '{}', ?, ?)`
    ).run('scope-1', 'space-1', 'Scope 1', 'Improve Forge', 1, 1);

    repo.assignGoal(agent.id, 'goal-1', 'manager');
    repo.assignForgeScope(agent.id, 'scope-1', 'watcher');
    const reminder = repo.createReminder({
      spaceId: 'space-1',
      agentId: agent.id,
      title: 'Check goal',
      triggerType: 'at',
      runAt: 123,
      nextRunAt: 123,
      createdBySession: agent.sessionId,
    });
    const subscription = repo.createSubscription({
      spaceId: 'space-1',
      agentId: agent.id,
      source: 'github',
      topic: 'pull_request.*',
      filter: { repo: 'lsm/neokai' },
    });

    expect(repo.listGoals(agent.id)).toEqual([
      expect.objectContaining({ agentId: agent.id, goalId: 'goal-1', relationship: 'manager' }),
    ]);
    expect(repo.listForgeScopes(agent.id)).toEqual([
      expect.objectContaining({ agentId: agent.id, scopeId: 'scope-1', relationship: 'watcher' }),
    ]);
    expect(repo.getReminder(reminder.id)).toMatchObject({
      title: 'Check goal',
      body: '',
      status: 'active',
      triggerType: 'at',
      timezone: 'UTC',
      createdBySession: agent.sessionId,
    });
    expect(repo.getSubscription(subscription.id)).toMatchObject({
      source: 'github',
      topic: 'pull_request.*',
      filter: { repo: 'lsm/neokai' },
      status: 'active',
    });
  });

  test('lists goal assignments by goal and deletes a single relationship', () => {
    const agent = repo.ensureCoordinator('space-1');
    db.prepare(
      `INSERT INTO space_goals (
				id, space_id, title, description, status, type, priority, labels, metrics,
				summary, progress, next_steps, auto_trigger_next, pending_next_run, created_at, updated_at
			) VALUES (?, ?, ?, '', 'active', 'one_shot', 'normal', '[]', '{}', '', 0, '[]', 0, 0, ?, ?)`
    ).run('goal-1', 'space-1', 'Goal 1', 1, 1);

    repo.assignGoal(agent.id, 'goal-1', 'owner');
    repo.assignGoal(agent.id, 'goal-1', 'manager');
    repo.assignGoal(agent.id, 'goal-1', 'watcher');

    expect(repo.listGoalAssignments('goal-1')).toEqual([
      expect.objectContaining({ agentId: agent.id, goalId: 'goal-1', relationship: 'owner' }),
      expect.objectContaining({ agentId: agent.id, goalId: 'goal-1', relationship: 'manager' }),
      expect.objectContaining({ agentId: agent.id, goalId: 'goal-1', relationship: 'watcher' }),
    ]);

    repo.deleteGoalAssignmentByRelationship(agent.id, 'goal-1', 'owner');
    expect(repo.listGoalAssignments('goal-1').map((a) => a.relationship)).toEqual([
      'manager',
      'watcher',
    ]);
  });

  test('resolves the primary goal owner with coordinator fallback', () => {
    const coordinator = repo.ensureCoordinator('space-1');
    db.prepare(
      `INSERT INTO space_goals (
				id, space_id, title, description, status, type, priority, labels, metrics,
				summary, progress, next_steps, auto_trigger_next, pending_next_run, created_at, updated_at
			) VALUES (?, ?, ?, '', 'active', 'one_shot', 'normal', '[]', '{}', '', 0, '[]', 0, 0, ?, ?)`
    ).run('goal-1', 'space-1', 'Goal 1', 1, 1);

    expect(repo.getPrimaryGoalOwner('goal-1', 'space-1')).toEqual({
      action: 'coordinator_fallback',
      coordinatorAgentId: coordinator.id,
    });

    repo.assignGoal(coordinator.id, 'goal-1', 'owner');
    expect(repo.getPrimaryGoalOwner('goal-1', 'space-1')).toEqual({
      action: 'resolved',
      owner: expect.objectContaining({ agentId: coordinator.id, relationship: 'owner' }),
      conflicts: [],
    });
  });

  test('resolves a degraded owner when the agent is paused', () => {
    const agent = repo.ensureCoordinator('space-1');
    db.prepare(
      `INSERT INTO space_goals (
				id, space_id, title, description, status, type, priority, labels, metrics,
				summary, progress, next_steps, auto_trigger_next, pending_next_run, created_at, updated_at
			) VALUES (?, ?, ?, '', 'active', 'one_shot', 'normal', '[]', '{}', '', 0, '[]', 0, 0, ?, ?)`
    ).run('goal-1', 'space-1', 'Goal 1', 1, 1);
    repo.assignGoal(agent.id, 'goal-1', 'owner');
    repo.update(agent.id, { status: 'paused' });

    expect(repo.getPrimaryGoalOwner('goal-1', 'space-1')).toEqual({
      action: 'degraded',
      reason: 'paused',
      owner: expect.objectContaining({ agentId: agent.id }),
      conflicts: [],
    });
  });

  test('upserts, lists active, and deletes event subscriptions by route', () => {
    const agent = repo.ensureCoordinator('space-1');

    const created = repo.upsertSubscription({
      spaceId: 'space-1',
      agentId: agent.id,
      source: 'github',
      topic: 'github/lsm/neokai/pull_request/*.review_submitted',
      filter: { label: 'reviews' },
      status: 'active',
    });
    const updated = repo.upsertSubscription({
      spaceId: 'space-1',
      agentId: agent.id,
      source: 'github',
      topic: 'github/lsm/neokai/pull_request/*.review_submitted',
      filter: { label: 'reviews' },
      status: 'paused',
    });

    expect(updated.id).toBe(created.id);
    expect(updated.status).toBe('paused');
    expect(repo.listActiveSubscriptionsBySpace('space-1')).toHaveLength(0);

    repo.upsertSubscription({
      spaceId: 'space-1',
      agentId: agent.id,
      source: 'github',
      topic: 'github/lsm/neokai/pull_request/*.review_submitted',
      filter: { label: 'reviews' },
      status: 'active',
    });
    repo.upsertSubscription({
      spaceId: 'space-1',
      agentId: agent.id,
      source: 'github',
      topic: 'github/lsm/neokai/pull_request/*.review_submitted',
      filter: { label: 'triage' },
      status: 'active',
    });
    expect(repo.listActiveSubscriptionsBySpace('space-1')).toEqual([
      expect.objectContaining({
        id: created.id,
        agentId: agent.id,
        topic: 'github/lsm/neokai/pull_request/*.review_submitted',
        filter: { label: 'triage' },
        status: 'active',
      }),
    ]);

    repo.deleteSubscriptionByRoute(
      'space-1',
      agent.id,
      'github',
      'github/lsm/neokai/pull_request/*.review_submitted'
    );
    expect(repo.listSubscriptions(agent.id)).toEqual([]);
  });

  test('listDueReminders returns only active due reminders for active agents', () => {
    const now = 10_000_000;
    const activeAgent = repo.create({
      spaceId: 'space-1',
      handle: 'active-agent',
      displayName: 'Active',
    });
    const pausedAgent = repo.create({
      spaceId: 'space-1',
      handle: 'paused-agent',
      displayName: 'Paused',
      status: 'paused',
    });

    const dueReminder = repo.createReminder({
      spaceId: 'space-1',
      agentId: activeAgent.id,
      title: 'due',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });
    repo.createReminder({
      spaceId: 'space-1',
      agentId: activeAgent.id,
      title: 'future',
      triggerType: 'at',
      runAt: now + 60_000,
      nextRunAt: now + 60_000,
    });
    repo.createReminder({
      spaceId: 'space-1',
      agentId: activeAgent.id,
      title: 'paused-reminder',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
      status: 'paused',
    });
    repo.createReminder({
      spaceId: 'space-1',
      agentId: pausedAgent.id,
      title: 'paused-owner',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });
    repo.createReminder({
      spaceId: 'space-1',
      agentId: activeAgent.id,
      title: 'no-next',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
    });

    const due = repo.listDueReminders(now);
    expect(due.map((r) => r.id)).toEqual([dueReminder.id]);
  });

  test('listDueReminders excludes reminders for paused or stopped spaces', () => {
    const now = 30_000_000;
    db.prepare(
      `INSERT INTO spaces (
				id, slug, workspace_path, name, description, background_context, instructions,
				allowed_models, session_ids, status, paused, stopped, autonomy_level,
				max_concurrent_tasks, created_at, updated_at
			) VALUES (?, ?, ?, '', '', '', '', '[]', '[]', 'active', 1, 0, 1, 1, ?, ?)`
    ).run('space-paused', 'space-paused', '/tmp/space-paused', 1, 1);
    db.prepare(
      `INSERT INTO spaces (
				id, slug, workspace_path, name, description, background_context, instructions,
				allowed_models, session_ids, status, paused, stopped, autonomy_level,
				max_concurrent_tasks, created_at, updated_at
			) VALUES (?, ?, ?, '', '', '', '', '[]', '[]', 'active', 0, 1, 1, 1, ?, ?)`
    ).run('space-stopped', 'space-stopped', '/tmp/space-stopped', 1, 1);

    const activeAgent = repo.create({ spaceId: 'space-1', handle: 'a', displayName: 'A' });
    const pausedSpaceAgent = repo.create({
      spaceId: 'space-paused',
      handle: 'p',
      displayName: 'P',
    });
    const stoppedSpaceAgent = repo.create({
      spaceId: 'space-stopped',
      handle: 's',
      displayName: 'S',
    });

    const activeReminder = repo.createReminder({
      spaceId: 'space-1',
      agentId: activeAgent.id,
      title: 'active-space',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });
    repo.createReminder({
      spaceId: 'space-paused',
      agentId: pausedSpaceAgent.id,
      title: 'paused-space',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });
    repo.createReminder({
      spaceId: 'space-stopped',
      agentId: stoppedSpaceAgent.id,
      title: 'stopped-space',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });

    const due = repo.listDueReminders(now);
    expect(due.map((r) => r.id)).toEqual([activeReminder.id]);
  });

  test('listDueReminders pages past excluded ids so poison batches cannot starve later rows', () => {
    const now = 40_000_000;
    const agent = repo.ensureCoordinator('space-1');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = repo.createReminder({
        spaceId: 'space-1',
        agentId: agent.id,
        title: `r${i}`,
        triggerType: 'at',
        runAt: now - 1000 - i,
        nextRunAt: now - 1000 - i,
      });
      ids.push(r.id);
    }

    const page1 = repo.listDueReminders(now, 2);
    expect(page1.map((r) => r.id)).toEqual([ids[2], ids[1]]);

    const page2 = repo.listDueReminders(now, 2, [ids[2], ids[1]]);
    expect(page2.map((r) => r.id)).toEqual([ids[0]]);

    const page3 = repo.listDueReminders(now, 2, ids);
    expect(page3).toEqual([]);
  });

  test('advanceReminderAfterFire advances cron, fires one-shot, and honors the CAS', () => {
    const now = 20_000_000;
    const agent = repo.ensureCoordinator('space-1');

    const cron = repo.createReminder({
      spaceId: 'space-1',
      agentId: agent.id,
      title: 'cron',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
      nextRunAt: now - 1000,
    });
    const futureNext = now + 60_000;
    expect(
      repo.advanceReminderAfterFire(cron.id, now - 1000, {
        status: 'active',
        nextRunAt: futureNext,
        lastFiredAt: now,
      })
    ).toBe(true);
    const cronAfter = repo.getReminder(cron.id)!;
    expect(cronAfter.status).toBe('active');
    expect(cronAfter.nextRunAt).toBe(futureNext);
    expect(cronAfter.lastFiredAt).toBe(now);

    const oneShot = repo.createReminder({
      spaceId: 'space-1',
      agentId: agent.id,
      title: 'one-shot',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });
    expect(
      repo.advanceReminderAfterFire(oneShot.id, now - 1000, {
        status: 'fired',
        nextRunAt: null,
        lastFiredAt: now,
      })
    ).toBe(true);
    const atAfter = repo.getReminder(oneShot.id)!;
    expect(atAfter.status).toBe('fired');
    expect(atAfter.nextRunAt).toBeNull();

    const live = repo.createReminder({
      spaceId: 'space-1',
      agentId: agent.id,
      title: 'live',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
      nextRunAt: now - 500,
    });
    expect(
      repo.advanceReminderAfterFire(live.id, now - 1, {
        status: 'active',
        nextRunAt: now + 60_000,
        lastFiredAt: now,
      })
    ).toBe(false);
    expect(repo.getReminder(live.id)!.nextRunAt).toBe(now - 500);

    const fired = repo.createReminder({
      spaceId: 'space-1',
      agentId: agent.id,
      title: 'already-fired',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
      status: 'fired',
    });
    expect(
      repo.advanceReminderAfterFire(fired.id, now - 1000, {
        status: 'fired',
        nextRunAt: null,
        lastFiredAt: now,
      })
    ).toBe(false);
    expect(repo.getReminder(fired.id)!.lastFiredAt).toBeNull();
  });
});
