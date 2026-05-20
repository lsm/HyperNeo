/**
 * SpaceTaskRepository Tests
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('SpaceTaskRepository', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let repo: SpaceTaskRepository;
	let spaceId: string;
	let workflowId: string;
	let workflowRunId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		spaceRepo = new SpaceRepository(db as any);
		repo = new SpaceTaskRepository(db as any);

		const space = spaceRepo.createSpace({
			workspacePath: '/workspace/test',
			slug: 'test',
			name: 'Test',
		});
		spaceId = space.id;

		// Set up workflow records for FK-constrained fields
		const now = Date.now();
		workflowId = 'wf-1';
		workflowRunId = 'run-1';

		(db as any)
			.prepare(
				`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
			)
			.run(workflowId, spaceId, 'Workflow', now, now);

		(db as any)
			.prepare(
				`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(workflowRunId, spaceId, workflowId, 'Run 1', now, now);
	});

	afterEach(() => {
		db.close();
	});

	function createSearchIndex(): void {
		db.exec(`
			CREATE VIRTUAL TABLE message_search_fts USING fts5(
				kind UNINDEXED,
				source_id UNINDEXED,
				message_id UNINDEXED,
				session_id UNINDEXED,
				task_id UNINDEXED,
				space_id UNINDEXED,
				task_number UNINDEXED,
				message_type UNINDEXED,
				title,
				body,
				timestamp UNINDEXED,
				tokenize = 'unicode61'
			)
		`);
	}

	function searchIndexedTaskIds(query: string): string[] {
		return (
			(db as any)
				.prepare(`SELECT source_id FROM message_search_fts WHERE message_search_fts MATCH ?`)
				.all(query) as Array<{ source_id: string }>
		).map((row) => row.source_id);
	}

	describe('createTask', () => {
		it('creates a task with required fields', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Fix bug',
				description: 'Fix the login bug',
			});

			expect(task.id).toBeDefined();
			expect(task.spaceId).toBe(spaceId);
			expect(task.title).toBe('Fix bug');
			expect(task.description).toBe('Fix the login bug');
			expect(task.status).toBe('open');
			expect(task.priority).toBe('normal');
			expect(task.labels).toEqual([]);
			expect(task.dependsOn).toEqual([]);
			expect(task.workflowRunId).toBeUndefined();
			expect(task.taskAgentSessionId).toBeUndefined();
		});

		it('creates a task with workflow routing fields', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Step task',
				description: '',
				workflowRunId,
			});

			expect(task.workflowRunId).toBe(workflowRunId);
		});

		it('creates a task with open status by default', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Open task',
				description: '',
				status: 'open',
			});
			expect(task.status).toBe('open');
		});

		it('persists taskAgentSessionId when provided', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Agent task',
				description: '',
				taskAgentSessionId: 'session-abc',
			});
			expect(task.taskAgentSessionId).toBe('session-abc');
		});

		it('leaves taskAgentSessionId undefined when not provided', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			expect(task.taskAgentSessionId).toBeUndefined();
		});
	});

	describe('getTask', () => {
		it('returns task by ID', () => {
			const created = repo.createTask({ spaceId, title: 'T', description: '' });
			expect(repo.getTask(created.id)).not.toBeNull();
		});

		it('returns null for unknown ID', () => {
			expect(repo.getTask('nonexistent')).toBeNull();
		});
	});

	describe('listBySpace', () => {
		it('lists non-archived tasks for a space', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			const b = repo.createTask({ spaceId, title: 'B', description: '' });
			repo.archiveTask(b.id);

			const tasks = repo.listBySpace(spaceId);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe('A');
		});

		it('includes archived tasks when requested', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			const b = repo.createTask({ spaceId, title: 'B', description: '' });
			repo.archiveTask(b.id);

			expect(repo.listBySpace(spaceId, true)).toHaveLength(2);
		});
	});

	describe('listByWorkflowRun', () => {
		it('lists tasks by workflow run ID', () => {
			repo.createTask({ spaceId, title: 'A', description: '', workflowRunId });
			repo.createTask({ spaceId, title: 'C', description: '' });

			const tasks = repo.listByWorkflowRun(workflowRunId);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe('A');
		});
	});

	describe('listByStatus', () => {
		it('lists tasks by status', () => {
			repo.createTask({ spaceId, title: 'Open', description: '', status: 'open' });
			repo.createTask({ spaceId, title: 'InProgress', description: '', status: 'in_progress' });

			const open = repo.listByStatus(spaceId, 'open');
			expect(open).toHaveLength(1);
			expect(open[0].title).toBe('Open');
		});
	});

	describe('listBySpaceAndStatus (paginated)', () => {
		// Helper to seed N tasks at the same status; spaces them out by 1ms so
		// updated_at ordering is stable. Returns tasks in creation order.
		const seedTasks = (
			n: number,
			status: 'open' | 'in_progress' | 'blocked' = 'in_progress',
			blockReason?: string | null
		) => {
			const ids: string[] = [];
			for (let i = 0; i < n; i++) {
				const t = repo.createTask({
					spaceId,
					title: `Task ${i}`,
					description: '',
					status,
				});
				if (blockReason !== undefined) {
					(db as any)
						.prepare('UPDATE space_tasks SET block_reason = ? WHERE id = ?')
						.run(blockReason, t.id);
				}
				// Force monotonic updated_at so ordering is deterministic.
				(db as any)
					.prepare('UPDATE space_tasks SET updated_at = ? WHERE id = ?')
					.run(Date.now() + i, t.id);
				ids.push(t.id);
			}
			return ids;
		};

		it('returns the page slice and the total count', () => {
			seedTasks(15, 'in_progress');

			const page1 = repo.listBySpaceAndStatus(spaceId, 'in_progress', undefined, 10, 0);
			expect(page1.tasks).toHaveLength(10);
			expect(page1.total).toBe(15);

			const page2 = repo.listBySpaceAndStatus(spaceId, 'in_progress', undefined, 10, 10);
			expect(page2.tasks).toHaveLength(5);
			expect(page2.total).toBe(15);

			// No overlap between pages.
			const page1Ids = new Set(page1.tasks.map((t) => t.id));
			for (const t of page2.tasks) expect(page1Ids.has(t.id)).toBe(false);
		});

		it('returns total=0 and an empty page when no tasks match', () => {
			seedTasks(3, 'open');
			const page = repo.listBySpaceAndStatus(spaceId, 'in_progress', undefined, 10, 0);
			expect(page.tasks).toHaveLength(0);
			expect(page.total).toBe(0);
		});

		it('orders by updated_at desc so newest tasks land on page 1', () => {
			const ids = seedTasks(3, 'in_progress');
			const page = repo.listBySpaceAndStatus(spaceId, 'in_progress', undefined, 10, 0);
			expect(page.tasks[0].id).toBe(ids[2]);
			expect(page.tasks[2].id).toBe(ids[0]);
		});

		it('filters by an exact block_reason value', () => {
			seedTasks(2, 'blocked', 'human_input_requested');
			seedTasks(3, 'blocked', 'gate_rejected');
			seedTasks(1, 'blocked', null);

			const needsInput = repo.listBySpaceAndStatus(
				spaceId,
				'blocked',
				'human_input_requested' as any,
				10,
				0
			);
			expect(needsInput.total).toBe(2);
			expect(needsInput.tasks).toHaveLength(2);

			const gates = repo.listBySpaceAndStatus(spaceId, 'blocked', 'gate_rejected' as any, 10, 0);
			expect(gates.total).toBe(3);
		});

		it('filters by null block_reason when blockReason is explicitly null', () => {
			seedTasks(2, 'blocked', 'human_input_requested');
			seedTasks(3, 'blocked', null);

			const noReason = repo.listBySpaceAndStatus(spaceId, 'blocked', null, 10, 0);
			expect(noReason.total).toBe(3);
			expect(noReason.tasks).toHaveLength(3);
			for (const t of noReason.tasks) expect(t.blockReason).toBeNull();
		});

		it('ignores block_reason when blockReason is undefined', () => {
			seedTasks(2, 'blocked', 'human_input_requested');
			seedTasks(1, 'blocked', null);

			const all = repo.listBySpaceAndStatus(spaceId, 'blocked', undefined, 10, 0);
			expect(all.total).toBe(3);
		});

		it('excludes attention reasons via blockReasonNotIn (and includes null reasons)', () => {
			seedTasks(2, 'blocked', 'human_input_requested');
			seedTasks(1, 'blocked', 'gate_rejected');
			seedTasks(2, 'blocked', 'agent_crashed');
			seedTasks(1, 'blocked', null);

			const generic = repo.listBySpaceAndStatus(spaceId, 'blocked', undefined, 10, 0, [
				'human_input_requested' as any,
				'gate_rejected' as any,
			]);
			// Should include 2 agent_crashed + 1 null = 3, excluding the 3 attention rows.
			expect(generic.total).toBe(3);
			for (const t of generic.tasks) {
				expect(t.blockReason === null || t.blockReason === 'agent_crashed').toBe(true);
			}
		});

		it('rejects combining blockReason and blockReasonNotIn', () => {
			expect(() =>
				repo.listBySpaceAndStatus(spaceId, 'blocked', 'human_input_requested' as any, 10, 0, [
					'gate_rejected' as any,
				])
			).toThrow(/mutually exclusive/);
		});

		it('returns all matching tasks when limit is omitted', () => {
			seedTasks(15, 'in_progress');
			const page = repo.listBySpaceAndStatus(spaceId, 'in_progress', undefined);
			expect(page.tasks).toHaveLength(15);
			expect(page.total).toBe(15);
		});
	});

	describe('updateTask', () => {
		it('updates status and sets started_at for in_progress', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, { status: 'in_progress' });
			expect(updated!.status).toBe('in_progress');
			expect(updated!.startedAt).toBeDefined();
		});

		it('sets completed_at for done status', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			repo.updateTask(task.id, { status: 'in_progress' });
			const updated = repo.updateTask(task.id, { status: 'done' });
			expect(updated!.completedAt).toBeDefined();
		});

		it('auto-clears active_session on terminal status', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			repo.updateTask(task.id, { status: 'in_progress', activeSession: 'worker' });
			const updated = repo.updateTask(task.id, { status: 'done' });
			expect(updated!.activeSession).toBeNull();
		});

		it('updates workflowRunId', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, {
				workflowRunId,
			});
			expect(updated!.workflowRunId).toBe(workflowRunId);
		});

		it('clears nullable fields', () => {
			const task = repo.createTask({
				spaceId,
				title: 'T',
				description: '',
				workflowRunId,
			});
			const updated = repo.updateTask(task.id, { workflowRunId: null });
			expect(updated!.workflowRunId).toBeUndefined();
		});

		it('sets taskAgentSessionId', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, { taskAgentSessionId: 'session-xyz' });
			expect(updated!.taskAgentSessionId).toBe('session-xyz');
		});

		it('clears taskAgentSessionId', () => {
			const task = repo.createTask({
				spaceId,
				title: 'T',
				description: '',
				taskAgentSessionId: 'session-xyz',
			});
			const updated = repo.updateTask(task.id, { taskAgentSessionId: null });
			expect(updated!.taskAgentSessionId).toBeUndefined();
		});

		it('round-trips pendingCompletion* fields (set then clear)', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			// On create, all three fields should be null.
			expect(task.pendingCompletionSubmittedByNodeId).toBeNull();
			expect(task.pendingCompletionSubmittedAt).toBeNull();
			expect(task.pendingCompletionReason).toBeNull();

			// Set via update.
			const ts = Date.now();
			const updated = repo.updateTask(task.id, {
				pendingCheckpointType: 'task_completion',
				pendingCompletionSubmittedByNodeId: 'node-end',
				pendingCompletionSubmittedAt: ts,
				pendingCompletionReason: 'ready for review',
			});
			expect(updated!.pendingCheckpointType).toBe('task_completion');
			expect(updated!.pendingCompletionSubmittedByNodeId).toBe('node-end');
			expect(updated!.pendingCompletionSubmittedAt).toBe(ts);
			expect(updated!.pendingCompletionReason).toBe('ready for review');

			// Clear via update with nulls.
			const cleared = repo.updateTask(task.id, {
				pendingCheckpointType: null,
				pendingCompletionSubmittedByNodeId: null,
				pendingCompletionSubmittedAt: null,
				pendingCompletionReason: null,
			});
			expect(cleared!.pendingCheckpointType).toBeNull();
			expect(cleared!.pendingCompletionSubmittedByNodeId).toBeNull();
			expect(cleared!.pendingCompletionSubmittedAt).toBeNull();
			expect(cleared!.pendingCompletionReason).toBeNull();
		});
	});

	describe('getTaskBySessionId', () => {
		it('returns the task matching the session ID', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Agent task',
				description: '',
				taskAgentSessionId: 'session-lookup',
			});
			const found = repo.getTaskBySessionId('session-lookup');
			expect(found).not.toBeNull();
			expect(found!.id).toBe(task.id);
			expect(found!.taskAgentSessionId).toBe('session-lookup');
		});

		it('returns null when no task matches the session ID', () => {
			expect(repo.getTaskBySessionId('nonexistent-session')).toBeNull();
		});

		it('returns the correct task when multiple tasks exist', () => {
			repo.createTask({ spaceId, title: 'Other', description: '' });
			const task = repo.createTask({
				spaceId,
				title: 'Agent task',
				description: '',
				taskAgentSessionId: 'session-specific',
			});
			const found = repo.getTaskBySessionId('session-specific');
			expect(found!.id).toBe(task.id);
		});
	});

	describe('archiveTask', () => {
		it('sets status to archived and stamps archivedAt', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const archived = repo.archiveTask(task.id);
			expect(archived!.status).toBe('archived');
			expect(archived!.archivedAt).toBeDefined();
			expect(archived!.archivedAt).toBeGreaterThan(0);
		});

		it('archived tasks are excluded from listBySpace by default', () => {
			repo.createTask({ spaceId, title: 'Active', description: '' });
			const toArchive = repo.createTask({ spaceId, title: 'Archived', description: '' });
			repo.archiveTask(toArchive.id);

			const tasks = repo.listBySpace(spaceId);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].title).toBe('Active');
		});

		it('archived tasks are excluded from listByStatus', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '', status: 'open' });
			repo.archiveTask(task.id);

			const open = repo.listByStatus(spaceId, 'open');
			expect(open).toHaveLength(0);
		});

		it('archived tasks are excluded from listByWorkflowRun', () => {
			const task = repo.createTask({
				spaceId,
				title: 'WF Task',
				description: '',
				workflowRunId,
			});
			repo.archiveTask(task.id);

			const tasks = repo.listByWorkflowRun(workflowRunId);
			expect(tasks).toHaveLength(0);
		});
	});

	describe('updateTask archived_at stamping', () => {
		it('stamps archived_at when status is set to archived via updateTask', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, { status: 'archived' });
			expect(updated!.status).toBe('archived');
			expect(updated!.archivedAt).toBeDefined();
			expect(updated!.archivedAt).toBeGreaterThan(0);
		});

		it('auto-clears active_session when status is set to archived', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			repo.updateTask(task.id, { status: 'in_progress', activeSession: 'worker' });
			const updated = repo.updateTask(task.id, { status: 'archived' });
			expect(updated!.activeSession).toBeNull();
		});
	});

	describe('deleteTask', () => {
		it('deletes a task', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			expect(repo.deleteTask(task.id)).toBe(true);
			expect(repo.getTask(task.id)).toBeNull();
		});

		it('returns false for unknown ID', () => {
			expect(repo.deleteTask('nonexistent')).toBe(false);
		});
	});

	describe('promoteDraftTasksByCreator', () => {
		it('promotes draft tasks to open and leaves in_progress tasks unchanged', () => {
			// promoteDraftTasksByCreator targets draft tasks created by the planner
			repo.createTask({
				spaceId,
				title: 'D',
				description: '',
				status: 'draft',
				createdByTaskId: 'planner-1',
			});
			repo.createTask({
				spaceId,
				title: 'P',
				description: '',
				status: 'in_progress',
				createdByTaskId: 'planner-1',
			});

			const count = repo.promoteDraftTasksByCreator('planner-1');
			expect(count).toBe(1);

			const tasks = repo.listBySpace(spaceId);
			const draft = tasks.find((t) => t.title === 'D');
			expect(draft!.status).toBe('open');
			const inProgress = tasks.find((t) => t.title === 'P');
			expect(inProgress!.status).toBe('in_progress');
		});
	});

	describe('message search sync', () => {
		it('syncs task search rows on create, update, and delete', () => {
			createSearchIndex();

			const task = repo.createTask({
				spaceId,
				title: 'Orion task',
				description: 'Initial body',
			});

			expect(searchIndexedTaskIds('orion')).toEqual([task.id]);

			repo.updateTask(task.id, { title: 'Updated task', description: 'Nebula body' });

			expect(searchIndexedTaskIds('orion')).toEqual([]);
			expect(searchIndexedTaskIds('nebula')).toEqual([task.id]);

			repo.deleteTask(task.id);

			expect(searchIndexedTaskIds('nebula')).toEqual([]);
		});

		it('preserves linked message rows when a task enters terminal status', () => {
			createSearchIndex();
			const task = repo.createTask({
				spaceId,
				title: 'Task',
				description: '',
				status: 'in_progress',
			});
			db.prepare(
				`INSERT INTO message_search_fts (kind, source_id, message_id, session_id, task_id, space_id, task_number, message_type, title, body, timestamp)
				 VALUES ('message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(
				'msg-1',
				'uuid-1',
				'space:space-1:task:task-1:exec:exec-1',
				task.id,
				spaceId,
				task.taskNumber,
				'user',
				'Task',
				'terminal task message marker',
				Date.now()
			);
			expect(searchIndexedTaskIds('marker')).toEqual(['msg-1']);

			repo.updateTask(task.id, { status: 'done', completedAt: Date.now() });

			expect(searchIndexedTaskIds('marker')).toEqual(['msg-1']);
		});

		it('removes linked message rows when task status changes to archived', () => {
			createSearchIndex();
			const task = repo.createTask({
				spaceId,
				title: 'Task',
				description: '',
				status: 'in_progress',
			});
			db.prepare(
				`INSERT INTO message_search_fts (kind, source_id, message_id, session_id, task_id, space_id, task_number, message_type, title, body, timestamp)
				 VALUES ('message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(
				'msg-1',
				'uuid-1',
				'space:space-1:task:task-1:exec:exec-1',
				task.id,
				spaceId,
				task.taskNumber,
				'user',
				'Task',
				'archived task message marker',
				Date.now()
			);
			expect(searchIndexedTaskIds('marker')).toEqual(['msg-1']);

			repo.updateTask(task.id, { status: 'archived' });

			expect(searchIndexedTaskIds('marker')).toEqual([]);
			expect(searchIndexedTaskIds('task')).toEqual([task.id]);
		});

		it('removes linked message rows when archiveTask archives a task', () => {
			createSearchIndex();
			const task = repo.createTask({
				spaceId,
				title: 'Archive task',
				description: '',
				status: 'in_progress',
			});
			db.prepare(
				`INSERT INTO message_search_fts (kind, source_id, message_id, session_id, task_id, space_id, task_number, message_type, title, body, timestamp)
				 VALUES ('message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(
				'msg-2',
				'uuid-2',
				'space:space-1:task:task-1:exec:exec-1',
				task.id,
				spaceId,
				task.taskNumber,
				'user',
				'Task',
				'archive helper marker',
				Date.now()
			);
			expect(searchIndexedTaskIds('helper')).toEqual(['msg-2']);

			repo.archiveTask(task.id);

			expect(searchIndexedTaskIds('helper')).toEqual([]);
		});
	});

	describe('labels field', () => {
		it('creates a task with labels', () => {
			const task = repo.createTask({
				spaceId,
				title: 'Labeled task',
				description: '',
				labels: ['bug', 'frontend'],
			});
			expect(task.labels).toEqual(['bug', 'frontend']);
		});

		it('defaults labels to empty array', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			expect(task.labels).toEqual([]);
		});

		it('updates labels on existing task', () => {
			const task = repo.createTask({ spaceId, title: 'T', description: '' });
			const updated = repo.updateTask(task.id, { labels: ['refactor'] });
			expect(updated!.labels).toEqual(['refactor']);
		});

		it('clears labels with empty array', () => {
			const task = repo.createTask({
				spaceId,
				title: 'T',
				description: '',
				labels: ['tag1'],
			});
			const updated = repo.updateTask(task.id, { labels: [] });
			expect(updated!.labels).toEqual([]);
		});
	});

	describe('taskNumber (numeric task IDs)', () => {
		it('auto-assigns taskNumber starting at 1', () => {
			const task = repo.createTask({ spaceId, title: 'First', description: '' });
			expect(task.taskNumber).toBe(1);
		});

		it('auto-increments taskNumber within a space', () => {
			const t1 = repo.createTask({ spaceId, title: 'A', description: '' });
			const t2 = repo.createTask({ spaceId, title: 'B', description: '' });
			const t3 = repo.createTask({ spaceId, title: 'C', description: '' });
			expect(t1.taskNumber).toBe(1);
			expect(t2.taskNumber).toBe(2);
			expect(t3.taskNumber).toBe(3);
		});

		it('scopes taskNumber per space (two spaces get independent sequences)', () => {
			const space2 = spaceRepo.createSpace({
				workspacePath: '/workspace/test2',
				slug: 'space-2',
				name: 'Space 2',
			});

			const s1t1 = repo.createTask({ spaceId, title: 'S1-A', description: '' });
			const s1t2 = repo.createTask({ spaceId, title: 'S1-B', description: '' });
			const s2t1 = repo.createTask({ spaceId: space2.id, title: 'S2-A', description: '' });
			const s2t2 = repo.createTask({ spaceId: space2.id, title: 'S2-B', description: '' });

			expect(s1t1.taskNumber).toBe(1);
			expect(s1t2.taskNumber).toBe(2);
			expect(s2t1.taskNumber).toBe(1);
			expect(s2t2.taskNumber).toBe(2);
		});

		it('leaves gaps when non-highest task is deleted', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			const t2 = repo.createTask({ spaceId, title: 'B', description: '' });
			repo.createTask({ spaceId, title: 'C', description: '' });
			repo.deleteTask(t2.id);

			// After deleting #2, next task gets MAX(1,3)+1 = 4, leaving a gap at #2
			const t4 = repo.createTask({ spaceId, title: 'D', description: '' });
			expect(t4.taskNumber).toBe(4);
		});

		it('is monotonically increasing (MAX+1 strategy)', () => {
			const t1 = repo.createTask({ spaceId, title: 'A', description: '' });
			const t2 = repo.createTask({ spaceId, title: 'B', description: '' });
			expect(t1.taskNumber).toBeLessThan(t2.taskNumber);
		});

		it('enforces UNIQUE(space_id, task_number) constraint', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			// Manually inserting a duplicate task_number should throw
			expect(() => {
				(db as any)
					.prepare(
						`INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, depends_on, created_at, updated_at)
						VALUES ('dup-id', ?, 1, 'Dup', '', 'open', 'normal', '[]', '[]', ?, ?)`
					)
					.run(spaceId, Date.now(), Date.now());
			}).toThrow();
		});

		it('taskNumber is returned by getTask', () => {
			const created = repo.createTask({ spaceId, title: 'T', description: '' });
			const fetched = repo.getTask(created.id);
			expect(fetched!.taskNumber).toBe(1);
		});

		it('taskNumber is returned in list queries', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			repo.createTask({ spaceId, title: 'B', description: '' });

			const tasks = repo.listBySpace(spaceId);
			const numbers = tasks.map((t) => t.taskNumber).sort();
			expect(numbers).toEqual([1, 2]);
		});
	});

	describe('getTaskByNumber', () => {
		it('returns the correct task by (spaceId, taskNumber)', () => {
			const t1 = repo.createTask({ spaceId, title: 'A', description: '' });
			repo.createTask({ spaceId, title: 'B', description: '' });

			const found = repo.getTaskByNumber(spaceId, 1);
			expect(found).not.toBeNull();
			expect(found!.id).toBe(t1.id);
			expect(found!.taskNumber).toBe(1);
		});

		it('returns null for a non-existent taskNumber', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });
			expect(repo.getTaskByNumber(spaceId, 999)).toBeNull();
		});

		it('returns null when taskNumber exists in a different space', () => {
			repo.createTask({ spaceId, title: 'A', description: '' });

			const space2 = spaceRepo.createSpace({
				workspacePath: '/workspace/test3',
				slug: 'space-3',
				name: 'Space 3',
			});
			expect(repo.getTaskByNumber(space2.id, 1)).toBeNull();
		});
	});

	describe('bulk task creation', () => {
		it('assigns unique monotonically increasing taskNumbers for many tasks', () => {
			// Repo-level createTask is synchronous (bun:sqlite), so this tests
			// sequential bulk creation. Concurrent (Promise.all) tests live in
			// space-task-manager.test.ts where createTask is async.
			const tasks = Array.from({ length: 20 }, (_, i) =>
				repo.createTask({ spaceId, title: `Task ${i}`, description: '' })
			);

			const numbers = tasks.map((t) => t.taskNumber);
			const uniqueNumbers = new Set(numbers);
			expect(uniqueNumbers.size).toBe(20);
			expect(Math.min(...numbers)).toBe(1);
			expect(Math.max(...numbers)).toBe(20);
		});
	});

	describe('listActiveWithTaskAgentSession', () => {
		/**
		 * Seed a task at the given status, with an optional task-agent session id.
		 * Statuses outside the default state-machine are applied directly via UPDATE
		 * to avoid running the transition validator (the helper here is purely a
		 * storage-layer fixture).
		 */
		function seed(status: string, sessionId: string | null): string {
			const task = repo.createTask({
				spaceId,
				title: `Task ${status}`,
				description: '',
				workflowRunId,
			});
			(db as any)
				.prepare(`UPDATE space_tasks SET status = ?, task_agent_session_id = ? WHERE id = ?`)
				.run(status, sessionId, task.id);
			return task.id;
		}

		it("includes 'in_progress', 'review', 'blocked', and 'approved' tasks with a non-null session id", () => {
			// 'review' was added to the active set as part of the Task #126 fix:
			// a coder/reviewer sub-session sitting at a code-ready-gate while the
			// parent task waited in 'review' was previously excluded from rehydration,
			// so the task agent's in-process MCP servers were never restored after a
			// daemon restart. See `listActiveWithTaskAgentSession` docstring for the
			// per-status justification.
			const inProgress = seed('in_progress', 'sess-in-progress');
			const review = seed('review', 'sess-review');
			const blocked = seed('blocked', 'sess-blocked');
			const approved = seed('approved', 'sess-approved');

			const active = repo.listActiveWithTaskAgentSession();
			const ids = new Set(active.map((t) => t.id));

			expect(ids.has(inProgress)).toBe(true);
			expect(ids.has(review)).toBe(true);
			expect(ids.has(blocked)).toBe(true);
			expect(ids.has(approved)).toBe(true);
			expect(active.length).toBe(4);
		});

		it('excludes tasks without a task_agent_session_id', () => {
			seed('in_progress', null);
			seed('approved', null);
			const inProgressWithSession = seed('in_progress', 'sess-1');

			const active = repo.listActiveWithTaskAgentSession();
			expect(active.map((t) => t.id)).toEqual([inProgressWithSession]);
		});

		it('excludes terminal and open statuses even when a session id is present', () => {
			// 'review' is intentionally NOT in this exclusion list — it is an
			// active state where the Task Agent (and any sub-sessions sitting at
			// the review gate) must come back after a daemon restart so their
			// in-process MCP servers (`node-agent`, `space-agent-tools`) are
			// re-attached. See the inclusion test above for the rationale.
			seed('open', 'sess-open');
			seed('done', 'sess-done');
			seed('cancelled', 'sess-cancelled');
			seed('archived', 'sess-archived');

			const active = repo.listActiveWithTaskAgentSession();
			expect(active).toEqual([]);
		});
	});
});
