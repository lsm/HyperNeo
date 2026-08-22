import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
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
			CREATE TABLE message_search_content (
				kind TEXT NOT NULL,
				source_id TEXT NOT NULL,
				message_id TEXT,
				session_id TEXT,
				task_id TEXT,
				space_id TEXT,
				task_number INTEGER,
				message_type TEXT,
				title TEXT,
				body TEXT,
				timestamp INTEGER,
				PRIMARY KEY (kind, source_id)
			);
			CREATE TABLE message_search_pending (
				message_id TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL
			);
			CREATE VIRTUAL TABLE message_search_fts USING fts5(
				title,
				body,
				content='message_search_content',
				content_rowid='rowid',
				detail=column,
				tokenize = 'unicode61'
			);
			CREATE TRIGGER message_search_content_ai
			AFTER INSERT ON message_search_content BEGIN
				INSERT INTO message_search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
			END;
			CREATE TRIGGER message_search_content_ad
			AFTER DELETE ON message_search_content BEGIN
				INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
				VALUES ('delete', old.rowid, old.title, old.body);
			END;
			CREATE TRIGGER message_search_content_au
			AFTER UPDATE OF title, body ON message_search_content BEGIN
				INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
				VALUES ('delete', old.rowid, old.title, old.body);
				INSERT INTO message_search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
			END;
		`);
  }

  function searchIndexedTaskIds(query: string): string[] {
    return (
      (db as any)
        .prepare(
          `SELECT msc.source_id FROM message_search_fts JOIN message_search_content msc ON msc.rowid = message_search_fts.rowid WHERE message_search_fts MATCH ?`
        )
        .all(query) as Array<{ source_id: string }>
    ).map((row) => row.source_id);
  }

  function insertWorkerSession(id: string, taskId: string, type = 'worker'): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions (
        id, title, workspace_path, created_at, last_active_at, status, config, metadata, type,
        session_context
       ) VALUES (?, ?, ?, ?, ?, 'active', '{}', '{}', ?, ?)`
    ).run(id, id, '/tmp/workspace', now, now, type, JSON.stringify({ spaceId, taskId }));
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

  describe('restrictions (rate/usage-limit pause)', () => {
    it('persists and reads back a restrictions blob with usage_limited status', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      const resetAt = Date.now() + 60 * 60 * 1000;
      const updated = repo.updateTask(task.id, {
        status: 'usage_limited',
        restrictions: {
          type: 'usage_limit',
          limit: 'parsed-reset',
          resetAt,
          sessionRole: 'worker',
        },
      });
      expect(updated?.status).toBe('usage_limited');
      expect(updated?.restrictions).toEqual({
        type: 'usage_limit',
        limit: 'parsed-reset',
        resetAt,
        sessionRole: 'worker',
      });

      const reread = repo.getTask(task.id);
      expect(reread?.status).toBe('usage_limited');
      expect(reread?.restrictions).toEqual({
        type: 'usage_limit',
        limit: 'parsed-reset',
        resetAt,
        sessionRole: 'worker',
      });
    });

    it('clears restrictions when set to null on resume', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, {
        status: 'rate_limited',
        restrictions: {
          type: 'rate_limit',
          limit: 'backoff-ladder',
          resetAt: Date.now() + 60000,
          sessionRole: 'worker',
        },
      });
      const resumed = repo.updateTask(task.id, { status: 'in_progress', restrictions: null });
      expect(resumed?.status).toBe('in_progress');
      expect(resumed?.restrictions).toBeNull();
    });

    it('defaults restrictions to null for an ordinary task', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      expect(repo.getTask(task.id)?.restrictions).toBeNull();
    });

    it('clears restrictions on a manual transition out of the paused status', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, {
        status: 'usage_limited',
        restrictions: {
          type: 'usage_limit',
          limit: 'parsed-reset',
          resetAt: Date.now() + 60000,
          sessionRole: 'worker',
        },
      });
      const cancelled = repo.updateTask(task.id, { status: 'cancelled' });
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.restrictions).toBeNull();
    });
  });

  describe('listRateLimitedBySpace', () => {
    it('returns only rate_limited / usage_limited tasks', () => {
      const t1 = repo.createTask({ spaceId, title: 'paused-1', description: '' });
      repo.updateTask(t1.id, { status: 'usage_limited' });
      const t2 = repo.createTask({ spaceId, title: 'paused-2', description: '' });
      repo.updateTask(t2.id, { status: 'rate_limited' });
      repo.createTask({ spaceId, title: 'active', description: '' });

      const paused = repo.listRateLimitedBySpace(spaceId);
      expect(paused.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
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

  describe('getTasksByIds', () => {
    it('returns matching tasks in one round-trip and omits unknown ids', () => {
      const t1 = repo.createTask({ spaceId, title: 'A', description: '' });
      const t2 = repo.createTask({ spaceId, title: 'B', description: '' });
      const result = repo.getTasksByIds([t1.id, 'unknown', t2.id]);
      expect(result.map((task) => task.id).sort()).toEqual([t1.id, t2.id].sort());
    });

    it('returns empty for an empty id list without querying', () => {
      expect(repo.getTasksByIds([])).toEqual([]);
    });
  });

  describe('listByWorkflowRunIdsIncludingArchived', () => {
    it('lists tasks across many runs in one round-trip, including archived', () => {
      const now = Date.now();
      (db as any)
        .prepare(
          `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('run-2', spaceId, workflowId, 'Run 2', now, now);

      repo.createTask({ spaceId, title: 'A', description: '', workflowRunId });
      const archived = repo.createTask({ spaceId, title: 'B', description: '', workflowRunId });
      repo.updateTask(archived.id, { status: 'archived' });
      repo.createTask({ spaceId, title: 'C', description: '', workflowRunId: 'run-2' });
      repo.createTask({ spaceId, title: 'standalone', description: '' });

      const tasks = repo.listByWorkflowRunIdsIncludingArchived([workflowRunId, 'run-2']);
      expect(tasks.map((task) => task.title).sort()).toEqual(['A', 'B', 'C']);
    });

    it('returns empty for an empty run-id list without querying', () => {
      expect(repo.listByWorkflowRunIdsIncludingArchived([])).toEqual([]);
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

    it('archives linked runtime sessions when task is done', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      insertWorkerSession('worker-session-1', task.id);
      insertWorkerSession('legacy-coder-session', task.id, 'coder');
      insertWorkerSession('space-chat-session', task.id, 'space_chat');

      repo.updateTask(task.id, { status: 'done' });

      const rows = db
        .prepare(`SELECT id, status, archived_at FROM sessions ORDER BY id`)
        .all() as Array<{ id: string; status: string; archived_at: string | null }>;
      expect(rows).toEqual([
        { id: 'legacy-coder-session', status: 'archived', archived_at: expect.any(String) },
        { id: 'space-chat-session', status: 'active', archived_at: null },
        { id: 'worker-session-1', status: 'archived', archived_at: expect.any(String) },
      ]);
    });

    it('does not archive linked worker sessions when task is blocked', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      insertWorkerSession('worker-session-1', task.id);

      repo.updateTask(task.id, { status: 'blocked' });

      const row = db
        .prepare(`SELECT status FROM sessions WHERE id = ?`)
        .get('worker-session-1') as { status: string };
      expect(row.status).toBe('active');
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
      expect(task.pendingCompletionSubmittedByNodeId).toBeNull();
      expect(task.pendingCompletionSubmittedAt).toBeNull();
      expect(task.pendingCompletionReason).toBeNull();

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

  describe('casStatus', () => {
    it("returns 'won' and flips the status on an exact match", () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      expect(repo.casStatus(task.id, 'open', 'in_progress')).toBe('won');
      expect(repo.getTask(task.id)?.status).toBe('in_progress');
    });

    it("returns 'won' when the current status is in the expected set", () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      expect(repo.casStatus(task.id, ['draft', 'open'], 'review')).toBe('won');
      expect(repo.getTask(task.id)?.status).toBe('review');
    });

    it("returns 'superseded' and leaves the row unchanged when the status moved first", () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      expect(repo.casStatus(task.id, 'open', 'done')).toBe('superseded');
      expect(repo.getTask(task.id)?.status).toBe('in_progress');
    });

    it("returns 'superseded' for an unknown task id", () => {
      expect(repo.casStatus('nonexistent', 'open', 'done')).toBe('superseded');
    });

    it("returns 'superseded' for an empty expected set without writing", () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      expect(repo.casStatus(task.id, [], 'done')).toBe('superseded');
      expect(repo.getTask(task.id)?.status).toBe('open');
    });

    it('touches no other rows', () => {
      const target = repo.createTask({ spaceId, title: 'Target', description: '' });
      const other = repo.createTask({ spaceId, title: 'Other', description: '' });
      const otherBefore = repo.getTask(other.id);
      expect(repo.casStatus(target.id, 'open', 'in_progress')).toBe('won');
      expect(repo.getTask(other.id)).toEqual(otherBefore);
    });
  });

  describe('casStatusWithPayload', () => {
    const limitableSources = ['in_progress', 'rate_limited', 'usage_limited'] as const;
    const resumeSources = ['rate_limited', 'usage_limited'] as const;

    function seedLimitedTask(status: 'rate_limited' | 'usage_limited', resetAt: number): string {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      repo.updateTask(task.id, {
        status,
        restrictions: {
          type: status === 'usage_limited' ? 'usage_limit' : 'rate_limit',
          limit: 'seed',
          resetAt,
          sessionRole: 'worker',
        },
      });
      return task.id;
    }

    it("returns 'won' and writes status plus restrictions payload on a matching source", () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      const startedAtBefore = repo.getTask(task.id)?.startedAt;
      const before = Date.now();
      const resetAt = Date.now() + 60_000;
      const outcome = repo.casStatusWithPayload(task.id, limitableSources, 'rate_limited', {
        restrictions: { type: 'rate_limit', limit: 'backoff', resetAt, sessionRole: 'worker' },
      });
      expect(outcome).toBe('won');
      const updated = repo.getTask(task.id);
      expect(updated?.status).toBe('rate_limited');
      expect(updated?.restrictions).toMatchObject({
        type: 'rate_limit',
        limit: 'backoff',
        resetAt,
        sessionRole: 'worker',
      });
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(before);
      expect(updated?.startedAt).toBe(startedAtBefore);
    });

    it("returns 'won' flipping between limited kinds via the expected set", () => {
      const taskId = seedLimitedTask('rate_limited', Date.now() + 60_000);
      const resetAt = Date.now() + 120_000;
      const outcome = repo.casStatusWithPayload(taskId, limitableSources, 'usage_limited', {
        restrictions: { type: 'usage_limit', limit: 'parsed', resetAt, sessionRole: 'worker' },
      });
      expect(outcome).toBe('won');
      expect(repo.getTask(taskId)?.status).toBe('usage_limited');
      expect(repo.getTask(taskId)?.restrictions?.resetAt).toBe(resetAt);
    });

    it("returns 'won' refreshing a same-status row with a new payload", () => {
      const taskId = seedLimitedTask('rate_limited', Date.now() + 60_000);
      const laterReset = Date.now() + 300_000;
      const outcome = repo.casStatusWithPayload(taskId, limitableSources, 'rate_limited', {
        restrictions: {
          type: 'rate_limit',
          limit: 'backoff',
          resetAt: laterReset,
          sessionRole: 'worker',
        },
      });
      expect(outcome).toBe('won');
      expect(repo.getTask(taskId)?.restrictions?.resetAt).toBe(laterReset);
    });

    it('clears restrictions, refreshes started_at, and clears completed_at on resume (in_progress)', () => {
      const taskId = seedLimitedTask('usage_limited', Date.now() + 60_000);
      repo.updateTask(taskId, { startedAt: 1000, completedAt: 2000 });
      const before = Date.now();
      const outcome = repo.casStatusWithPayload(taskId, resumeSources, 'in_progress', {
        restrictions: null,
      });
      expect(outcome).toBe('won');
      const restored = repo.getTask(taskId);
      expect(restored?.status).toBe('in_progress');
      expect(restored?.restrictions).toBeNull();
      expect(restored?.startedAt).toBeGreaterThanOrEqual(before);
      expect(restored?.completedAt).toBeNull();
    });

    it("returns 'superseded' and leaves the row unchanged when the status moved first", () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      repo.updateTask(task.id, { status: 'done', result: 'shipped' });
      const before = repo.getTask(task.id);
      const outcome = repo.casStatusWithPayload(task.id, limitableSources, 'rate_limited', {
        restrictions: { type: 'rate_limit', limit: 'backoff', resetAt: 1, sessionRole: 'worker' },
      });
      expect(outcome).toBe('superseded');
      expect(repo.getTask(task.id)).toEqual(before);
    });

    it("returns 'superseded' when resuming a task that is no longer limited", () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      repo.updateTask(task.id, { status: 'blocked', blockReason: 'dependency_failed' });
      expect(
        repo.casStatusWithPayload(task.id, resumeSources, 'in_progress', { restrictions: null })
      ).toBe('superseded');
      expect(repo.getTask(task.id)?.status).toBe('blocked');
    });

    it("returns 'superseded' for an unknown task id", () => {
      expect(
        repo.casStatusWithPayload('nonexistent', resumeSources, 'in_progress', {
          restrictions: null,
        })
      ).toBe('superseded');
    });

    it("returns 'superseded' for an empty expected set without writing", () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      expect(
        repo.casStatusWithPayload(task.id, [], 'rate_limited', {
          restrictions: { type: 'rate_limit', limit: 'x', resetAt: 1, sessionRole: 'worker' },
        })
      ).toBe('superseded');
      expect(repo.getTask(task.id)?.status).toBe('in_progress');
      expect(repo.getTask(task.id)?.restrictions).toBeNull();
    });
  });

  describe('reserveSpawnForTick / releaseSpawnReservation', () => {
    const runningStatuses = ['in_progress', 'review'] as const;

    it('wins the reservation while the task is in a running status', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      expect(repo.reserveSpawnForTick(task.id, runningStatuses)).toBe('won');
    });

    it('park between two sequential spawn attempts: first wins while running, second is superseded and spawns nothing', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      const spawns: string[] = [];

      const first = repo.reserveSpawnForTick(task.id, runningStatuses);
      if (first === 'won') spawns.push('agent-1');

      repo.updateTask(task.id, { status: 'stopped' });

      const second = repo.reserveSpawnForTick(task.id, runningStatuses);
      if (second === 'won') spawns.push('agent-2');

      expect(first).toBe('won');
      expect(second).toBe('superseded');
      expect(spawns).toEqual(['agent-1']);
    });

    it('holds the reservation: a second reserve while running is superseded until release', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      expect(repo.reserveSpawnForTick(task.id, runningStatuses)).toBe('won');
      expect(repo.reserveSpawnForTick(task.id, runningStatuses)).toBe('superseded');
      repo.releaseSpawnReservation(task.id);
      expect(repo.reserveSpawnForTick(task.id, runningStatuses)).toBe('won');
    });

    it("returns 'superseded' when the status is outside the allowed set", () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      expect(repo.reserveSpawnForTick(task.id, runningStatuses)).toBe('superseded');
    });

    it("returns 'superseded' for an unknown task id", () => {
      expect(repo.reserveSpawnForTick('nonexistent', runningStatuses)).toBe('superseded');
    });

    it("returns 'superseded' for an empty allowed set without claiming", () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      expect(repo.reserveSpawnForTick(task.id, [])).toBe('superseded');
      expect(repo.reserveSpawnForTick(task.id, runningStatuses)).toBe('won');
    });

    it('release on an unknown task id does not throw', () => {
      expect(() => repo.releaseSpawnReservation('nonexistent')).not.toThrow();
    });

    it('does not churn updated_at or notify reactive watchers', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      repo.updateTask(task.id, { status: 'in_progress' });
      const before = repo.getTask(task.id);
      const notifiedTables: string[] = [];
      const observingRepo = new SpaceTaskRepository(
        db as any,
        {
          notifyChange: (table: string) => notifiedTables.push(table),
        } as unknown as ReactiveDatabase
      );

      expect(observingRepo.reserveSpawnForTick(task.id, runningStatuses)).toBe('won');
      repo.releaseSpawnReservation(task.id);

      const after = repo.getTask(task.id);
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(after?.status).toBe('in_progress');
      expect(notifiedTables).toEqual([]);
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

    it('archives linked worker sessions', () => {
      const task = repo.createTask({ spaceId, title: 'T', description: '' });
      insertWorkerSession('worker-session-1', task.id);

      repo.archiveTask(task.id);

      const row = db
        .prepare(`SELECT status, archived_at FROM sessions WHERE id = ?`)
        .get('worker-session-1') as { status: string; archived_at: string | null };
      expect(row.status).toBe('archived');
      expect(row.archived_at).toBeTruthy();
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

    it('purges pending message rows when the task is deleted', () => {
      createSearchIndex();
      const task = repo.createTask({
        spaceId,
        title: 'Purge task',
        description: '',
      });
      insertWorkerSession('session-1', task.id);
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, task_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'pending-msg',
        'session-1',
        'user',
        JSON.stringify({
          type: 'user',
          uuid: 'pending-uuid',
          message: { role: 'user', content: [{ type: 'text', text: 'pending purge marker' }] },
        }),
        new Date().toISOString(),
        'consumed',
        task.id
      );
      db.prepare(`INSERT INTO message_search_pending (message_id, created_at) VALUES (?, ?)`).run(
        'pending-msg',
        Date.now()
      );

      repo.deleteTask(task.id);

      expect((db as any).prepare(`SELECT COUNT(*) AS n FROM message_search_pending`).get()).toEqual(
        {
          n: 0,
        }
      );

      const sdkRepo = new SDKMessageRepository(db as any);
      sdkRepo.flushMessageSearchIndex();
      expect(sdkRepo.searchMessages({ query: 'pending purge' }).results).toEqual([]);
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
        `INSERT INTO message_search_content (kind, source_id, message_id, session_id, task_id, space_id, task_number, message_type, title, body, timestamp)
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

    it('removes expired terminal task message rows when task status changes', () => {
      createSearchIndex();
      const task = repo.createTask({
        spaceId,
        title: 'Old task',
        description: '',
        status: 'in_progress',
      });
      db.prepare(
        `INSERT INTO message_search_content (kind, source_id, message_id, session_id, task_id, space_id, task_number, message_type, title, body, timestamp)
				 VALUES ('message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg-old',
        'uuid-old',
        'space:space-1:task:task-1:exec:exec-1',
        task.id,
        spaceId,
        task.taskNumber,
        'user',
        'Old task',
        'expired terminal marker',
        Date.now()
      );
      expect(searchIndexedTaskIds('expired')).toEqual(['msg-old']);

      repo.updateTask(task.id, {
        status: 'done',
        completedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      });

      expect(searchIndexedTaskIds('expired')).toEqual([]);
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
        `INSERT INTO message_search_content (kind, source_id, message_id, session_id, task_id, space_id, task_number, message_type, title, body, timestamp)
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
        `INSERT INTO message_search_content (kind, source_id, message_id, session_id, task_id, space_id, task_number, message_type, title, body, timestamp)
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
      seed('open', 'sess-open');
      seed('done', 'sess-done');
      seed('cancelled', 'sess-cancelled');
      seed('archived', 'sess-archived');

      const active = repo.listActiveWithTaskAgentSession();
      expect(active).toEqual([]);
    });
  });

  describe('listByGoal', () => {
    const goalId = 'goal-pagination';

    function seedTask(title: string, createdAt: number, status: string = 'open'): string {
      const task = repo.createTask({
        spaceId,
        title,
        description: '',
        goalId,
        status: status as any,
      });
      (db as any)
        .prepare(`UPDATE space_tasks SET created_at = ? WHERE id = ?`)
        .run(createdAt, task.id);
      return task.id;
    }

    it('returns only tasks for the goal, ordered by created_at DESC, excluding archived by default', () => {
      const older = seedTask('older', 1000);
      const newer = seedTask('newer', 3000);

      const other = repo.createTask({
        spaceId,
        title: 'other',
        description: '',
        goalId: 'other-goal',
      });
      (db as any).prepare(`UPDATE space_tasks SET created_at = ? WHERE id = ?`).run(6000, other.id);

      const { tasks, total, hasMore } = repo.listByGoal(goalId);
      expect(tasks.map((t) => t.id)).toEqual([newer, older]);
      expect(total).toBe(2);
      expect(hasMore).toBe(false);
    });

    it('filters by status when provided', () => {
      seedTask('open-a', 1000, 'open');
      const done = seedTask('done-b', 2000, 'done');
      seedTask('open-c', 3000, 'open');

      const { tasks, total } = repo.listByGoal(goalId, { status: 'done' });
      expect(tasks.map((t) => t.id)).toEqual([done]);
      expect(total).toBe(1);
    });

    it('includes archived tasks only when status is archived', () => {
      const archived = seedTask('archived-a', 1000, 'archived');
      const open = seedTask('open-b', 2000, 'open');

      const defaultPage = repo.listByGoal(goalId);
      expect(defaultPage.tasks.map((t) => t.id)).toEqual([open]);

      const archivedPage = repo.listByGoal(goalId, { status: 'archived' });
      expect(archivedPage.tasks.map((t) => t.id)).toEqual([archived]);
    });

    it('paginates with a keyset cursor and yields every matching task exactly once', () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(seedTask(`task-${i}`, 1000 + i * 100));
      }
      const expected = [...ids].reverse();

      const collected: string[] = [];
      let before: number | undefined;
      let beforeId: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = repo.listByGoal(goalId, {
          limit: 2,
          before,
          beforeId,
        });
        collected.push(...page.tasks.map((t) => t.id));
        if (!page.hasMore) break;
        const last = page.tasks[page.tasks.length - 1];
        before = last.createdAt;
        beforeId = last.id;
      }

      expect(collected).toEqual(expected);
    });

    it('reports a stable total across pages (independent of the cursor)', () => {
      for (let i = 0; i < 5; i++) seedTask(`task-${i}`, 1000 + i * 100);

      const first = repo.listByGoal(goalId, { limit: 2 });
      expect(first.total).toBe(5);
      expect(first.tasks.length).toBe(2);

      const second = repo.listByGoal(goalId, {
        limit: 2,
        before: first.tasks[first.tasks.length - 1].createdAt,
        beforeId: first.tasks[first.tasks.length - 1].id,
      });
      expect(second.total).toBe(5);
      expect(second.tasks.length).toBe(2);
    });

    it('keeps an updated-but-unseen task in the traversal (immutable created_at key)', () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(seedTask(`task-${i}`, 1000 + i * 100));

      const first = repo.listByGoal(goalId, { limit: 2 });
      const lastUnseen = ids[1];
      (db as any)
        .prepare(`UPDATE space_tasks SET updated_at = ? WHERE id = ?`)
        .run(999999, lastUnseen);

      const collected = [...first.tasks.map((t) => t.id)];
      let before = first.tasks[first.tasks.length - 1].createdAt;
      let beforeId = first.tasks[first.tasks.length - 1].id;
      for (let guard = 0; guard < 10; guard++) {
        const page = repo.listByGoal(goalId, { limit: 10, before, beforeId });
        collected.push(...page.tasks.map((t) => t.id));
        if (!page.hasMore) break;
        const last = page.tasks[page.tasks.length - 1];
        before = last.createdAt;
        beforeId = last.id;
      }

      expect(new Set(collected).size).toBe(ids.length);
      expect(collected).toContain(lastUnseen);
    });

    it('clamps the page size to the bounded range', () => {
      for (let i = 0; i < 5; i++) seedTask(`task-${i}`, 1000 + i * 100);

      const tiny = repo.listByGoal(goalId, { limit: -1 });
      expect(tiny.tasks.length).toBe(1);
      expect(tiny.hasMore).toBe(true);

      const huge = repo.listByGoal(goalId, { limit: 1000 });
      expect(huge.tasks.length).toBe(5);
      expect(huge.hasMore).toBe(false);
    });

    it('does not skip or duplicate tasks when a new task is inserted mid-iteration', () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(seedTask(`task-${i}`, 1000 + i * 100));

      const first = repo.listByGoal(goalId, { limit: 1 });
      expect(first.tasks.length).toBe(1);

      seedTask('late-insert', 9000);

      const collected = [...first.tasks.map((t) => t.id)];
      let before = first.tasks[0].createdAt;
      let beforeId = first.tasks[0].id;
      for (let guard = 0; guard < 10; guard++) {
        const page = repo.listByGoal(goalId, { limit: 1, before, beforeId });
        if (page.tasks.length === 0) break;
        collected.push(page.tasks[0].id);
        before = page.tasks[0].createdAt;
        beforeId = page.tasks[0].id;
        if (!page.hasMore) break;
      }

      expect(collected).toEqual([...ids].reverse());
      expect(new Set(collected).size).toBe(collected.length);
    });
  });
});
