import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
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
		expect(coordinator.instructions).toContain('Coordinate goals');
		expect(coordinator.toolPermissions).toEqual({});
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
			toolPermissions: { forge: { write: true } },
		});

		expect(
			repo.update(agent.id, {
				status: 'active',
				autonomyLevel: null,
				toolPermissions: null,
			})
		).toMatchObject({
			status: 'active',
			autonomyLevel: null,
			toolPermissions: {},
		});
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
});
