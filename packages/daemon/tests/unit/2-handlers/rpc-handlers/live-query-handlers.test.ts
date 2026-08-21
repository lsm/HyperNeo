import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigration74, runMigrations } from '../../../../src/storage/schema';
import { runMigration191 } from '../../../../src/storage/schema/migrations';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/rpc-handlers/live-query-handlers';
import {
  computeIsRenderable,
  computeIsTerminal,
  extractParentToolUseId,
} from '../../../../src/storage/repositories/sdk-message-repository';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { NeoTask, RoomGoal, Session, SessionConfig, SessionMetadata } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/index';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../../src/storage/live-query';
import type { QueryDiff } from '../../../../src/storage/live-query';

describe('NAMED_QUERY_REGISTRY', () => {
  let db: BunDatabase;
  const roomId = 'room-contract-test';
  const now = Date.now();

  function backfillConversationTurns(): void {
    db.exec(`DROP TABLE IF EXISTS _test_turn_backfill`);
    db.exec(`
      CREATE TEMP TABLE _test_turn_backfill AS
      WITH base AS (
        SELECT
          id, task_id, session_id, timestamp, rowid,
          CASE
            WHEN message_type = 'user'
              AND is_renderable = 1
              AND COALESCE(send_status, 'consumed') IN ('consumed', 'failed')
              THEN 1
            ELSE 0
          END AS is_anchor
        FROM sdk_messages
        WHERE task_id IS NOT NULL
      ),
      anchor_numbered AS (
        SELECT
          id, task_id, session_id, timestamp, rowid, is_anchor,
          SUM(is_anchor) OVER (
            PARTITION BY task_id
            ORDER BY timestamp, rowid
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS global_turn
        FROM base
      )
      SELECT id,
        CASE
          WHEN is_anchor = 1 THEN global_turn
          ELSE COALESCE(
            MAX(CASE WHEN is_anchor = 1 THEN global_turn END) OVER (
              PARTITION BY task_id, session_id
              ORDER BY timestamp, rowid
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ),
            0
          )
        END AS turn_idx
      FROM anchor_numbered
    `);
    db.exec(
      `UPDATE sdk_messages SET conversation_turn_index = b.turn_idx FROM _test_turn_backfill b WHERE sdk_messages.id = b.id`
    );
    db.exec(`DROP TABLE _test_turn_backfill`);
  }

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createTables(db);
    runMigration74(db);
    db.exec(
      `INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test Room', ${now}, ${now})`
    );
  });

  afterEach(() => {
    db.close();
  });

  test('registry contains all expected query names', () => {
    expect(NAMED_QUERY_REGISTRY.has('tasks.byRoom')).toBe(false);
    expect(NAMED_QUERY_REGISTRY.has('tasks.byRoom.all')).toBe(false);
    expect(NAMED_QUERY_REGISTRY.has('goals.byRoom')).toBe(false);
    expect(NAMED_QUERY_REGISTRY.has('sessionGroupMessages.byGroup')).toBe(true);
    expect(NAMED_QUERY_REGISTRY.has('spaceTaskActivity.byTask')).toBe(true);
    expect(NAMED_QUERY_REGISTRY.has('spaceTaskMessages.byTask')).toBe(true);
    expect(NAMED_QUERY_REGISTRY.has('spaceTaskMessages.byTask.compact')).toBe(true);
    expect(NAMED_QUERY_REGISTRY.has('spaceTaskActiveTurn.byTask')).toBe(true);
    expect(NAMED_QUERY_REGISTRY.has('actorMessages.byTask')).toBe(true);
    expect(NAMED_QUERY_REGISTRY.has('actorMessages.byWorkflowRun')).toBe(true);
    expect(NAMED_QUERY_REGISTRY.has('taskMilestones.byTask')).toBe(true);
    expect(NAMED_QUERY_REGISTRY.has('skills.byRoom')).toBe(false);
  });

  test('all registry entries have correct paramCount', () => {
    expect(NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!.paramCount).toBe(1);
    expect(NAMED_QUERY_REGISTRY.get('spaceTaskActivity.byTask')!.paramCount).toBe(1);
    expect(NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!.paramCount).toBe(1);
    expect(NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask.compact')!.paramCount).toBe(1);
    expect(NAMED_QUERY_REGISTRY.get('spaceTaskActiveTurn.byTask')!.paramCount).toBe(1);
    expect(NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!.paramCount).toBe(1);
    expect(NAMED_QUERY_REGISTRY.get('actorMessages.byWorkflowRun')!.paramCount).toBe(3);
    expect(NAMED_QUERY_REGISTRY.get('taskMilestones.byTask')!.paramCount).toBe(1);
  });

  test('retired Room-scoped query names are not active contracts', () => {
    expect([...NAMED_QUERY_REGISTRY.keys()]).not.toContain('tasks.byRoom');
    expect([...NAMED_QUERY_REGISTRY.keys()]).not.toContain('tasks.byRoom.all');
    expect([...NAMED_QUERY_REGISTRY.keys()]).not.toContain('goals.byRoom');
    expect([...NAMED_QUERY_REGISTRY.keys()]).not.toContain('mcpEnablement.byRoom');
    expect([...NAMED_QUERY_REGISTRY.keys()]).not.toContain('skills.byRoom');
  });

  test('nodeExecutions.byRun projects lastActivityAt alongside updatedAt', () => {
    runMigration191(db);
    const workflowRunId = 'run-nodeexec-projection';
    const expectedActivity = now + 12_345;
    db.exec(`
      INSERT INTO node_executions (
        id, workflow_run_id, workflow_node_id, agent_name, agent_id,
        agent_session_id, status, result, created_at, started_at,
        completed_at, updated_at, last_activity_at
      ) VALUES (
        'exec-projection', '${workflowRunId}', 'node-1', 'coder', NULL,
        NULL, 'in_progress', NULL, ${now}, ${now}, NULL, ${now}, ${expectedActivity}
      )
    `);

    const entry = NAMED_QUERY_REGISTRY.get('nodeExecutions.byRun')!;
    const rows = db.prepare(entry.sql).all(workflowRunId) as Record<string, unknown>[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('lastActivityAt', expectedActivity);
    expect(rows[0]).toHaveProperty('updatedAt', now);
  });

  describe.skip('legacy tasks.byRoom registry shape (retired public query)', () => {
    function insertTask(overrides: Record<string, unknown> = {}): string {
      const id = `task-${Date.now()}-${Math.random()}`;
      const status = (overrides.status as string) ?? 'pending';
      db.exec(`
				INSERT INTO tasks (
					id, room_id, title, description, status, priority,
					depends_on, created_at, updated_at
				) VALUES (
					'${id}', '${roomId}', 'Test Task', 'Desc', '${status}', 'normal',
					'${JSON.stringify(overrides.dependsOn ?? [])}', ${now}, ${now}
				)
			`);
      return id;
    }

    function queryAndMap(queryName = 'tasks.byRoom'): Record<string, unknown>[] {
      const entry = NAMED_QUERY_REGISTRY.get(queryName)!;
      const rows = db.prepare(entry.sql).all(roomId) as Record<string, unknown>[];
      return entry.mapRow ? rows.map(entry.mapRow) : rows;
    }

    test('returns camelCase roomId column', () => {
      insertTask();
      const [row] = queryAndMap();
      expect(row).toHaveProperty('roomId', roomId);
      expect(row).not.toHaveProperty('room_id');
    });

    test('returns camelCase createdAt, updatedAt columns', () => {
      insertTask();
      const [row] = queryAndMap();
      expect(row).toHaveProperty('createdAt');
      expect(typeof row.createdAt).toBe('number');
      expect(row).toHaveProperty('updatedAt');
      expect(row).not.toHaveProperty('created_at');
      expect(row).not.toHaveProperty('updated_at');
    });

    test('dependsOn is parsed as string[] (empty array by default)', () => {
      insertTask();
      const [row] = queryAndMap();
      expect(Array.isArray(row.dependsOn)).toBe(true);
      expect(row.dependsOn).toEqual([]);
    });

    test('dependsOn is parsed as string[] with values', () => {
      insertTask({ dependsOn: ['task-a', 'task-b'] });
      const [row] = queryAndMap();
      expect(row.dependsOn).toEqual(['task-a', 'task-b']);
    });

    test('row shape matches NeoTask interface end-to-end', () => {
      insertTask();
      const [row] = queryAndMap();

      const _typed = row as unknown as NeoTask;

      expect(typeof _typed.id).toBe('string');
      expect(typeof _typed.roomId).toBe('string');
      expect(typeof _typed.title).toBe('string');
      expect(typeof _typed.status).toBe('string');
      expect(Array.isArray(_typed.dependsOn)).toBe(true);
    });

    test('ORDER BY is created_at DESC, id DESC (deterministic tiebreaker)', () => {
      const sql = NAMED_QUERY_REGISTRY.get('tasks.byRoom')!.sql;
      expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    });

    test('excludes archived tasks by default', () => {
      insertTask({ status: 'pending' });
      insertTask({ status: 'in_progress' });
      insertTask({ status: 'archived' });
      insertTask({ status: 'completed' });

      const rows = queryAndMap();
      const statuses = rows.map((r) => r.status);
      expect(statuses).not.toContain('archived');
      expect(rows).toHaveLength(3);
    });

    test('tasks.byRoom.all includes archived tasks', () => {
      insertTask({ status: 'pending' });
      insertTask({ status: 'archived' });

      const rows = queryAndMap('tasks.byRoom.all');
      const statuses = rows.map((r) => r.status);
      expect(statuses).toContain('archived');
      expect(statuses).toContain('pending');
      expect(rows).toHaveLength(2);
    });

    test('tasks.byRoom.all has same column shape as tasks.byRoom', () => {
      insertTask();
      const defaultRows = queryAndMap('tasks.byRoom');
      const allRows = queryAndMap('tasks.byRoom.all');
      const defaultKeys = Object.keys(defaultRows[0]).sort();
      const allKeys = Object.keys(allRows[0]).sort();
      expect(allKeys).toEqual(defaultKeys);
    });
  });

  describe('spaceTaskActivity.byTask', () => {
    const spaceId = 'space-live-query-space';
    const sessionId = 'space:task:1';
    const nowIso = new Date(now).toISOString();

    beforeEach(() => {
      db.exec(`
				CREATE TABLE IF NOT EXISTS spaces (
					id TEXT PRIMARY KEY,
					slug TEXT,
					workspace_path TEXT NOT NULL,
					name TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS space_agents (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					name TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS space_workflow_runs (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					workflow_id TEXT NOT NULL,
					title TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					current_step_index INTEGER NOT NULL DEFAULT 0,
					current_step_id TEXT,
					status TEXT NOT NULL DEFAULT 'pending',
					config TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					completed_at INTEGER
				);
				CREATE TABLE IF NOT EXISTS pending_agent_messages (
					id TEXT PRIMARY KEY,
					workflow_run_id TEXT NOT NULL,
					space_id TEXT NOT NULL,
					task_id TEXT,
					source_agent_name TEXT NOT NULL DEFAULT 'task-agent',
					target_kind TEXT NOT NULL,
					target_agent_name TEXT NOT NULL,
					message TEXT NOT NULL,
					idempotency_key TEXT,
					attempts INTEGER NOT NULL DEFAULT 0,
					max_attempts INTEGER NOT NULL DEFAULT 5,
					last_attempt_at INTEGER,
					last_error TEXT,
					status TEXT NOT NULL DEFAULT 'pending',
					delivered_at INTEGER,
					delivered_session_id TEXT,
					expires_at INTEGER NOT NULL,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS workflow_run_artifacts (
					id TEXT PRIMARY KEY NOT NULL,
					run_id TEXT NOT NULL,
					node_id TEXT NOT NULL,
					artifact_type TEXT NOT NULL,
					artifact_key TEXT NOT NULL DEFAULT '',
					data TEXT NOT NULL DEFAULT '{}',
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS space_tasks (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					task_number INTEGER NOT NULL,
					title TEXT NOT NULL,
					description TEXT NOT NULL,
					status TEXT NOT NULL,
					priority TEXT NOT NULL,
					assigned_agent TEXT,
					custom_agent_id TEXT,
					agent_name TEXT,
					completion_summary TEXT,
					workflow_run_id TEXT,
					workflow_node_id TEXT,
					task_agent_session_id TEXT,
					post_approval_session_id TEXT,
					depends_on TEXT NOT NULL DEFAULT '[]',
					current_step TEXT,
					error TEXT,
					result TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				);
			`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id)`);
      db.exec(
        `INSERT OR IGNORE INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
				 VALUES ('${spaceId}', '${spaceId}', '/tmp/test-space', 'Test Space', ${now}, ${now})`
      );
      sessionTaskIds.clear();
    });

    const sessionTaskIds = new Map<string, string>();

    function insertSpaceTask(overrides: Record<string, unknown> = {}): string {
      const id = (overrides.id as string) ?? `space-task-${Date.now()}-${Math.random()}`;
      db.exec(`
				INSERT INTO space_tasks (
					id, space_id, task_number, title, description, status, priority, assigned_agent,
					agent_name, workflow_run_id, workflow_node_id, task_agent_session_id, depends_on,
					created_at, updated_at
				) VALUES (
					'${id}', '${spaceId}', 1, 'Ship UI review', 'Describe progress', '${overrides.status ?? 'in_progress'}',
					'normal', 'coder', ${overrides.agentName ? `'${String(overrides.agentName)}'` : 'NULL'},
					${overrides.workflowRunId ? `'${String(overrides.workflowRunId)}'` : 'NULL'},
					${overrides.workflowNodeId ? `'${String(overrides.workflowNodeId)}'` : 'NULL'},
					${overrides.taskAgentSessionId ? `'${String(overrides.taskAgentSessionId)}'` : 'NULL'},
					'[]', ${now}, ${now}
				)
			`);
      if (overrides.taskAgentSessionId) {
        sessionTaskIds.set(String(overrides.taskAgentSessionId), id);
      }
      return id;
    }

    function insertSession(
      id: string,
      type: string,
      processingState: string,
      sessionContext?: string,
      lastError?: string
    ): void {
      db.exec(`
				INSERT INTO sessions (
					id, title, workspace_path, created_at, last_active_at, status, config, metadata,
					is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id,
					available_commands, processing_state, last_error, archived_at, type, session_context
				) VALUES (
					'${id}', 'Session', '/tmp/test-space', '${nowIso}', '${nowIso}', 'active', '{}', '{}',
					0, NULL, NULL, NULL, NULL, NULL, NULL, '${processingState}', ${
            lastError ? `'${lastError}'` : 'NULL'
          }, NULL, '${type}', '${sessionContext ?? '{}'}'
				)
			`);
    }

    function insertNodeExecution(params: {
      id: string;
      workflowRunId: string;
      workflowNodeId: string;
      agentName: string;
      agentId?: string | null;
      agentSessionId?: string | null;
      status?: string;
      createdAt?: number;
      startedAt?: number;
      updatedAt?: number;
      completedAt?: number | null;
    }): void {
      const {
        id,
        workflowRunId,
        workflowNodeId,
        agentName,
        agentId = null,
        agentSessionId = null,
        status = 'in_progress',
        createdAt = now,
        startedAt = now,
        updatedAt = now,
        completedAt = null,
      } = params;
      db.exec(`
				INSERT INTO node_executions (
					id, workflow_run_id, workflow_node_id, agent_name, agent_id,
					agent_session_id, status, result, created_at, started_at,
					completed_at, updated_at
				) VALUES (
					'${id}', '${workflowRunId}', '${workflowNodeId}', '${agentName}',
					${agentId ? `'${agentId}'` : 'NULL'},
					${agentSessionId ? `'${agentSessionId}'` : 'NULL'},
					'${status}', NULL, ${createdAt}, ${startedAt}, ${completedAt ?? 'NULL'}, ${updatedAt}
				)
			`);
      if (agentSessionId) {
        const tasks = db
          .prepare(
            `SELECT id, task_agent_session_id FROM space_tasks
						 WHERE workflow_run_id IS NOT NULL
						   AND workflow_run_id = ?
						   AND (task_agent_session_id IS NULL OR task_agent_session_id <> ?)`
          )
          .all(workflowRunId, agentSessionId) as Array<{
          id: string;
          task_agent_session_id: string | null;
        }>;
        if (tasks.length > 0) {
          sessionTaskIds.set(agentSessionId, tasks[0].id);
        }
      }
    }

    function insertSdkMessage(id: string, sessionIdValue: string): void {
      const taskIdForSession = sessionTaskIds.get(sessionIdValue) ?? null;
      db.exec(`
				INSERT INTO sdk_messages (
					id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, task_id
				) VALUES (
					'${id}', '${sessionIdValue}', 'assistant', NULL, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
					'${nowIso}', 'consumed', 'system', ${taskIdForSession ? `'${taskIdForSession}'` : 'NULL'}
				)
			`);
    }

    function queryAndMap(taskId: string): Record<string, unknown>[] {
      const entry = NAMED_QUERY_REGISTRY.get('spaceTaskActivity.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      return entry.mapRow ? rows.map(entry.mapRow) : rows;
    }

    function queryMessages(taskId: string): Record<string, unknown>[] {
      const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      return entry.mapRow ? rows.map(entry.mapRow) : rows;
    }

    test('returns live activity rows with derived state and message counts', () => {
      const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
      insertSession(sessionId, 'space_task_agent', '{"status":"processing","phase":"thinking"}');
      insertSdkMessage('sdk-1', sessionId);
      insertSdkMessage('sdk-2', sessionId);

      const [row] = queryAndMap(taskId);
      expect(row.kind).toBe('task_agent');
      expect(row.label).toBe('Task Agent');
      expect(row.state).toBe('active');
      expect(row.processingStatus).toBe('processing');
      expect(row.processingPhase).toBe('thinking');
      expect(row.messageCount).toBe(2);
      expect(row.taskId).toBe(taskId);
      expect(row.taskTitle).toBe('Ship UI review');
    });

    test('surfaces rate-limit cooldown details from processing_state', () => {
      const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
      const retryAt = now + 60_000;
      insertSession(
        sessionId,
        'space_task_agent',
        `{"status":"rate_limit_cooldown","retryCount":2,"maxRetries":5,"retryAt":${retryAt}}`
      );

      const [row] = queryAndMap(taskId);
      expect(row.processingStatus).toBe('rate_limit_cooldown');
      expect(row.state).toBe('cooldown');
      expect(row.rateLimitCooldown).toEqual({
        retryCount: 2,
        maxRetries: 5,
        retryAt,
      });
      expect(row.retryCount).toBeUndefined();
      expect(row.maxRetries).toBeUndefined();
      expect(row.retryAt).toBeUndefined();
    });

    test('rateLimitCooldown is null when cooldown fields are missing', () => {
      const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
      insertSession(sessionId, 'space_task_agent', '{"status":"rate_limit_cooldown"}');

      const [row] = queryAndMap(taskId);
      expect(row.processingStatus).toBe('rate_limit_cooldown');
      expect(row.rateLimitCooldown).toBeNull();
    });

    test('surfaces persisted provider auth error from sessions.last_error', () => {
      const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
      insertSession(
        sessionId,
        'space_task_agent',
        '{"status":"interrupted"}',
        undefined,
        '{"category":"provider_auth_error","message":"Anthropic authentication failed.","providerId":"anthropic"}'
      );

      const [row] = queryAndMap(taskId);
      expect(row.sessionError).toEqual({
        category: 'provider_auth_error',
        message: 'Anthropic authentication failed.',
        providerId: 'anthropic',
      });
    });

    test('sessionError is null when last_error is absent', () => {
      const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
      insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

      const [row] = queryAndMap(taskId);
      expect(row.sessionError).toBeNull();
    });

    test('returns unified task message rows with label and task metadata', () => {
      const taskId = insertSpaceTask({ taskAgentSessionId: sessionId, agentName: 'coder' });
      insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
      insertSdkMessage('sdk-msg-1', sessionId);

      const [row] = queryMessages(taskId);
      expect(row.sessionId).toBe(sessionId);
      expect(row.kind).toBe('task_agent');
      expect(row.label).toBe('Task Agent');
      expect(row.taskId).toBe(taskId);
      expect(row.messageType).toBe('assistant');
      expect(typeof row.content).toBe('string');
      expect((row.content as string).includes('_taskMeta')).toBe(true);
    });

    test('Leg 2 (node_agents): returns node agent activity via node_executions', () => {
      const orchestrationSessionId = 'space:test-space:task:orch-1';
      const nodeSessionId = 'node-agent-session-1';
      const workflowRunId = 'wr-node-agent-test';
      const workflowNodeId = 'node-coder-1';
      const agentName = 'coder';

      const taskId = insertSpaceTask({
        id: 'orch-task-1',
        taskAgentSessionId: orchestrationSessionId,
        workflowRunId,
        status: 'in_progress',
      });

      insertSpaceTask({
        id: 'step-task-1',
        agentName,
        workflowRunId,
        workflowNodeId,
        taskAgentSessionId: nodeSessionId,
        status: 'in_progress',
      });

      insertNodeExecution({
        id: 'ne-1',
        workflowRunId,
        workflowNodeId,
        agentName,
        agentSessionId: nodeSessionId,
        status: 'in_progress',
      });

      insertSession(nodeSessionId, 'worker', '{"status":"processing","phase":"coding"}');
      insertSdkMessage('sdk-node-1', nodeSessionId);
      insertSdkMessage('sdk-node-2', nodeSessionId);

      const rows = queryAndMap(taskId);
      const nodeAgentRow = rows.find((r) => r.kind === 'node_agent');
      expect(nodeAgentRow).toBeDefined();
      expect(nodeAgentRow!.label).toBeTruthy();
      expect(nodeAgentRow!.role).toBe('coder');
      expect(nodeAgentRow!.state).toBe('active');
      expect(nodeAgentRow!.processingStatus).toBe('processing');
      expect(nodeAgentRow!.processingPhase).toBe('coding');
      expect(nodeAgentRow!.messageCount).toBe(2);
      expect(nodeAgentRow!.sessionId).toBe(nodeSessionId);
      expect(nodeAgentRow!.workflowNodeId).toBe(workflowNodeId);
      expect(nodeAgentRow!.agentName).toBe('coder');
    });

    test('post-approval worker (execution-less) is attributed as its declared slot, not "agent"', () => {
      const workflowRunId = 'wr-post-approval';
      const reviewNodeId = 'node-review';
      const reviewerSessionId = 'space:space-1:task:orch-pa:review';
      const orchestrationSessionId = 'space:space-1:task:orch-pa';

      const taskId = insertSpaceTask({
        id: 'orch-task-pa',
        taskAgentSessionId: orchestrationSessionId,
        workflowRunId,
        status: 'in_progress',
      });
      db.prepare(`UPDATE space_tasks SET post_approval_session_id = ? WHERE id = ?`).run(
        reviewerSessionId,
        taskId
      );
      insertSession(orchestrationSessionId, 'space_task_agent', '{"status":"idle"}');

      sessionTaskIds.set(reviewerSessionId, taskId);
      const provenance = {
        source: 'space_agent_custom_prompt',
        hash: 'h',
        agentId: 'agent-reviewer',
        agentName: 'reviewer',
        workflowRunId,
        nodeId: reviewNodeId,
        nodeName: 'Review',
      };
      db.prepare(
        `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, processing_state, type, session_context)
         VALUES (?, 'Reviewer', '/tmp', ?, ?, 'active', '{}', ?, 0, '{}', 'worker', ?)`
      ).run(
        reviewerSessionId,
        nowIso,
        nowIso,
        JSON.stringify({ promptProvenance: provenance }),
        JSON.stringify({ spaceId, taskId })
      );
      db.prepare(
        `INSERT INTO space_agents (id, space_id, name) VALUES ('agent-reviewer', ?, 'Reviewer')`
      ).run(spaceId);
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, task_id)
         VALUES ('sdk-reviewer-1', ?, 'assistant', NULL, ?, ?, 'consumed', NULL, ?)`
      ).run(
        reviewerSessionId,
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'reviewing' }] },
        }),
        nowIso,
        taskId
      );

      const rows = queryAndMap(taskId);
      const reviewerRow = rows.find((r) => r.sessionId === reviewerSessionId);
      expect(reviewerRow).toBeDefined();
      expect(reviewerRow!.kind).toBe('node_agent');
      expect(reviewerRow!.role).toBe('reviewer');
      expect(reviewerRow!.agentName).toBe('reviewer');
      expect(reviewerRow!.label).toBe('Reviewer');
      expect(reviewerRow!.workflowNodeId).toBe(reviewNodeId);
      expect(reviewerRow!.nodeExecutionId).toBeNull();
      expect(reviewerRow!.nodeExecution).toEqual({
        nodeExecutionId: null,
        nodeId: reviewNodeId,
        agentName: 'reviewer',
        status: undefined,
        result: null,
        isCurrentPostApproval: true,
      });

      const msgs = queryMessages(taskId);
      const reviewerMsg = msgs.find((m) => m.sessionId === reviewerSessionId);
      expect(reviewerMsg).toBeDefined();
      expect(reviewerMsg!.kind).toBe('node_agent');
      expect(reviewerMsg!.role).toBe('reviewer');
      expect(reviewerMsg!.label).toBe('Reviewer');

      const actorEntry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const actorRows = (db.prepare(actorEntry.sql).all(taskId) as Record<string, unknown>[]).map(
        (r) => (actorEntry.mapRow ? actorEntry.mapRow(r) : r)
      );
      const reviewerActor = actorRows.find(
        (r) => (r.from as Record<string, unknown> | null)?.sessionId === reviewerSessionId
      );
      expect(reviewerActor).toBeDefined();
      const from = reviewerActor!.from as Record<string, unknown>;
      expect(from.role).toBe('reviewer');
      expect(from.label).toBe('Reviewer');
      expect(from.nodeId).toBe(reviewNodeId);
    });

    test('post-approval worker stays in the activity feed after the task completes (pointer cleared)', () => {
      const workflowRunId = 'wr-post-approval-done';
      const reviewNodeId = 'node-review-done';
      const reviewerSessionId = 'space:space-1:task:orch-pa-done:review';
      const taskId = insertSpaceTask({
        id: 'orch-task-pa-done',
        workflowRunId,
        status: 'done',
      });
      db.prepare(`UPDATE space_tasks SET post_approval_session_id = NULL WHERE id = ?`).run(taskId);
      sessionTaskIds.set(reviewerSessionId, taskId);
      db.prepare(
        `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, processing_state, type, session_context)
         VALUES (?, 'Reviewer', '/tmp', ?, ?, 'active', '{}', ?, 0, '{}', 'worker', ?)`
      ).run(
        reviewerSessionId,
        nowIso,
        nowIso,
        JSON.stringify({
          promptProvenance: {
            source: 'space_agent_custom_prompt',
            hash: 'h',
            agentId: 'agent-reviewer',
            agentName: 'reviewer',
            workflowRunId,
            nodeId: reviewNodeId,
            nodeName: 'Review',
          },
        }),
        JSON.stringify({ spaceId, taskId })
      );
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, task_id)
         VALUES ('sdk-reviewer-done', ?, 'assistant', NULL, ?, ?, 'consumed', NULL, ?)`
      ).run(
        reviewerSessionId,
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'reviewed' }] },
        }),
        nowIso,
        taskId
      );

      const rows = queryAndMap(taskId);
      const reviewerRow = rows.find((r) => r.sessionId === reviewerSessionId);
      expect(reviewerRow).toBeDefined();
      expect(reviewerRow!.kind).toBe('node_agent');
      expect(reviewerRow!.role).toBe('reviewer');
      expect(reviewerRow!.agentName).toBe('reviewer');
      expect(reviewerRow!.workflowNodeId).toBe(reviewNodeId);
    });

    test('Leg 2 (node_agents): skips rows without agent_session_id', () => {
      const workflowRunId = 'wr-no-session-test';
      const taskId = insertSpaceTask({ workflowRunId, status: 'in_progress' });

      insertNodeExecution({
        id: 'ne-no-sess',
        workflowRunId,
        workflowNodeId: 'node-1',
        agentName: 'agent',
        agentSessionId: null,
        status: 'pending',
      });

      const rows = queryAndMap(taskId);
      const nodeAgentRows = rows.filter((r) => r.kind === 'node_agent');
      expect(nodeAgentRows).toHaveLength(0);
    });

    test('includes zero-message sessions in activity set', () => {
      const orchestrationSessionId = 'space:test-space:task:orch-zero';
      const nodeSessionId = 'space:test-space:task:node-zero';
      const workflowRunId = 'wr-zero-msg';
      const taskId = insertSpaceTask({
        taskAgentSessionId: orchestrationSessionId,
        workflowRunId,
        status: 'in_progress',
      });

      insertSession(orchestrationSessionId, 'space_task_agent', '{"status":"processing"}');
      insertSession(nodeSessionId, 'worker', '{"status":"queued"}');

      insertNodeExecution({
        id: 'ne-zero',
        workflowRunId,
        workflowNodeId: 'node-zero',
        agentName: 'coder',
        agentSessionId: nodeSessionId,
        status: 'pending',
      });

      const rows = queryAndMap(taskId);
      expect(rows).toHaveLength(2);
      const orch = rows.find((r) => r.kind === 'task_agent');
      const node = rows.find((r) => r.kind === 'node_agent');
      expect(orch).toBeDefined();
      expect(orch!.sessionId).toBe(orchestrationSessionId);
      expect(orch!.messageCount).toBe(0);
      expect(node).toBeDefined();
      expect(node!.sessionId).toBe(nodeSessionId);
      expect(node!.messageCount).toBe(0);
      expect(node!.label).toBe('Coder');
      expect(node!.role).toBe('coder');
    });

    test('paused task keeps the Task Agent member after task_agent_session_id is cleared', () => {
      const taskAgentSessionId = 'space:test-space:task:orch-paused';
      const taskId = insertSpaceTask({ workflowRunId: 'wr-paused-ta', status: 'open' });
      insertSession(
        taskAgentSessionId,
        'space_task_agent',
        '{"status":"idle"}',
        JSON.stringify({ spaceId, taskId })
      );
      sessionTaskIds.set(taskAgentSessionId, taskId);
      insertSdkMessage('sdk-paused-ta-1', taskAgentSessionId);
      insertSdkMessage('sdk-paused-ta-2', taskAgentSessionId);

      const rows = queryAndMap(taskId);
      const taskAgentRow = rows.find((r) => r.kind === 'task_agent');
      expect(taskAgentRow).toBeDefined();
      expect(taskAgentRow!.sessionId).toBe(taskAgentSessionId);
      expect(taskAgentRow!.label).toBe('Task Agent');
      expect(taskAgentRow!.role).toBe('task-agent');
      expect(taskAgentRow!.state).toBe('idle');
      expect(taskAgentRow!.messageCount).toBe(2);
      expect(taskAgentRow!.taskId).toBe(taskId);
    });

    test('paused task keeps node-agent members after node-execution pointers are nulled', () => {
      const workflowRunId = 'wr-paused-node';
      const coderSessionId = 'space:test-space:task:paused:exec:ne-paused';
      const taskId = insertSpaceTask({ workflowRunId, status: 'open' });

      db.prepare(
        `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, processing_state, type, session_context)
         VALUES (?, 'Coder', '/tmp', ?, ?, 'active', '{}', ?, 0, '{"status":"idle"}', 'worker', ?)`
      ).run(
        coderSessionId,
        nowIso,
        nowIso,
        JSON.stringify({
          promptProvenance: {
            source: 'space_agent_custom_prompt',
            hash: 'h',
            agentId: 'agent-coder',
            agentName: 'coder',
            workflowRunId,
            nodeId: 'node-coder',
            nodeName: 'Coding',
          },
        }),
        JSON.stringify({ spaceId, taskId })
      );
      sessionTaskIds.set(coderSessionId, taskId);
      insertSdkMessage('sdk-paused-node-1', coderSessionId);

      insertNodeExecution({
        id: 'ne-paused',
        workflowRunId,
        workflowNodeId: 'node-coder',
        agentName: 'coder',
        agentSessionId: null,
        status: 'cancelled',
      });

      const rows = queryAndMap(taskId);
      const coderRow = rows.find((r) => r.sessionId === coderSessionId);
      expect(coderRow).toBeDefined();
      expect(coderRow!.kind).toBe('node_agent');
      expect(coderRow!.agentName).toBe('coder');
      expect(coderRow!.workflowNodeId).toBe('node-coder');
      expect(coderRow!.nodeExecutionId).toBeNull();
      expect(coderRow!.state).toBe('idle');
      expect(coderRow!.messageCount).toBe(1);
    });

    test('cancelled task keeps members with history and reports them as interrupted', () => {
      const workflowRunId = 'wr-cancelled-members';
      const taskAgentSessionId = 'space:test-space:task:cancelled:ta';
      const reviewerSessionId = 'space:test-space:task:cancelled:review';
      const taskId = insertSpaceTask({ workflowRunId, status: 'cancelled' });

      insertSession(
        taskAgentSessionId,
        'space_task_agent',
        '{"status":"idle"}',
        JSON.stringify({ spaceId, taskId })
      );
      sessionTaskIds.set(taskAgentSessionId, taskId);
      insertSdkMessage('sdk-cancelled-ta', taskAgentSessionId);

      db.prepare(
        `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, processing_state, type, session_context)
         VALUES (?, 'Reviewer', '/tmp', ?, ?, 'active', '{}', ?, 0, '{"status":"idle"}', 'worker', ?)`
      ).run(
        reviewerSessionId,
        nowIso,
        nowIso,
        JSON.stringify({
          promptProvenance: {
            source: 'space_agent_custom_prompt',
            hash: 'h',
            agentId: 'agent-reviewer',
            agentName: 'reviewer',
            workflowRunId,
            nodeId: 'node-review',
            nodeName: 'Review',
          },
        }),
        JSON.stringify({ spaceId, taskId })
      );
      sessionTaskIds.set(reviewerSessionId, taskId);
      insertSdkMessage('sdk-cancelled-reviewer', reviewerSessionId);

      insertNodeExecution({
        id: 'ne-cancelled',
        workflowRunId,
        workflowNodeId: 'node-review',
        agentName: 'reviewer',
        agentSessionId: null,
        status: 'cancelled',
      });

      const rows = queryAndMap(taskId);
      expect(rows).toHaveLength(2);
      const taskAgentRow = rows.find((r) => r.kind === 'task_agent');
      expect(taskAgentRow!.sessionId).toBe(taskAgentSessionId);
      expect(taskAgentRow!.state).toBe('interrupted');
      const reviewerRow = rows.find((r) => r.sessionId === reviewerSessionId);
      expect(reviewerRow!.kind).toBe('node_agent');
      expect(reviewerRow!.agentName).toBe('reviewer');
      expect(reviewerRow!.state).toBe('interrupted');
    });

    test('Task Agent durable arm does not pull in sessions whose messages belong to another task', () => {
      const taskId = insertSpaceTask({ workflowRunId: 'wr-paused-other', status: 'open' });
      const otherTaskId = insertSpaceTask({
        workflowRunId: 'wr-paused-other',
        status: 'in_progress',
      });
      const taskAgentSessionId = 'space:test-space:task:other-task:ta';
      insertSession(
        taskAgentSessionId,
        'space_task_agent',
        '{"status":"idle"}',
        JSON.stringify({ spaceId, taskId: otherTaskId })
      );
      sessionTaskIds.set(taskAgentSessionId, otherTaskId);
      insertSdkMessage('sdk-other-task-ta', taskAgentSessionId);

      const rows = queryAndMap(taskId);
      expect(rows.find((r) => r.sessionId === taskAgentSessionId)).toBeUndefined();
      const otherRows = queryAndMap(otherTaskId);
      expect(otherRows.find((r) => r.sessionId === taskAgentSessionId)).toBeDefined();
    });

    function insertPendingAgentMessage(overrides: Record<string, unknown>): void {
      db.exec(`
				INSERT INTO pending_agent_messages (
					id, workflow_run_id, space_id, task_id, source_agent_name, target_kind,
					target_agent_name, message, attempts, last_attempt_at, last_error, status,
					delivered_at, delivered_session_id, expires_at, created_at
				) VALUES (
					'${String(overrides.id)}', '${String(overrides.workflowRunId)}', '${spaceId}',
					${overrides.taskId ? `'${String(overrides.taskId)}'` : 'NULL'},
					'${String(overrides.sourceAgentName ?? 'coder')}',
					'${String(overrides.targetKind ?? 'node_agent')}',
					'${String(overrides.targetAgentName ?? 'reviewer')}',
					'${String(overrides.message ?? 'please review').replace(/'/g, "''")}',
					${Number(overrides.attempts ?? 1)},
					${overrides.lastAttemptAt === null ? 'NULL' : Number(overrides.lastAttemptAt ?? now + 5000)},
					${overrides.lastError ? `'${String(overrides.lastError).replace(/'/g, "''")}'` : 'NULL'},
					'${String(overrides.status ?? 'delivered')}',
					${overrides.deliveredAt === null ? 'NULL' : Number(overrides.deliveredAt ?? now + 7000)},
					${overrides.deliveredSessionId ? `'${String(overrides.deliveredSessionId)}'` : 'NULL'},
					${Number(overrides.expiresAt ?? now + 60000)},
					${Number(overrides.createdAt ?? now)}
				)
			`);
    }

    function insertWorkflowRun(id: string): void {
      db.exec(`
				INSERT INTO space_workflow_runs (
					id, space_id, workflow_id, title, description, current_step_index,
					current_step_id, status, config, created_at, updated_at, completed_at
				) VALUES (
					'${id}', '${spaceId}', 'workflow-test', 'Workflow test', '', 0,
					NULL, 'in_progress', '{}', ${now}, ${now}, NULL
				)
			`);
    }

    function insertSdkMessageAt(
      id: string,
      sessionIdValue: string,
      timestampMs: number,
      messageType = 'assistant',
      sendStatus = 'consumed',
      origin = 'system',
      subtype: string | null = null,
      payload?: Record<string, unknown>
    ): void {
      const iso = new Date(timestampMs).toISOString();
      const taskIdForSession = sessionTaskIds.get(sessionIdValue) ?? null;
      const messagePayload = payload ?? {
        type: messageType,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      };
      db.exec(`
				INSERT INTO sdk_messages (
					id, session_id, message_type, message_subtype, sdk_message, timestamp,
					send_status, origin, task_id
				) VALUES (
					'${id}', '${sessionIdValue}', '${messageType}', ${subtype ? `'${subtype}'` : 'NULL'},
					'${JSON.stringify(messagePayload)}',
					'${iso}', '${sendStatus}', '${origin}', ${taskIdForSession ? `'${taskIdForSession}'` : 'NULL'}
				)
			`);
    }

    test('actorMessages.byTask timestamps delivery outcomes by attempt time', () => {
      const workflowRunId = 'wr-actor-task';
      const taskId = insertSpaceTask({ id: 'actor-task', workflowRunId, status: 'in_progress' });
      insertPendingAgentMessage({
        id: 'pm-delivered',
        workflowRunId,
        taskId,
        status: 'delivered',
        createdAt: now + 1000,
        lastAttemptAt: now + 9000,
        deliveredAt: now + 7000,
      });

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped).toHaveLength(1);
      expect(mapped[0].id).toBe('delivery:pm-delivered');
      expect(mapped[0].createdAt).toBe(now + 9000);
    });

    test('actorMessages.byTask describes failed user sends as failures', () => {
      const workflowRunId = 'wr-failed-user-send';
      const sessionIdValue = 'session-failed-user-send';
      const taskId = insertSpaceTask({
        id: 'task-failed-user-send',
        workflowRunId,
        status: 'in_progress',
      });
      sessionTaskIds.set(sessionIdValue, taskId);
      insertSdkMessageAt(
        'sdk-failed-user-send',
        sessionIdValue,
        now + 1000,
        'user',
        'failed',
        'human'
      );

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped).toHaveLength(1);
      expect(mapped[0].id).toBe('msg:sdk-failed-user-send');
      expect(mapped[0].deliveryState).toBe('failed');
      expect(mapped[0].severity).toBe('error');
      expect(mapped[0].summary).toBe('Human message failed');
    });

    test('actorMessages.byTask marks failed GitHub events as failed deliveries', () => {
      const workflowRunId = 'wr-failed-github-event';
      const taskId = insertSpaceTask({
        id: 'task-failed-github-event',
        workflowRunId,
        status: 'in_progress',
      });
      db.exec(`
				INSERT INTO space_github_events (
					id, space_id, task_id, source, delivery_id, event_type, action,
					repo_owner, repo_name, pr_number, pr_url, actor, actor_type,
					body, summary, external_url, external_id, occurred_at, dedupe_key,
					raw_payload, state, created_at, updated_at
				) VALUES (
					'github-failed-event', '${spaceId}', '${taskId}', 'webhook', 'delivery-1',
					'pull_request_review_comment', 'created', 'lsm', 'neokai', 1965,
					'https://github.com/lsm/neokai/pull/1965', 'reviewer', 'User', '',
					'GitHub route failed', 'https://github.com/lsm/neokai/pull/1965#discussion',
					'comment-1', ${now + 1000}, 'github-failed-event', '{}', 'failed',
					${now + 1000}, ${now + 1000}
				)
			`);

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped).toHaveLength(1);
      expect(mapped[0].id).toBe('github:github-failed-event');
      expect(mapped[0].deliveryState).toBe('failed');
      expect(mapped[0].severity).toBe('error');
    });

    test('spaceTaskMessages.byTask maps user-message send_status to the delivery lifecycle + retrying', () => {
      const workflowRunId = 'wr-stm-delivery';
      const sessionIdValue = 'session-stm-delivery';
      const taskId = insertSpaceTask({
        id: 'task-stm-delivery',
        workflowRunId,
        status: 'in_progress',
      });
      sessionTaskIds.set(sessionIdValue, taskId);
      const userPayload = (uuid: string) => ({
        type: 'user',
        uuid,
        message: { role: 'user', content: [{ type: 'text', text: 'handoff' }] },
      });
      const cases: Array<{ id: string; uuid: string; sendStatus: string; expected: string }> = [
        {
          id: 'stm-consumed',
          uuid: 'u-stm-consumed',
          sendStatus: 'consumed',
          expected: 'delivered',
        },
        { id: 'stm-deferred', uuid: 'u-stm-deferred', sendStatus: 'deferred', expected: 'queued' },
        { id: 'stm-enqueued', uuid: 'u-stm-enqueued', sendStatus: 'enqueued', expected: 'queued' },
        {
          id: 'stm-submitted',
          uuid: 'u-stm-submitted',
          sendStatus: 'submitted',
          expected: 'processing',
        },
        { id: 'stm-failed', uuid: 'u-stm-failed', sendStatus: 'failed', expected: 'failed' },
        { id: 'stm-retry', uuid: 'u-stm-retry', sendStatus: 'enqueued', expected: 'retrying' },
      ];
      for (const c of cases) {
        insertSdkMessageAt(
          c.id,
          sessionIdValue,
          now + 1000,
          'user',
          c.sendStatus,
          'human',
          null,
          userPayload(c.uuid)
        );
        db.prepare(`UPDATE sdk_messages SET sdk_uuid = ? WHERE id = ?`).run(c.uuid, c.id);
      }
      db.prepare(
        `INSERT INTO job_queue (id, queue, status, payload, retry_count, max_retries, run_at, created_at)
         VALUES (?, 'message_delivery', 'pending', ?, 1, 8, ?, ?)`
      ).run(
        'job-stm-retry',
        JSON.stringify({
          sessionId: sessionIdValue,
          messageUuid: 'u-stm-retry',
          role: 'turn',
          origin: 'space_inject',
        }),
        now,
        now
      );

      const byId = new Map(queryMessages(taskId).map((r) => [r.id as string, r]));
      for (const c of cases) {
        expect((byId.get(c.id) as Record<string, unknown> | undefined)?.deliveryState).toBe(
          c.expected
        );
      }
    });

    test('a pending user row does not become the turnId for subsequent assistant rows (full feed)', () => {
      const workflowRunId = 'wr-stm-sentinel';
      const sessionIdValue = 'session-stm-sentinel';
      const taskId = insertSpaceTask({
        id: 'task-stm-sentinel',
        workflowRunId,
        status: 'in_progress',
      });
      sessionTaskIds.set(sessionIdValue, taskId);
      const userPayload = (uuid: string) => ({
        type: 'user',
        uuid,
        message: { role: 'user', content: 'x' },
      });
      insertSdkMessageAt(
        'anchor',
        sessionIdValue,
        now + 1000,
        'user',
        'consumed',
        'human',
        null,
        userPayload('u-anchor')
      );
      insertSdkMessageAt(
        'pending',
        sessionIdValue,
        now + 2000,
        'user',
        'enqueued',
        'human',
        null,
        userPayload('u-pending')
      );
      insertSdkMessageAt('assist', sessionIdValue, now + 3000, 'assistant', 'consumed', 'system');

      const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      const assistRow = rows.find((r) => r.id === 'assist');
      expect(assistRow).toBeTruthy();
      expect(assistRow!.turnUserMessageId).toBe('anchor');
    });

    test('actorMessages.byTask does not fan out SDK rows across node execution history', () => {
      const workflowRunId = 'wr-actor-sdk';
      const nodeSessionId = 'node-agent-actor-sdk';
      const taskId = insertSpaceTask({
        id: 'actor-sdk-task',
        workflowRunId,
        status: 'in_progress',
      });
      insertSession(nodeSessionId, 'worker', '{"status":"processing"}');
      sessionTaskIds.set(nodeSessionId, taskId);
      insertNodeExecution({
        id: 'actor-sdk-old',
        workflowRunId,
        workflowNodeId: 'node-coder-old',
        agentName: 'coder-old',
        agentSessionId: nodeSessionId,
        status: 'done',
      });
      insertNodeExecution({
        id: 'actor-sdk-current',
        workflowRunId,
        workflowNodeId: 'node-coder-current',
        agentName: 'coder-current',
        agentSessionId: nodeSessionId,
        status: 'in_progress',
      });
      insertSdkMessageAt('sdk-actor-one', nodeSessionId, now + 1000);

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped).toHaveLength(1);
      expect(mapped[0].id).toBe('msg:sdk-actor-one');
      expect((mapped[0].from as Record<string, unknown>).nodeExecutionId).toBe('actor-sdk-current');
    });

    test('actorMessages.byTask includes operational SDK rows', () => {
      const workflowRunId = 'wr-actor-operational';
      const nodeSessionId = 'node-agent-actor-operational';
      const taskId = insertSpaceTask({
        id: 'actor-operational-task',
        workflowRunId,
        status: 'in_progress',
      });
      insertSession(nodeSessionId, 'worker', '{"status":"processing"}');
      sessionTaskIds.set(nodeSessionId, taskId);
      insertSdkMessageAt('sdk-visible', nodeSessionId, now + 1000);
      const operationalRows = [
        {
          subtype: 'thinking_tokens',
          payload: {
            type: 'system',
            subtype: 'thinking_tokens',
            estimated_tokens: 1200,
            estimated_tokens_delta: 50,
          },
        },
        {
          subtype: 'session_state_changed',
          payload: { type: 'system', subtype: 'session_state_changed', state: 'running' },
        },
        {
          subtype: 'commands_changed',
          payload: {
            type: 'system',
            subtype: 'commands_changed',
            commands: [{ name: 'review' }, { name: 'test' }],
          },
        },
      ];
      for (const { subtype, payload } of operationalRows) {
        insertSdkMessageAt(
          `sdk-operational-${subtype}`,
          nodeSessionId,
          now + 2000,
          'system',
          'consumed',
          'system',
          subtype,
          payload
        );
      }

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped.map((row) => row.id)).toEqual([
        'msg:sdk-visible',
        'msg:sdk-operational-commands_changed',
        'msg:sdk-operational-session_state_changed',
        'msg:sdk-operational-thinking_tokens',
      ]);
      expect(mapped.find((row) => row.id === 'msg:sdk-operational-thinking_tokens')).toMatchObject({
        title: 'System event',
        summary: 'system',
      });
      expect(
        mapped.find((row) => row.id === 'msg:sdk-operational-session_state_changed')
      ).toMatchObject({
        title: 'Session state',
        summary: 'running',
      });
      expect(mapped.find((row) => row.id === 'msg:sdk-operational-commands_changed')).toMatchObject(
        {
          title: 'Commands changed',
          summary: '2 slash commands available',
        }
      );
    });

    test('actorMessages.byTask renders api_retry with attempt/delay/status details', () => {
      const workflowRunId = 'wr-actor-api-retry';
      const nodeSessionId = 'node-agent-actor-api-retry';
      const taskId = insertSpaceTask({
        id: 'actor-api-retry-task',
        workflowRunId,
        status: 'in_progress',
      });
      insertSession(nodeSessionId, 'worker', '{"status":"processing"}');
      sessionTaskIds.set(nodeSessionId, taskId);
      insertSdkMessageAt('sdk-visible', nodeSessionId, now + 1000);
      insertSdkMessageAt(
        'sdk-api-retry',
        nodeSessionId,
        now + 2000,
        'system',
        'consumed',
        'system',
        'api_retry',
        {
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 3,
          retry_delay_ms: 5000,
          error_status: 429,
          error: 'rate_limit',
        }
      );

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped.map((row) => row.id)).toEqual(['msg:sdk-visible', 'msg:sdk-api-retry']);
      expect(mapped.find((row) => row.id === 'msg:sdk-api-retry')).toMatchObject({
        title: 'API retry',
        summary: expect.stringContaining('delay 5000ms'),
      });
    });

    test('actorMessages.byTask filters SDK-only system rows and projects visible notices', () => {
      const workflowRunId = 'wr-actor-system-visibility';
      const nodeSessionId = 'node-agent-actor-system-visibility';
      const taskId = insertSpaceTask({
        id: 'actor-system-visibility-task',
        workflowRunId,
        status: 'in_progress',
      });
      insertSession(nodeSessionId, 'worker', '{"status":"processing"}');
      sessionTaskIds.set(nodeSessionId, taskId);
      insertSdkMessageAt('sdk-visible', nodeSessionId, now + 1000);
      insertSdkMessageAt(
        'sdk-hidden-info',
        nodeSessionId,
        now + 2000,
        'system',
        'consumed',
        'system',
        'informational',
        {
          type: 'system',
          subtype: 'informational',
          level: 'info',
          content: 'transcript-only',
        }
      );
      insertSdkMessageAt(
        'sdk-visible-warning',
        nodeSessionId,
        now + 3000,
        'system',
        'consumed',
        'system',
        'informational',
        {
          type: 'system',
          subtype: 'informational',
          level: 'warning',
          content: 'Hook warning shown to the user',
        }
      );
      insertSdkMessageAt(
        'sdk-stale-shutdown',
        nodeSessionId,
        now + 4000,
        'system',
        'consumed',
        'system',
        'worker_shutting_down',
        { type: 'system', subtype: 'worker_shutting_down', reason: 'host_exit' }
      );
      insertSdkMessageAt('sdk-after-shutdown', nodeSessionId, now + 5000);

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped.map((row) => row.id)).toEqual([
        'msg:sdk-visible',
        'msg:sdk-visible-warning',
        'msg:sdk-after-shutdown',
      ]);
      expect(mapped.find((row) => row.id === 'msg:sdk-visible-warning')).toMatchObject({
        title: 'Warning',
        summary: 'Hook warning shown to the user',
      });
    });

    test('actorMessages.byTask keeps a session shutdown tail until its own session settles', () => {
      const workflowRunId = 'wr-actor-shutdown-scope';
      const sessionA = 'node-agent-shutdown-scope-a';
      const sessionB = 'node-agent-shutdown-scope-b';
      const taskId = insertSpaceTask({
        id: 'actor-shutdown-scope-task',
        workflowRunId,
        status: 'in_progress',
      });
      insertSession(sessionA, 'worker', '{"status":"processing"}');
      insertSession(sessionB, 'worker', '{"status":"processing"}');
      sessionTaskIds.set(sessionA, taskId);
      sessionTaskIds.set(sessionB, taskId);
      insertSdkMessageAt(
        'shutdown-tail-a',
        sessionA,
        now + 1000,
        'system',
        'consumed',
        'system',
        'worker_shutting_down',
        { type: 'system', subtype: 'worker_shutting_down', reason: 'host_exit' }
      );
      insertSdkMessageAt('later-in-b', sessionB, now + 2000);
      insertSdkMessageAt(
        'queued-user-a',
        sessionA,
        now + 3000,
        'user',
        'enqueued',
        'system',
        null,
        { type: 'user', uuid: 'u-queued-user-a', message: { role: 'user', content: 'queued' } }
      );

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const queryRows = () => {
        const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
        return entry.mapRow ? rows.map(entry.mapRow) : rows;
      };

      expect(queryRows().map((row) => row.id)).toEqual(['msg:shutdown-tail-a', 'msg:later-in-b']);

      db.prepare(`UPDATE sdk_messages SET send_status = 'consumed' WHERE id = ?`).run(
        'queued-user-a'
      );

      expect(queryRows().map((row) => row.id)).toEqual(['msg:later-in-b', 'msg:queued-user-a']);
    });

    test('task feeds resolve the shutdown boundary in one materialized pass', () => {
      const taskId = insertSpaceTask({ id: 'shutdown-plan-task', status: 'in_progress' });
      for (const name of [
        'actorMessages.byTask',
        'spaceTaskMessages.byTask',
        'spaceTaskMessages.byTask.compact',
      ]) {
        const entry = NAMED_QUERY_REGISTRY.get(name)!;
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(taskId) as Array<{
          detail: string;
        }>;
        const details = plan.map((row) => row.detail).join('\n');
        expect(details).toContain('MATERIALIZE task_shutdown_boundaries');
        expect(details).not.toContain('MULTI-INDEX OR');
        expect(details).not.toMatch(/\bnewer\b/);
      }
    });

    test('actorMessages.byTask includes rows retracted by refusal fallback notices', () => {
      const workflowRunId = 'wr-actor-retracted';
      const nodeSessionId = 'node-agent-actor-retracted';
      const taskId = insertSpaceTask({
        id: 'actor-retracted-task',
        workflowRunId,
        status: 'in_progress',
      });
      insertSession(nodeSessionId, 'worker', '{"status":"processing"}');
      sessionTaskIds.set(nodeSessionId, taskId);
      insertSdkMessageAt(
        'row-retracted',
        nodeSessionId,
        now + 1000,
        'assistant',
        'consumed',
        'system',
        null,
        {
          type: 'assistant',
          uuid: 'sdk-retracted',
          message: { role: 'assistant', content: [{ type: 'text', text: 'retracted' }] },
        }
      );
      insertSdkMessageAt(
        'row-superseded',
        nodeSessionId,
        now + 1500,
        'assistant',
        'consumed',
        'system',
        null,
        {
          type: 'assistant',
          uuid: 'sdk-superseded',
          message: { role: 'assistant', content: [{ type: 'text', text: 'superseded' }] },
        }
      );
      insertSdkMessageAt('sdk-visible-after-retry', nodeSessionId, now + 2000);
      insertSdkMessageAt(
        'sdk-fallback-notice',
        nodeSessionId,
        now + 3000,
        'system',
        'consumed',
        'system',
        'model_refusal_fallback',
        {
          type: 'system',
          subtype: 'model_refusal_fallback',
          retracted_message_uuids: ['sdk-retracted'],
        }
      );
      insertSdkMessageAt(
        'sdk-superseding-message',
        nodeSessionId,
        now + 4000,
        'assistant',
        'consumed',
        'system',
        null,
        {
          type: 'assistant',
          uuid: 'sdk-superseding-message',
          supersedes: ['sdk-superseded'],
          message: { role: 'assistant', content: [{ type: 'text', text: 'replacement' }] },
        }
      );
      db.prepare(
        `UPDATE sdk_messages
            SET sdk_uuid = CASE id
              WHEN 'row-retracted' THEN 'sdk-retracted'
              WHEN 'row-superseded' THEN 'sdk-superseded'
              ELSE sdk_uuid
            END,
                replacement_metadata_normalized = 1
          WHERE id IN ('row-retracted', 'row-superseded')`
      ).run();
      db.prepare(
        `INSERT INTO sdk_message_replacements (
           source_message_id, session_id, task_id, target_uuid, kind
         ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
      ).run(
        'sdk-fallback-notice',
        nodeSessionId,
        taskId,
        'sdk-retracted',
        'retracted',
        'sdk-superseding-message',
        nodeSessionId,
        taskId,
        'sdk-superseded',
        'superseded'
      );

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped.map((row) => row.id)).toEqual([
        'msg:row-retracted',
        'msg:row-superseded',
        'msg:sdk-visible-after-retry',
        'msg:sdk-fallback-notice',
        'msg:sdk-superseding-message',
      ]);
      expect(mapped.find((row) => row.id === 'msg:row-retracted')).toMatchObject({
        title: 'Retracted Answer',
        details: 'Retracted by a later model fallback.',
        severity: 'warning',
      });
      expect(mapped.find((row) => row.id === 'msg:row-superseded')).toMatchObject({
        title: 'Superseded Answer',
        details: 'Superseded by a later SDK message.',
        severity: 'warning',
      });
    });

    test('actorMessages.byTask resolves replacements without correlated message scans', () => {
      const taskId = insertSpaceTask({
        id: 'actor-replacement-plan-task',
        taskAgentSessionId: 'actor-replacement-plan-session',
        status: 'in_progress',
      });
      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;

      const insertMessages = db.transaction(() => {
        for (let index = 0; index < 1000; index++) {
          insertSdkMessageAt(
            `actor-plan-row-${index}`,
            'actor-replacement-plan-session',
            now + index,
            'assistant',
            'consumed',
            'system',
            null,
            {
              type: 'assistant',
              uuid: `actor-plan-sdk-${index}`,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: `message ${index}` }],
              },
            }
          );
        }
      });
      insertMessages();

      const plan = db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(taskId) as Array<{
        detail: string;
      }>;
      const correlatedScans = plan.filter((step) =>
        step.detail.includes('CORRELATED SCALAR SUBQUERY')
      );
      expect(correlatedScans).toHaveLength(0);
      expect(entry.sql).toContain('sdk_message_replacements');
      expect(entry.sql).not.toContain('$.retracted_message_uuids');
      expect(entry.sql).not.toContain('$.supersedes');

      const rows = db.prepare(entry.sql).all(taskId);

      expect(rows).toHaveLength(1000);
    });

    test('actorMessages.byWorkflowRun does not fan out node or artifact rows across tasks', () => {
      const workflowRunId = 'wr-actor-run';
      insertWorkflowRun(workflowRunId);
      insertSpaceTask({ id: 'actor-run-task-a', workflowRunId, status: 'in_progress' });
      insertSpaceTask({ id: 'actor-run-task-b', workflowRunId, status: 'in_progress' });
      insertNodeExecution({
        id: 'actor-node',
        workflowRunId,
        workflowNodeId: 'node-coder',
        agentName: 'coder',
        status: 'in_progress',
      });
      db.exec(`
				INSERT INTO workflow_run_artifacts (
					id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at
				) VALUES (
					'artifact-actor', '${workflowRunId}', 'node-coder', 'result', '', '{}', ${now + 2000}, ${now + 2000}
				)
			`);

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byWorkflowRun')!;
      const rows = db.prepare(entry.sql).all(workflowRunId, workflowRunId, workflowRunId) as Record<
        string,
        unknown
      >[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped.map((row) => row.id)).toEqual([
        'node:actor-node:in_progress',
        'artifact:artifact-actor',
      ]);
      expect(new Set(mapped.map((row) => row.id)).size).toBe(2);
    });

    test('actorMessages.byWorkflowRun preserves node handoff event for completed nodes', () => {
      const workflowRunId = 'wr-node-history';
      insertWorkflowRun(workflowRunId);
      insertSpaceTask({ id: 'actor-history-task', workflowRunId, status: 'in_progress' });
      insertNodeExecution({
        id: 'actor-node-history',
        workflowRunId,
        workflowNodeId: 'node-coder',
        agentName: 'coder',
        status: 'done',
      });

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byWorkflowRun')!;
      const rows = db.prepare(entry.sql).all(workflowRunId, workflowRunId, workflowRunId) as Record<
        string,
        unknown
      >[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped.map((row) => row.id).sort()).toEqual([
        'node:actor-node-history:done',
        'node:actor-node-history:in_progress',
      ]);
      expect(new Set(mapped.map((row) => row.title))).toEqual(
        new Set(['Node handoff', 'Node completed'])
      );
    });

    test('actorMessages.byWorkflowRun timestamps retry node states by update time', () => {
      const workflowRunId = 'wr-node-retry-timing';
      insertWorkflowRun(workflowRunId);
      insertSpaceTask({ id: 'actor-retry-task', workflowRunId, status: 'in_progress' });
      insertNodeExecution({
        id: 'actor-node-pending',
        workflowRunId,
        workflowNodeId: 'node-coder-pending',
        agentName: 'reviewer',
        status: 'pending',
        createdAt: now + 3000,
        startedAt: now + 4000,
        updatedAt: now + 11000,
      });
      db.exec(`
				PRAGMA ignore_check_constraints = ON;
				INSERT INTO node_executions (
					id, workflow_run_id, workflow_node_id, agent_name, agent_id,
					agent_session_id, status, result, created_at, started_at,
					completed_at, updated_at
				) VALUES (
					'actor-node-waiting', '${workflowRunId}', 'node-coder-waiting', 'coder',
					NULL, NULL, 'waiting_rebind', NULL, ${now + 1000}, ${now + 2000},
					NULL, ${now + 9000}
				);
				PRAGMA ignore_check_constraints = OFF;
			`);

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byWorkflowRun')!;
      const rows = db.prepare(entry.sql).all(workflowRunId, workflowRunId, workflowRunId) as Record<
        string,
        unknown
      >[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;
      const byId = new Map(mapped.map((row) => [row.id, row]));

      expect(byId.get('node:actor-node-waiting:waiting_rebind')?.createdAt).toBe(now + 9000);
      expect(byId.get('node:actor-node-pending:pending')?.createdAt).toBe(now + 11000);
    });

    describe('taskMilestones.byTask', () => {
      beforeEach(() => {
        const present = new Set(
          (db.prepare('PRAGMA table_info(space_tasks)').all() as Array<{ name: string }>).map(
            (c) => c.name
          )
        );
        const ensure = (col: string, type: string): void => {
          if (!present.has(col)) db.exec(`ALTER TABLE space_tasks ADD COLUMN ${col} ${type}`);
        };
        ensure('started_at', 'INTEGER');
        ensure('completed_at', 'INTEGER');
        ensure('approved_at', 'INTEGER');
        ensure('approval_source', 'TEXT');
        ensure('approval_reason', 'TEXT');
        ensure('pending_completion_submitted_at', 'INTEGER');
        ensure('pending_completion_reason', 'TEXT');
        ensure('pending_completion_submitted_by_node_id', 'TEXT');
        ensure('created_by', 'TEXT');
        ensure('block_reason', 'TEXT');
        ensure('archived_at', 'INTEGER');
        db.exec(`
					CREATE TABLE IF NOT EXISTS space_external_events (
						id TEXT PRIMARY KEY, space_id TEXT NOT NULL, source TEXT NOT NULL, topic TEXT NOT NULL,
						dedupe_key TEXT NOT NULL, occurred_at INTEGER NOT NULL, ingested_at INTEGER NOT NULL,
						source_event_id TEXT, summary TEXT NOT NULL, external_url TEXT, payload_json TEXT NOT NULL,
						state TEXT NOT NULL DEFAULT 'published', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
					)
				`);
        db.exec(`
					CREATE TABLE IF NOT EXISTS space_external_event_deliveries (
						event_id TEXT NOT NULL, delivery_key TEXT NOT NULL, workflow_run_id TEXT NOT NULL,
						task_id TEXT NOT NULL, node_id TEXT NOT NULL, agent_name TEXT NOT NULL,
						state TEXT NOT NULL DEFAULT 'pending', failure_reason TEXT, delivered_at INTEGER,
						updated_at INTEGER NOT NULL, PRIMARY KEY(event_id, delivery_key)
					)
				`);
      });

      function queryMilestones(taskId: string): Record<string, unknown>[] {
        const entry = NAMED_QUERY_REGISTRY.get('taskMilestones.byTask')!;
        const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
        return entry.mapRow ? rows.map(entry.mapRow) : rows;
      }

      function insertArtifact(
        id: string,
        workflowRunId: string,
        artifactType: string,
        data: Record<string, unknown>,
        createdAtMs: number,
        nodeId = 'coder-node'
      ): void {
        db.exec(`
					INSERT INTO workflow_run_artifacts (
						id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at
					) VALUES (
						'${id}', '${workflowRunId}', '${nodeId}', '${artifactType}', '',
						'${JSON.stringify(data)}', ${createdAtMs}, ${createdAtMs}
					)
				`);
      }

      function insertGithubEvent(
        id: string,
        taskId: string,
        topic: string,
        summary: string,
        state: string,
        occurredAt: number,
        workflowRunId = 'wr-ms-github'
      ): void {
        db.exec(`
					INSERT INTO space_external_events (
						id, space_id, source, topic, dedupe_key, occurred_at, ingested_at,
						summary, external_url, payload_json, state, created_at, updated_at
					) VALUES (
						'${id}', '${spaceId}', 'github', '${topic}', 'dk-${id}', ${occurredAt}, ${occurredAt},
						'${summary}', '', '{}', '${state}', ${occurredAt}, ${occurredAt}
					)
				`);
        db.exec(`
					INSERT INTO space_external_event_deliveries (
						event_id, delivery_key, workflow_run_id, task_id, node_id, agent_name, state, updated_at
					) VALUES (
						'${id}', 'dk-${id}', '${workflowRunId}', '${taskId}', 'coder-node', 'coder', 'delivered', ${occurredAt}
					)
				`);
      }

      test('emits creation milestone for a fresh task (feed never empty)', () => {
        const taskId = insertSpaceTask({ id: 'ms-fresh', status: 'open' });
        const rows = queryMilestones(taskId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          category: 'creation',
          tone: 'info',
          title: 'Task created',
        });
        expect(rows[0].createdAt).toBe(now);
      });

      test('derives status anchors from space_tasks lifecycle timestamps', () => {
        const taskId = insertSpaceTask({ id: 'ms-lifecycle', status: 'done' });
        db.exec(`
					UPDATE space_tasks
					SET started_at = ${now + 1000},
					    pending_completion_submitted_at = ${now + 2000},
					    approved_at = ${now + 3000}, approval_source = 'human', approval_reason = 'lgtm',
					    completed_at = ${now + 4000}
					WHERE id = '${taskId}'
				`);
        const rows = queryMilestones(taskId);
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get('task:created')?.category).toBe('creation');
        expect(byId.get('task:started')).toMatchObject({
          category: 'status',
          tone: 'progress',
          title: 'Work started',
        });
        expect(byId.get('task:review')).toMatchObject({
          category: 'status',
          tone: 'warning',
          title: 'Submitted for review',
        });
        expect(byId.get('task:approved')).toMatchObject({
          category: 'status',
          tone: 'success',
          title: 'Approved',
          body: 'lgtm',
        });
        expect(byId.get('task:completed')).toMatchObject({
          category: 'status',
          tone: 'success',
          title: 'Completed',
        });
        const times = rows.map((r) => r.createdAt as number);
        expect([...times].sort((a, b) => a - b)).toEqual(times);
      });

      test('renders a blocked task as Blocked (not Completed)', () => {
        const taskId = insertSpaceTask({ id: 'ms-blocked', status: 'blocked' });
        db.exec(`
					UPDATE space_tasks
					SET completed_at = ${now + 1000}, block_reason = 'awaiting human input'
					WHERE id = '${taskId}'
				`);
        const rows = queryMilestones(taskId);
        const blocked = rows.find((r) => r.id === 'task:blocked');
        expect(blocked).toMatchObject({
          category: 'status',
          tone: 'warning',
          title: 'Blocked',
          body: 'awaiting human input',
        });
        expect(rows.find((r) => r.id === 'task:completed')).toBeUndefined();
      });

      test('emits a Blocked milestone even when completed_at is cleared (prompt-overflow block)', () => {
        const taskId = insertSpaceTask({ id: 'ms-blocked-cleared', status: 'blocked' });
        db.exec(`
					UPDATE space_tasks
					SET completed_at = NULL, updated_at = ${now + 2000}, block_reason = 'execution_failed'
					WHERE id = '${taskId}'
				`);
        const rows = queryMilestones(taskId);
        const blocked = rows.find((r) => r.id === 'task:blocked');
        expect(blocked).toMatchObject({
          category: 'status',
          tone: 'warning',
          title: 'Blocked',
          body: 'execution_failed',
          createdAt: now + 2000,
        });
      });

      test('renders the completed milestone with SpaceTask.result as its body', () => {
        const taskId = insertSpaceTask({ id: 'ms-result', status: 'done' });
        db.exec(`
					UPDATE space_tasks
					SET completed_at = ${now + 1000}, result = 'Shipped the curated timeline'
					WHERE id = '${taskId}'
				`);
        const rows = queryMilestones(taskId);
        const completed = rows.find((r) => r.id === 'task:completed');
        expect(completed).toMatchObject({
          category: 'status',
          tone: 'success',
          title: 'Completed',
          body: 'Shipped the curated timeline',
        });
      });

      test('does not emit Completed for a surviving completed_at during review', () => {
        const taskId = insertSpaceTask({ id: 'ms-review-carry', status: 'review' });
        db.exec(`
					UPDATE space_tasks
					SET completed_at = ${now + 1000},
					    pending_completion_submitted_at = ${now + 2000}
					WHERE id = '${taskId}'
				`);
        const rows = queryMilestones(taskId);
        expect(rows.find((r) => r.id === 'task:completed')).toBeUndefined();
        expect(rows.find((r) => r.id === 'task:review')).toBeDefined();
      });

      test('renders a failed human send as a distinct failure milestone', () => {
        const taskId = insertSpaceTask({
          id: 'ms-failed-send',
          status: 'in_progress',
          taskAgentSessionId: 'sess-failed-send',
        });
        sessionTaskIds.set('sess-failed-send', taskId);
        insertSdkMessageAt(
          'sdk-failed-send',
          'sess-failed-send',
          now + 1000,
          'user',
          'failed',
          'human',
          null,
          { type: 'user', message: { role: 'user', content: 'please retry this' } }
        );

        const rows = queryMilestones(taskId);
        const instr = rows.find((r) => r.category === 'instruction');
        expect(instr).toBeDefined();
        expect(instr?.tone).toBe('danger');
        expect(instr?.title).toBe('Instruction failed to send');
        expect(instr?.body).toBe('please retry this');
      });

      test('renders archived tasks as Archived (the sole terminal milestone)', () => {
        const taskId = insertSpaceTask({ id: 'ms-archived-review', status: 'archived' });
        db.exec(`
					UPDATE space_tasks
					SET pending_completion_submitted_at = ${now + 1000}, archived_at = ${now + 2000}
					WHERE id = '${taskId}'
				`);
        const rows = queryMilestones(taskId);
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get('task:archived')).toMatchObject({
          category: 'status',
          tone: 'neutral',
          title: 'Archived',
        });
        expect(byId.get('task:completed')).toBeUndefined();
      });

      test('archiving a blocked task drops the surviving Completed in favor of Archived', () => {
        const taskId = insertSpaceTask({ id: 'ms-archived-blocked', status: 'archived' });
        db.exec(`
					UPDATE space_tasks
					SET completed_at = ${now + 1000}, block_reason = 'stuck', archived_at = ${now + 2000}
					WHERE id = '${taskId}'
				`);
        const rows = queryMilestones(taskId);
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get('task:archived')?.title).toBe('Archived');
        expect(byId.get('task:completed')).toBeUndefined();
      });

      test('renders real instruction text, not a generic label', () => {
        const taskId = insertSpaceTask({
          id: 'ms-instr',
          status: 'in_progress',
          taskAgentSessionId: 'sess-instr',
        });
        sessionTaskIds.set('sess-instr', taskId);
        insertSdkMessageAt(
          'sdk-instr',
          'sess-instr',
          now + 1000,
          'user',
          'consumed',
          'human',
          null,
          {
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'Ship the curated timeline view' }],
            },
          }
        );

        const rows = queryMilestones(taskId);
        const instr = rows.find((r) => r.category === 'instruction');
        expect(instr).toBeDefined();
        expect(instr?.body).toBe('Ship the curated timeline view');
        expect(instr?.sourceKind).toBe('human');
      });

      test('extracts instruction text from a plain-string user content', () => {
        const taskId = insertSpaceTask({
          id: 'ms-instr-str',
          status: 'in_progress',
          taskAgentSessionId: 'sess-instr-str',
        });
        sessionTaskIds.set('sess-instr-str', taskId);
        insertSdkMessageAt(
          'sdk-instr-str',
          'sess-instr-str',
          now + 1000,
          'user',
          'consumed',
          'human',
          null,
          {
            type: 'user',
            message: { role: 'user', content: 'just do it' },
          }
        );

        const rows = queryMilestones(taskId);
        const instr = rows.find((r) => r.category === 'instruction');
        expect(instr?.body).toBe('just do it');
      });

      test('includes task-panel instructions persisted with origin NULL (production path)', () => {
        const taskId = insertSpaceTask({
          id: 'ms-panel',
          status: 'in_progress',
          taskAgentSessionId: 'sess-panel',
        });
        sessionTaskIds.set('sess-panel', taskId);
        const iso = new Date(now + 1000).toISOString();
        db.exec(`
					INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, task_id)
					VALUES ('sdk-panel', 'sess-panel', 'user', NULL,
						'${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'panel instruction' }] } })}',
						'${iso}', 'consumed', NULL, '${taskId}')
				`);

        const rows = queryMilestones(taskId);
        const instr = rows.find((r) => r.category === 'instruction');
        expect(instr).toBeDefined();
        expect(instr?.body).toBe('panel instruction');
      });

      test('excludes synthetic agent handoffs that share origin NULL (isSynthetic=true)', () => {
        const taskId = insertSpaceTask({
          id: 'ms-handoff',
          status: 'in_progress',
          taskAgentSessionId: 'sess-handoff',
        });
        sessionTaskIds.set('sess-handoff', taskId);
        const iso = new Date(now + 1000).toISOString();
        db.exec(`
					INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, task_id)
					VALUES ('sdk-handoff', 'sess-handoff', 'user', NULL,
						'${JSON.stringify({ type: 'user', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: 'handoff body' }] } })}',
						'${iso}', 'consumed', NULL, '${taskId}')
				`);

        const rows = queryMilestones(taskId);
        expect(rows.filter((r) => r.category === 'instruction')).toHaveLength(0);
      });

      test('excludes nested subagent assistant messages from top-level answers', () => {
        const workflowRunId = 'wr-ms-subagent';
        const nodeSessionId = 'node-sess-subagent';
        const taskId = insertSpaceTask({
          id: 'ms-subagent',
          workflowRunId,
          status: 'in_progress',
          taskAgentSessionId: 'orch-subagent',
        });
        insertSession(nodeSessionId, 'worker', '{}');
        insertNodeExecution({
          id: 'ne-subagent',
          workflowRunId,
          workflowNodeId: 'coder-node',
          agentName: 'coder',
          agentSessionId: nodeSessionId,
          status: 'in_progress',
        });
        insertSdkMessageAt(
          'sdk-top',
          nodeSessionId,
          now + 1000,
          'assistant',
          'consumed',
          'system',
          null,
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'top-level answer' }] },
          }
        );
        const iso = new Date(now + 2000).toISOString();
        db.exec(`
					INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, parent_tool_use_id, task_id)
					VALUES ('sdk-nested', '${nodeSessionId}', 'assistant', NULL,
						'${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'nested subagent chatter' }] } })}',
						'${iso}', 'consumed', 'system', 'toolu-1', '${taskId}')
				`);

        const rows = queryMilestones(taskId);
        const answers = rows.filter((r) => r.category === 'answer');
        expect(answers).toHaveLength(1);
        expect(answers[0].body).toBe('top-level answer');
      });

      test('renders queued human instructions from pending_agent_messages', () => {
        const taskId = insertSpaceTask({ id: 'ms-queued', status: 'in_progress' });
        db.exec(`
					INSERT INTO pending_agent_messages (
						id, workflow_run_id, space_id, task_id, source_agent_name, target_kind,
						target_agent_name, message, attempts, max_attempts, status, expires_at, created_at
					) VALUES (
						'pm-1', 'wr-q', '${spaceId}', '${taskId}', 'human', 'node_agent',
						'coder', 'please review when ready', 0, 5, 'pending', ${now + 600000}, ${now + 1000}
					)
				`);

        const rows = queryMilestones(taskId);
        const queued = rows.find((r) => r.id === 'pending:pm-1');
        expect(queued).toMatchObject({
          category: 'instruction',
          tone: 'info',
          title: 'Instruction queued',
          body: 'please review when ready',
        });
      });

      test('renders real agent answer text and skips tool-only assistant turns', () => {
        const workflowRunId = 'wr-ms-answer';
        const nodeSessionId = 'node-sess-answer';
        const taskId = insertSpaceTask({
          id: 'ms-answer',
          workflowRunId,
          status: 'in_progress',
          taskAgentSessionId: 'orch-answer',
        });
        insertSession(nodeSessionId, 'worker', '{}');
        insertNodeExecution({
          id: 'ne-answer',
          workflowRunId,
          workflowNodeId: 'coder-node',
          agentName: 'coder',
          agentSessionId: nodeSessionId,
          status: 'in_progress',
        });
        insertSdkMessageAt(
          'sdk-answer',
          nodeSessionId,
          now + 1000,
          'assistant',
          'consumed',
          'system',
          null,
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Done — opened PR #42' }],
            },
          }
        );
        insertSdkMessageAt(
          'sdk-tools',
          nodeSessionId,
          now + 2000,
          'assistant',
          'consumed',
          'system',
          null,
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }],
            },
          }
        );

        const rows = queryMilestones(taskId);
        const answers = rows.filter((r) => r.category === 'answer');
        expect(answers).toHaveLength(1);
        expect(answers[0].body).toBe('Done — opened PR #42');
        expect(answers[0].sourceLabel).toBe('coder');
      });

      test('drops raw plumbing: agent handoffs, thinking, result rows never appear', () => {
        const taskId = insertSpaceTask({
          id: 'ms-drop',
          status: 'in_progress',
          taskAgentSessionId: 'sess-drop',
        });
        sessionTaskIds.set('sess-drop', taskId);
        insertSdkMessageAt(
          'sdk-handoff',
          'sess-drop',
          now + 1000,
          'user',
          'consumed',
          'system',
          null,
          {
            type: 'user',
            message: { role: 'user', content: 'handoff body' },
          }
        );
        insertSdkMessageAt(
          'sdk-result',
          'sess-drop',
          now + 2000,
          'result',
          'consumed',
          'system',
          null,
          {
            type: 'result',
            subtype: 'success',
            result: 'turn done',
          }
        );

        const rows = queryMilestones(taskId);
        expect(rows).toHaveLength(1);
        expect(rows[0].category).toBe('creation');
      });

      test('emits artifact anchors by canonical shape with real content', () => {
        const workflowRunId = 'wr-ms-art';
        const taskId = insertSpaceTask({ id: 'ms-art', workflowRunId, status: 'in_progress' });
        insertArtifact(
          'art-pr',
          workflowRunId,
          'link',
          { kind: 'pr', url: 'https://x/y/pull/42', number: 42, summary: 'PR #42 opened' },
          now + 1000
        );
        insertArtifact(
          'art-decision',
          workflowRunId,
          'decision',
          { kind: 'review', recommendation: 'request_changes', summary: 'Address the nits' },
          now + 2000
        );
        insertArtifact('art-note', workflowRunId, 'note', { summary: 'halfway there' }, now + 3000);

        const rows = queryMilestones(taskId);
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get('artifact:art-pr')).toMatchObject({
          category: 'artifact',
          tone: 'success',
          title: 'PR',
          body: 'PR #42 opened',
        });
        expect(byId.get('artifact:art-pr')?.sourceLabel).toBeNull();
        expect(byId.get('artifact:art-decision')).toMatchObject({
          category: 'review',
          title: 'Review decision',
          tone: 'danger',
          body: 'Address the nits',
        });
        expect(byId.get('artifact:art-note')?.tone).toBe('progress');
      });

      test('classifies decision artifacts as review milestones with outcome tone', () => {
        const workflowRunId = 'wr-ms-review';
        const taskId = insertSpaceTask({ id: 'ms-review', workflowRunId, status: 'review' });
        insertArtifact(
          'art-verdict',
          workflowRunId,
          'decision',
          { kind: 'review', recommendation: 'approved', summary: 'Approved — looks good' },
          now + 1000
        );

        const rows = queryMilestones(taskId);
        const verdict = rows.find((r) => r.id === 'artifact:art-verdict');
        expect(verdict).toMatchObject({
          category: 'review',
          title: 'Review decision',
          tone: 'success',
        });
        expect(verdict?.body).toBe('Approved — looks good');
      });

      test('renders structured-shape bodies and keeps non-review decisions generic', () => {
        const workflowRunId = 'wr-ms-shapes2';
        const taskId = insertSpaceTask({ id: 'ms-shapes2', workflowRunId, status: 'in_progress' });
        insertArtifact(
          'art-metric',
          workflowRunId,
          'metric',
          { name: 'p95-latency', value: 850, unit: 'ms' },
          now + 1000
        );
        insertArtifact(
          'art-qa',
          workflowRunId,
          'decision',
          { recommendation: 'approve', summary: 'QA passed' },
          now + 2000
        );
        insertArtifact(
          'art-check',
          workflowRunId,
          'check',
          { name: 'ci', status: 'running', counts: { passed: 20 } },
          now + 3000
        );
        insertArtifact(
          'art-commits',
          workflowRunId,
          'commit_set',
          { branch: 'main', commits: [{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }] },
          now + 4000
        );

        const rows = queryMilestones(taskId);
        expect(rows.find((r) => r.id === 'artifact:art-metric')?.body).toBe('p95-latency: 850');
        const qa = rows.find((r) => r.id === 'artifact:art-qa');
        expect(qa).toMatchObject({ category: 'artifact', title: 'Decision', tone: 'success' });
        expect(rows.find((r) => r.id === 'artifact:art-check')?.body).toBe('ci: running');
        expect(rows.find((r) => r.id === 'artifact:art-commits')?.body).toBe('3 commits on main');
      });

      test('renders the cancellation reason in the cancelled milestone body', () => {
        const taskId = insertSpaceTask({ id: 'ms-cancelled', status: 'cancelled' });
        db.exec(`
					UPDATE space_tasks
					SET completed_at = ${now + 1000}, approval_reason = 'duplicate of #42'
					WHERE id = '${taskId}'
				`);
        const rows = queryMilestones(taskId);
        const completed = rows.find((r) => r.id === 'task:completed');
        expect(completed).toMatchObject({ title: 'Cancelled', tone: 'danger' });
        expect(completed?.body).toBe('duplicate of #42');
      });

      test('does not misclassify unrelated artifact types via substring collision', () => {
        const workflowRunId = 'wr-ms-collision';
        const taskId = insertSpaceTask({
          id: 'ms-collision',
          workflowRunId,
          status: 'in_progress',
        });
        insertArtifact('art-dis', workflowRunId, 'disapproval', { summary: 'no' }, now + 1000);
        insertArtifact('art-prop', workflowRunId, 'proposal', { summary: 'idea' }, now + 2000);

        const rows = queryMilestones(taskId);
        const titles = rows.filter((r) => r.category === 'artifact').map((r) => r.title);
        expect(titles).not.toContain('Review approval');
        expect(titles).not.toContain('PR recorded');
        expect(titles).toEqual(
          expect.arrayContaining(['disapproval recorded', 'proposal recorded'])
        );
      });

      test('dates overwrite-style progress artifacts by their last update', () => {
        const workflowRunId = 'wr-ms-progress';
        const taskId = insertSpaceTask({ id: 'ms-progress', workflowRunId, status: 'in_progress' });
        db.exec(`
					INSERT INTO workflow_run_artifacts (id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at)
					VALUES ('art-prog', '${workflowRunId}', 'coder-node', 'progress', 'current',
						'{"summary":"halfway"}', ${now + 1000}, ${now + 5000})
				`);

        const rows = queryMilestones(taskId);
        const prog = rows.find((r) => r.id === 'artifact:art-prog');
        expect(prog?.createdAt).toBe(now + 5000);
        expect(prog?.body).toBe('halfway');
      });

      test('SQL prepares and runs against the full production schema (drift guard)', () => {
        const real = new BunDatabase(':memory:');
        createTables(real);
        runMigrations(real, () => {});
        real.exec('PRAGMA foreign_keys = OFF');
        real.exec(
          `INSERT OR IGNORE INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('s1','s1','/tmp','S',${now},${now})`
        );
        real.exec(
          `INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, depends_on, workflow_run_id, created_at, updated_at, started_at) VALUES ('t1','s1',1,'T','d','in_progress','normal','[]','wr1',${now},${now},${now + 500})`
        );
        real.exec(
          `INSERT INTO workflow_run_artifacts (id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at) VALUES ('a1','wr1','coder-node','result','','{"summary":"ok"}',${now},${now})`
        );

        const entry = NAMED_QUERY_REGISTRY.get('taskMilestones.byTask')!;
        expect(() => real.prepare(entry.sql)).not.toThrow();
        const rows = entry.mapRow
          ? (real.prepare(entry.sql).all('t1') as Record<string, unknown>[]).map(entry.mapRow)
          : (real.prepare(entry.sql).all('t1') as Record<string, unknown>[]);
        const categories = rows.map((r) => r.category);
        expect(categories).toContain('creation');
        expect(categories).toContain('status');
        real.close();
      });

      test('emits GitHub CI milestones from the live external-event tables', () => {
        const taskId = insertSpaceTask({ id: 'ms-github', status: 'in_progress' });
        insertGithubEvent(
          'gh-1',
          taskId,
          'github/lsm/neokai/pull_request/5.check_failed',
          'PR #5 check tests failed',
          'delivered',
          now + 1000
        );
        insertGithubEvent(
          'gh-2',
          taskId,
          'github/lsm/neokai/pull_request/5.opened',
          'PR review submitted',
          'routed',
          now + 2000
        );

        const rows = queryMilestones(taskId);
        const ghRows = rows.filter((r) => r.category === 'github');
        expect(ghRows).toHaveLength(2);
        expect(ghRows[0]).toMatchObject({
          title: 'CI check failed',
          body: 'PR #5 check tests failed',
          tone: 'danger',
        });
        expect(ghRows[1]).toMatchObject({ title: 'PR update', tone: 'neutral' });
      });

      test('renders external-CI status_failure / status_error as CI check failed (danger)', () => {
        const taskId = insertSpaceTask({ id: 'ms-github-status', status: 'in_progress' });
        insertGithubEvent(
          'gh-status-fail',
          taskId,
          'github/lsm/neokai/pull_request/5.status_failure',
          'PR #5 status failure (jenkins)',
          'delivered',
          now + 1000
        );
        insertGithubEvent(
          'gh-status-err',
          taskId,
          'github/lsm/neokai/pull_request/5.status_error',
          'PR #5 status error (travis)',
          'delivered',
          now + 2000
        );
        insertGithubEvent(
          'gh-status-pending',
          taskId,
          'github/lsm/neokai/pull_request/5.status_pending',
          'PR #5 status pending',
          'delivered',
          now + 3000
        );

        const rows = queryMilestones(taskId).filter((r) => r.category === 'github');
        const failure = rows.find((r) => r.body.includes('failure'));
        const error = rows.find((r) => r.body.includes('error'));
        const pending = rows.find((r) => r.body.includes('pending'));
        expect(failure).toMatchObject({ title: 'CI check failed', tone: 'danger' });
        expect(error).toMatchObject({ title: 'CI check failed', tone: 'danger' });
        expect(pending).toMatchObject({ title: 'PR update', tone: 'neutral' });
      });

      test('colors a non-CI GitHub event by the matching task delivery, not the global event state', () => {
        const taskA = insertSpaceTask({ id: 'ms-gh-a', status: 'in_progress' });
        const taskB = insertSpaceTask({ id: 'ms-gh-b', status: 'in_progress' });
        const evId = 'gh-fanout';
        db.exec(`
					INSERT INTO space_external_events (
						id, space_id, source, topic, dedupe_key, occurred_at, ingested_at,
						summary, external_url, payload_json, state, created_at, updated_at
					) VALUES (
						'${evId}', '${spaceId}', 'github', 'github/lsm/neokai/pull_request/9.opened', 'dk-${evId}',
						${now + 1000}, ${now + 1000}, 'PR #9 opened', '', '{}', 'failed', ${now + 1000}, ${now + 1000}
					)
				`);
        db.exec(`
					INSERT INTO space_external_event_deliveries (
						event_id, delivery_key, workflow_run_id, task_id, node_id, agent_name, state, updated_at
					) VALUES
						('${evId}', 'dk-${evId}-a', 'wr-a', '${taskA}', 'coder-node', 'coder', 'failed', ${now + 1000}),
						('${evId}', 'dk-${evId}-b', 'wr-b', '${taskB}', 'coder-node', 'coder', 'delivered', ${now + 1000})
				`);

        const rowsA = queryMilestones(taskA).filter((r) => r.category === 'github');
        const rowsB = queryMilestones(taskB).filter((r) => r.category === 'github');
        expect(rowsA[0]?.tone).toBe('danger');
        expect(rowsB[0]?.tone).toBe('neutral');
      });

      test('emits collapsed api_retry rows with attempt/status detail', () => {
        const workflowRunId = 'wr-ms-retry';
        const taskId = insertSpaceTask({
          id: 'ms-retry',
          workflowRunId,
          status: 'in_progress',
          taskAgentSessionId: 'orch-retry',
        });
        const retrySession = 'node-sess-retry';
        insertSession(retrySession, 'worker', '{}');
        insertNodeExecution({
          id: 'ne-retry',
          workflowRunId,
          workflowNodeId: 'coder-node',
          agentName: 'coder',
          agentSessionId: retrySession,
          status: 'in_progress',
        });
        insertSdkMessageAt(
          'sdk-retry',
          retrySession,
          now + 1000,
          'system',
          'consumed',
          'system',
          'api_retry',
          {
            type: 'system',
            subtype: 'api_retry',
            attempt: 2,
            max_retries: 10,
            error_status: 529,
          }
        );

        const rows = queryMilestones(taskId);
        const retry = rows.find((r) => r.category === 'retry');
        expect(retry).toBeDefined();
        expect(retry?.tone).toBe('warning');
        expect(retry?.sourceLabel).toBe('coder');
        expect(retry?.body).toContain('Attempt 2/10');
        expect(retry?.body).toContain('529');
      });

      test('feed is non-empty for an active task with mixed sources', () => {
        const workflowRunId = 'wr-ms-active';
        const nodeSessionId = 'node-sess-active';
        const taskId = insertSpaceTask({
          id: 'ms-active',
          workflowRunId,
          status: 'in_progress',
          taskAgentSessionId: 'orch-active',
        });
        db.exec(`UPDATE space_tasks SET started_at = ${now + 500} WHERE id = '${taskId}'`);
        insertSession(nodeSessionId, 'worker', '{}');
        insertNodeExecution({
          id: 'ne-active',
          workflowRunId,
          workflowNodeId: 'coder-node',
          agentName: 'coder',
          agentSessionId: nodeSessionId,
          status: 'in_progress',
        });
        sessionTaskIds.set('orch-active', taskId);
        insertSdkMessageAt(
          'sdk-a-instr',
          'orch-active',
          now + 1000,
          'user',
          'consumed',
          'human',
          null,
          {
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
          }
        );
        insertArtifact('art-a', workflowRunId, 'progress', { summary: 'wip' }, now + 2000);

        const rows = queryMilestones(taskId);
        const categories = rows.map((r) => r.category);
        expect(categories).toContain('creation');
        expect(categories).toContain('status');
        expect(categories).toContain('instruction');
        expect(categories).toContain('artifact');
        expect(rows.length).toBeGreaterThanOrEqual(4);
      });
    });

    test('classifies by session type, not current task_agent_session_id pointer', () => {
      const oldOrchSessionId = 'space:test-space:task:orch-old';
      const newOrchSessionId = 'space:test-space:task:orch-new';
      const taskId = insertSpaceTask({
        taskAgentSessionId: newOrchSessionId,
        status: 'in_progress',
      });

      insertSession(
        oldOrchSessionId,
        'space_task_agent',
        '{"status":"processing"}',
        `{"taskId":"${taskId}"}`
      );
      insertSession(
        newOrchSessionId,
        'space_task_agent',
        '{"status":"processing"}',
        `{"taskId":"${taskId}"}`
      );
      sessionTaskIds.set(oldOrchSessionId, taskId);
      insertSdkMessage('sdk-old', oldOrchSessionId);

      const rows = queryMessages(taskId);
      const oldRow = rows.find((r) => r.sessionId === oldOrchSessionId);
      expect(oldRow).toBeDefined();
      expect(oldRow!.kind).toBe('task_agent');
      expect(oldRow!.label).toBe('Task Agent');
    });

    describe('spaceTaskMessages.byTask.compact', () => {
      function insertSdkMessageAt(
        id: string,
        sessionIdValue: string,
        timestampMs: number,
        sdkMessage?: Record<string, unknown>,
        messageType = 'assistant'
      ): void {
        const iso = new Date(timestampMs).toISOString();
        const payload =
          sdkMessage ??
          ({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: id }] },
          } as Record<string, unknown>);
        const sdkLike = { type: messageType, ...payload } as unknown as SDKMessage;
        const isRenderable = computeIsRenderable(sdkLike);
        const isTerminal = computeIsTerminal(sdkLike);
        const parentToolUseId = extractParentToolUseId(sdkLike);
        const messageSubtype = typeof payload.subtype === 'string' ? payload.subtype : null;
        const taskIdForSession = sessionTaskIds.get(sessionIdValue) ?? null;
        db.exec(`
					INSERT INTO sdk_messages (
						id, session_id, message_type, message_subtype, sdk_message, timestamp,
						send_status, origin, is_renderable, is_terminal, parent_tool_use_id, task_id
					) VALUES (
						'${id}', '${sessionIdValue}', '${messageType}', ${messageSubtype ? `'${messageSubtype}'` : 'NULL'}, '${JSON.stringify(payload)}',
						'${iso}', 'consumed', 'system', ${isRenderable}, ${isTerminal},
						${parentToolUseId ? `'${parentToolUseId}'` : 'NULL'},
						${taskIdForSession ? `'${taskIdForSession}'` : 'NULL'}
					)
				`);
      }

      function insertResultMessageAt(
        id: string,
        sessionIdValue: string,
        timestampMs: number,
        subtype: 'success' | 'error_during_execution' = 'success'
      ): void {
        insertSdkMessageAt(
          id,
          sessionIdValue,
          timestampMs,
          {
            type: 'result',
            subtype,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: subtype !== 'success',
            total_cost_usd: 0,
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
              total_tokens: 2,
            },
          },
          'result'
        );
      }

      function queryCompact(taskId: string): Record<string, unknown>[] {
        backfillConversationTurns();
        const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask.compact')!;
        const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
        return entry.mapRow ? rows.map(entry.mapRow) : rows;
      }

      test('includes DB message origin in compact rows', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        insertSdkMessageAt('system-origin', sessionId, now + 1000);

        const rows = queryCompact(taskId);

        expect(rows).toHaveLength(1);
        expect(rows[0].origin).toBe('system');
      });

      test('includes a queued prompt to a dormant session even when its turn is older than the recent-turn cutoff', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'a-anchor',
          sessionId,
          now + 1000,
          { type: 'user', uuid: 'u-a-anchor', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt(
          'a-queued',
          sessionId,
          now + 2000,
          { type: 'user', uuid: 'u-a-queued', message: { role: 'user', content: 'queued' } },
          'user'
        );
        db.prepare(
          `UPDATE sdk_messages SET send_status = 'enqueued', sdk_uuid = 'u-a-queued' WHERE id = 'a-queued'`
        ).run();

        const sessionB = 'sess-dormant-b';
        insertSession(sessionB, 'worker', '{"status":"processing"}');
        sessionTaskIds.set(sessionB, taskId);
        for (let i = 0; i < 100; i += 1) {
          insertSdkMessageAt(
            `b-anchor-${i}`,
            sessionB,
            now + 3000 + i,
            { type: 'user', uuid: `u-b-${i}`, message: { role: 'user', content: `b${i}` } },
            'user'
          );
        }

        const rows = queryCompact(taskId);
        const queued = rows.find((r) => r.id === 'a-queued');
        expect(queued).toBeTruthy();
        expect((queued as Record<string, unknown>).deliveryState).toBe('queued');
      });

      test('maps user-message send_status to the delivery lifecycle + retrying (compact feed)', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        const userPayload = (uuid: string) => ({
          type: 'user',
          uuid,
          message: { role: 'user', content: 'handoff' },
        });
        const cases: Array<{ id: string; uuid: string; sendStatus: string; expected: string }> = [
          {
            id: 'c-delivered',
            uuid: 'u-c-delivered',
            sendStatus: 'consumed',
            expected: 'delivered',
          },
          { id: 'c-queued', uuid: 'u-c-queued', sendStatus: 'enqueued', expected: 'queued' },
          {
            id: 'c-processing',
            uuid: 'u-c-processing',
            sendStatus: 'submitted',
            expected: 'processing',
          },
          { id: 'c-failed', uuid: 'u-c-failed', sendStatus: 'failed', expected: 'failed' },
          { id: 'c-retry', uuid: 'u-c-retry', sendStatus: 'enqueued', expected: 'retrying' },
        ];
        for (const c of cases) {
          insertSdkMessageAt(c.id, sessionId, now + 1000, userPayload(c.uuid), 'user');
          db.prepare(`UPDATE sdk_messages SET send_status = ?, sdk_uuid = ? WHERE id = ?`).run(
            c.sendStatus,
            c.uuid,
            c.id
          );
        }
        db.prepare(
          `INSERT INTO job_queue (id, queue, status, payload, retry_count, max_retries, run_at, created_at)
           VALUES (?, 'message_delivery', 'pending', ?, 1, 8, ?, ?)`
        ).run(
          'job-c-retry',
          JSON.stringify({
            sessionId,
            messageUuid: 'u-c-retry',
            role: 'turn',
            origin: 'space_inject',
          }),
          now,
          now
        );

        const byId = new Map(queryCompact(taskId).map((r) => [r.id as string, r]));
        for (const c of cases) {
          expect((byId.get(c.id) as Record<string, unknown> | undefined)?.deliveryState).toBe(
            c.expected
          );
        }
      });

      test('keeps anchor + last-assistant summary + result per conversation turn', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        for (let i = 1; i <= 3; i += 1) {
          insertSdkMessageAt(`t1-a${i}`, sessionId, now + (1 + i) * 1000);
        }
        insertResultMessageAt('t1-r', sessionId, now + 5000, 'success');
        insertSdkMessageAt(
          'u2',
          sessionId,
          now + 6000,
          { type: 'user', message: { role: 'user', content: 'again' } },
          'user'
        );
        for (let i = 1; i <= 3; i += 1) {
          insertSdkMessageAt(`t2-a${i}`, sessionId, now + (6 + i) * 1000);
        }
        insertResultMessageAt('t2-r', sessionId, now + 10000, 'error_during_execution');

        const rows = queryCompact(taskId);
        expect(rows.map((r) => r.id)).toEqual(['u1', 't1-a3', 't1-r', 'u2', 't2-a3', 't2-r']);
        expect(rows.find((r) => r.id === 'u1')!.turnIndex).toBe(1);
        expect(rows.find((r) => r.id === 'u2')!.turnIndex).toBe(2);
      });

      test('result rows are always kept as completion markers', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        for (let i = 1; i <= 6; i += 1) {
          insertSdkMessageAt(`n${i}`, sessionId, now + (1 + i) * 1000);
        }
        insertResultMessageAt('r1', sessionId, now + 8000, 'success');

        const rows = queryCompact(taskId);
        expect(rows.map((r) => r.id)).toEqual(['u1', 'n6', 'r1']);
      });

      test('mid-turn user messages are never swallowed (#2338)', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'do X' } },
          'user'
        );
        insertSdkMessageAt('a1', sessionId, now + 2000);
        insertSdkMessageAt('a2', sessionId, now + 3000);
        insertSdkMessageAt(
          'u-mid',
          sessionId,
          now + 4000,
          { type: 'user', message: { role: 'user', content: 'also Y' } },
          'user'
        );
        insertSdkMessageAt('a3', sessionId, now + 5000);
        insertSdkMessageAt('a4', sessionId, now + 6000);
        insertResultMessageAt('r1', sessionId, now + 7000, 'success');

        const rows = queryCompact(taskId);
        expect(rows.map((r) => r.id)).toEqual(['u1', 'a2', 'u-mid', 'a4', 'r1']);
        expect(rows.find((r) => r.id === 'u1')!.turnIndex).toBe(1);
        expect(rows.find((r) => r.id === 'u-mid')!.turnIndex).toBe(2);
      });

      test('applies turn compaction independently per session (agent)', () => {
        const orchestrationSessionId = 'space:test-space:task:compact-orch';
        const nodeSessionId = 'space:test-space:task:compact-node';
        const workflowRunId = 'wr-compact-per-session';
        const workflowNodeId = 'node-compact';
        const taskId = insertSpaceTask({
          taskAgentSessionId: orchestrationSessionId,
          workflowRunId,
        });

        insertSession(orchestrationSessionId, 'space_task_agent', '{"status":"processing"}');
        insertSession(nodeSessionId, 'worker', '{"status":"processing"}');

        insertNodeExecution({
          id: 'ne-compact',
          workflowRunId,
          workflowNodeId,
          agentName: 'coder',
          agentSessionId: nodeSessionId,
          status: 'in_progress',
        });

        for (let i = 1; i <= 6; i += 1) {
          insertSdkMessageAt(`orch-n${i}`, orchestrationSessionId, now + i * 1000);
          insertSdkMessageAt(`node-n${i}`, nodeSessionId, now + i * 1000 + 500);
        }
        insertResultMessageAt('orch-r', orchestrationSessionId, now + 7000, 'success');
        insertResultMessageAt('node-r', nodeSessionId, now + 7500, 'success');

        const rows = queryCompact(taskId);
        const orchIds = rows.filter((r) => r.sessionId === orchestrationSessionId).map((r) => r.id);
        const nodeIds = rows.filter((r) => r.sessionId === nodeSessionId).map((r) => r.id);

        expect(orchIds).toEqual(['orch-n6', 'orch-r']);
        expect(nodeIds).toEqual(['node-n6', 'node-r']);
      });

      test('omits user tool_result rows and excludes them from non-terminal cap', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('a1', sessionId, now + 1000);
        insertSdkMessageAt('a2', sessionId, now + 1100);
        insertSdkMessageAt('a3', sessionId, now + 1200);
        insertSdkMessageAt('a4', sessionId, now + 1300);
        insertSdkMessageAt('a5', sessionId, now + 1400);
        insertSdkMessageAt('a6', sessionId, now + 1500);
        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1600,
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_test',
                  content: [{ type: 'text', text: 'result payload' }],
                },
              ],
            },
          },
          'user'
        );
        insertResultMessageAt('r1', sessionId, now + 1700, 'success');

        const rows = queryCompact(taskId);
        expect(rows.map((r) => r.id)).toEqual(['a6', 'r1']);
        expect(rows.map((r) => r.id)).not.toContain('u1');
      });

      test('surfaces GitHub activity rows alongside the conversation thread (#2338)', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt('a1', sessionId, now + 2000);
        insertResultMessageAt('r1', sessionId, now + 3000, 'success');

        db.exec(`
					INSERT INTO space_github_events (
						id, space_id, task_id, source, delivery_id, event_type, action,
						repo_owner, repo_name, pr_number, pr_url, actor, actor_type,
						body, summary, external_url, external_id, occurred_at, dedupe_key,
						raw_payload, state, created_at, updated_at
					) VALUES (
						'gh-compact-1', '${spaceId}', '${taskId}', 'webhook', 'delivery-gh-1',
						'pull_request', 'opened', 'lsm', 'neokai', 1965,
						'https://github.com/lsm/neokai/pull/1965', 'reviewer', 'User', '',
						'PR #1965 opened', 'https://github.com/lsm/neokai/pull/1965',
						'gh-ext-1', ${now + 2500}, 'gh-compact-1', '{}', 'routed',
						${now + 2500}, ${now + 2500}
					)
				`);

        const rows = queryCompact(taskId);
        const gh = rows.find((r) => r.id === 'gh-compact-1');
        expect(gh).toBeDefined();
        expect(gh!.kind).toBe('github');
        expect(gh!.messageType).toBe('github_pr_activity');
        expect(rows.map((r) => r.id)).toEqual(['u1', 'a1', 'gh-compact-1', 'r1']);
      });

      test('keeps Write/Edit/TodoWrite tool rows even when the segment has assistant text (#2338)', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt('a-text', sessionId, now + 2000, {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        });
        insertSdkMessageAt('a-write', sessionId, now + 3000, {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu-1',
                name: 'Write',
                input: { file_path: 'x.ts', content: 'x' },
              },
            ],
          },
        });
        insertResultMessageAt('r1', sessionId, now + 4000, 'success');

        const rows = queryCompact(taskId);
        expect(rows.map((r) => r.id)).toEqual(['u1', 'a-text', 'a-write', 'r1']);
      });

      test('does not duplicate tool rows seg_summary already keeps in a no-text turn (#2338)', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt('w1', sessionId, now + 2000, {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu-1',
                name: 'Write',
                input: { file_path: 'a.ts', content: 'a' },
              },
            ],
          },
        });
        insertSdkMessageAt('w2', sessionId, now + 3000, {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu-2',
                name: 'Edit',
                input: { file_path: 'b.ts', old_string: '', new_string: 'b' },
              },
            ],
          },
        });
        insertResultMessageAt('r1', sessionId, now + 4000, 'success');

        const rows = queryCompact(taskId);
        const ids = rows.map((r) => r.id);
        expect(ids.filter((id) => id === 'w1')).toHaveLength(1);
        expect(ids.filter((id) => id === 'w2')).toHaveLength(1);
        expect(ids).toEqual(['u1', 'w1', 'w2', 'r1']);
      });

      test('keeps hyperneo_action (sdk_resume_choice) rows visible in compact (#2338)', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt(
          'ha-resume',
          sessionId,
          now + 2000,
          {
            type: 'hyperneo_action',
            action: 'sdk_resume_choice',
            uuid: 'ha-resume',
            session_id: sessionId,
            choices: [],
          } as Record<string, unknown>,
          'hyperneo_action'
        );
        insertResultMessageAt('r1', sessionId, now + 3000, 'success');

        const rows = queryCompact(taskId);
        const ha = rows.find((r) => r.id === 'ha-resume');
        expect(ha).toBeDefined();
        expect(ha!.messageType).toBe('hyperneo_action');
      });

      test('task feeds include rows retracted by refusal fallback notices', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        insertSdkMessageAt('row-retracted', sessionId, now + 1000, {
          type: 'assistant',
          uuid: 'retracted',
          message: { role: 'assistant', content: [{ type: 'text', text: 'retracted' }] },
        });
        insertSdkMessageAt('visible-after-retry', sessionId, now + 2000);
        insertSdkMessageAt(
          'fallback-notice',
          sessionId,
          now + 3000,
          {
            type: 'system',
            subtype: 'model_refusal_fallback',
            trigger: 'refusal',
            direction: 'retry',
            original_model: 'opus',
            fallback_model: 'sonnet',
            request_id: 'req-1',
            retracted_message_uuids: ['retracted'],
            content: 'Retried with fallback model',
          },
          'system'
        );

        const compactRows = queryCompact(taskId);
        const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!;
        const rawRows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
        const fullRows = entry.mapRow ? rawRows.map(entry.mapRow) : rawRows;

        expect(compactRows.map((row) => row.id)).toEqual([
          'visible-after-retry',
          'fallback-notice',
        ]);
        expect(fullRows.map((row) => row.id)).toEqual([
          'row-retracted',
          'visible-after-retry',
          'fallback-notice',
        ]);
      });

      test('always includes system rows (init / compact_boundary) regardless of tail position', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'sys-init',
          sessionId,
          now + 1000,
          {
            type: 'system',
            subtype: 'init',
            model: 'claude-3-5-sonnet-20241022',
            cwd: '/tmp',
            tools: ['Read', 'Bash'],
          },
          'system'
        );
        insertSdkMessageAt(
          'u-initial',
          sessionId,
          now + 1100,
          {
            type: 'user',
            message: { role: 'user', content: 'go' },
          },
          'user'
        );
        for (let i = 1; i <= 7; i += 1) {
          insertSdkMessageAt(`a${i}`, sessionId, now + (1 + i) * 1000);
        }
        insertResultMessageAt('r1', sessionId, now + 10_000, 'success');

        const rows = queryCompact(taskId);
        expect(rows.map((r) => r.id)).toEqual(['sys-init', 'u-initial', 'a7', 'r1']);
      });

      test('filters transcript-only informational rows before task-feed compaction', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('visible-before', sessionId, now + 1000);
        insertSdkMessageAt(
          'hidden-info',
          sessionId,
          now + 2000,
          {
            type: 'system',
            subtype: 'informational',
            level: 'info',
            content: 'transcript-only',
          },
          'system'
        );
        insertSdkMessageAt(
          'visible-warning',
          sessionId,
          now + 3000,
          {
            type: 'system',
            subtype: 'informational',
            level: 'warning',
            content: 'shown to user',
          },
          'system'
        );

        const compactRows = queryCompact(taskId);
        const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!;
        const rawRows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
        const fullRows = entry.mapRow ? rawRows.map(entry.mapRow) : rawRows;

        expect(compactRows.map((row) => row.id)).toEqual(['visible-before', 'visible-warning']);
        expect(fullRows.map((row) => row.id)).toEqual(['visible-before', 'visible-warning']);
      });

      test('keeps worker shutdown task-feed rows only at the session tail', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('visible-before', sessionId, now + 1000);
        insertSdkMessageAt(
          'stale-shutdown',
          sessionId,
          now + 2000,
          {
            type: 'system',
            subtype: 'worker_shutting_down',
            reason: 'host_exit',
          },
          'system'
        );
        insertSdkMessageAt('visible-after', sessionId, now + 3000);
        insertSdkMessageAt(
          'tail-shutdown',
          sessionId,
          now + 4000,
          {
            type: 'system',
            subtype: 'worker_shutting_down',
            reason: 'host_exit',
          },
          'system'
        );

        const compactRows = queryCompact(taskId);
        const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!;
        const rawRows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
        const fullRows = entry.mapRow ? rawRows.map(entry.mapRow) : rawRows;

        expect(compactRows.map((row) => row.id)).toEqual(['visible-after', 'tail-shutdown']);
        expect(fullRows.map((row) => row.id)).toEqual([
          'visible-before',
          'visible-after',
          'tail-shutdown',
        ]);
      });

      test('keeps a session shutdown tail regardless of newer rows in sibling sessions', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        const sessionB = 'shutdown-sibling-worker-b';
        insertSession(sessionB, 'worker', '{"status":"processing"}');
        sessionTaskIds.set(sessionB, taskId);

        insertSdkMessageAt(
          'sibling-scoped-shutdown',
          sessionId,
          now + 1000,
          {
            type: 'system',
            subtype: 'worker_shutting_down',
            reason: 'host_exit',
          },
          'system'
        );
        insertSdkMessageAt('sibling-newer', sessionB, now + 2000);
        insertSdkMessageAt(
          'sibling-queued-user',
          sessionId,
          now + 3000,
          {
            type: 'user',
            uuid: 'u-sibling-queued-user',
            message: { role: 'user', content: 'queued' },
          },
          'user'
        );
        db.prepare(
          `UPDATE sdk_messages SET send_status = 'enqueued' WHERE id = 'sibling-queued-user'`
        ).run();

        const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!;
        const queryFull = () => {
          const rawRows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
          return entry.mapRow ? rawRows.map(entry.mapRow) : rawRows;
        };
        const queryIds = () => queryFull().map((row) => row.id);

        expect(queryCompact(taskId).map((row) => row.id)).toEqual([
          'sibling-scoped-shutdown',
          'sibling-newer',
          'sibling-queued-user',
        ]);
        expect(queryIds()).toEqual([
          'sibling-scoped-shutdown',
          'sibling-newer',
          'sibling-queued-user',
        ]);

        db.prepare(
          `UPDATE sdk_messages SET send_status = 'consumed' WHERE id = 'sibling-queued-user'`
        ).run();

        expect(queryCompact(taskId).map((row) => row.id)).toEqual([
          'sibling-newer',
          'sibling-queued-user',
        ]);
        expect(queryIds()).toEqual(['sibling-newer', 'sibling-queued-user']);
      });

      test('final ordering is createdAt ASC, id ASC', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('sdk-b', sessionId, now + 2000);
        insertSdkMessageAt('sdk-a', sessionId, now + 1000);
        insertResultMessageAt('sdk-r', sessionId, now + 3000, 'success');

        const rows = queryCompact(taskId);
        const createdAts = rows.map((r) => r.createdAt as number);
        const sorted = [...createdAts].sort((x, y) => x - y);
        expect(createdAts).toEqual(sorted);
      });

      test('task feeds include operational system rows', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('visible', sessionId, now, {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'visible' }] },
        });
        for (const subtype of ['thinking_tokens', 'session_state_changed', 'commands_changed']) {
          insertSdkMessageAt(
            `operational-${subtype}`,
            sessionId,
            now + 1000,
            {
              type: 'system',
              subtype,
              commands: [],
              state: 'idle',
              estimated_tokens: 1,
              estimated_tokens_delta: 1,
            },
            'system'
          );
        }

        const compactRows = queryCompact(taskId);
        const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!;
        const rawRows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
        const fullRows = entry.mapRow ? rawRows.map(entry.mapRow) : rawRows;

        expect(compactRows.map((row) => row.id)).toEqual([
          'visible',
          'operational-thinking_tokens',
          'operational-session_state_changed',
          'operational-commands_changed',
        ]);
        expect(fullRows.map((row) => row.id)).toEqual([
          'visible',
          'operational-commands_changed',
          'operational-session_state_changed',
          'operational-thinking_tokens',
        ]);
      });

      test('legacy full query variant is unaffected by compact slicing', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        const total = 12;
        for (let i = 0; i < total; i++) {
          insertSdkMessageAt(`sdk-full-${i}`, sessionId, now + i * 1000);
        }

        const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask')!;
        const rawRows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
        const rows = entry.mapRow ? rawRows.map(entry.mapRow) : rawRows;

        expect(rows).toHaveLength(total);
        for (const row of rows) {
          expect(row.sessionMessageCount).toBeUndefined();
        }
      });
    });

    describe('active-turn entries SQL', () => {
      function insertSdkMessageAt(
        id: string,
        sessionIdValue: string,
        timestampMs: number,
        sdkMessage?: Record<string, unknown>,
        messageType = 'assistant'
      ): void {
        const iso = new Date(timestampMs).toISOString();
        const payload =
          sdkMessage ??
          ({
            type: 'assistant',
            uuid: id,
            message: { role: 'assistant', content: [{ type: 'text', text: id }] },
          } as Record<string, unknown>);
        const sdkLike = { type: messageType, ...payload } as unknown as SDKMessage;
        const isRenderable = computeIsRenderable(sdkLike);
        const isTerminal = computeIsTerminal(sdkLike);
        const parentToolUseId = extractParentToolUseId(sdkLike);
        const taskIdForSession = sessionTaskIds.get(sessionIdValue) ?? null;
        db.exec(`
					INSERT INTO sdk_messages (
						id, session_id, message_type, message_subtype, sdk_message, timestamp,
						send_status, origin, is_renderable, is_terminal, parent_tool_use_id, task_id
					) VALUES (
						'${id}', '${sessionIdValue}', '${messageType}', NULL, '${JSON.stringify(payload).replace(/'/g, "''")}',
						'${iso}', 'consumed', 'system', ${isRenderable}, ${isTerminal},
						${parentToolUseId ? `'${parentToolUseId}'` : 'NULL'},
						${taskIdForSession ? `'${taskIdForSession}'` : 'NULL'}
					)
				`);
      }

      function insertResultAt(
        id: string,
        sessionIdValue: string,
        timestampMs: number,
        subtype: 'success' | 'error_during_execution' = 'success'
      ): void {
        insertSdkMessageAt(
          id,
          sessionIdValue,
          timestampMs,
          {
            type: 'result',
            uuid: id,
            subtype,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: subtype !== 'success',
            total_cost_usd: 0,
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
              total_tokens: 2,
            },
          },
          'result'
        );
      }

      async function runEntries(taskId: string): Promise<unknown[]> {
        backfillConversationTurns();
        const mod = await import('../../../../src/lib/rpc-handlers/live-query-handlers');
        const sql = mod.SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL;
        return db.prepare(sql).all(taskId);
      }

      async function buildSummaries(taskId: string): Promise<
        Array<{
          sessionId: string;
          turnIndex: number;
          entries: Record<string, unknown>[];
        }>
      > {
        const mod = await import('../../../../src/lib/rpc-handlers/live-query-handlers');
        const rows = (await runEntries(taskId)) as Record<string, unknown>[];
        return mod.buildActiveTurnSummariesFromRows(rows);
      }

      test('emits a summary only for the active conversation turn per session', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt('t1-a1', sessionId, now + 2000, {
          type: 'assistant',
          uuid: 't1-a1',
          message: { content: [{ type: 'text', text: 'closed-text' }] },
        });
        insertResultAt('t1-r', sessionId, now + 3000, 'success');

        insertSdkMessageAt(
          'u2',
          sessionId,
          now + 4000,
          { type: 'user', message: { role: 'user', content: 'more' } },
          'user'
        );
        insertSdkMessageAt('t2-a1', sessionId, now + 5000, {
          type: 'assistant',
          uuid: 't2-a1',
          message: {
            content: [
              { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'bun test' } },
            ],
          },
        });

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
        expect(summaries[0].sessionId).toBe(sessionId);
        expect(summaries[0].turnIndex).toBe(2);
        const entries = summaries[0].entries as Array<Record<string, unknown>>;
        const toolEntry = entries.find((e) => e.kind === 'tool_use') as Record<string, unknown>;
        expect(toolEntry.toolName).toBe('Bash');
        expect(toolEntry.preview).toBe('bun test');
        expect(toolEntry.toolUseId).toBe('tu-1');
        const previews = entries.map((e) => String(e.preview ?? e.text ?? ''));
        expect(previews).not.toContain('closed-text');
      });

      test('keeps an in-turn prompt in the active roster but excludes a deferred one', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt(
          'u-enq',
          sessionId,
          now + 2000,
          { type: 'user', uuid: 'u-enq', message: { role: 'user', content: 'enq' } },
          'user'
        );
        db.prepare(
          `UPDATE sdk_messages SET send_status = 'enqueued', sdk_uuid = 'u-enq' WHERE id = 'u-enq'`
        ).run();
        insertSdkMessageAt(
          'u-def',
          sessionId,
          now + 3000,
          { type: 'user', uuid: 'u-def', message: { role: 'user', content: 'def' } },
          'user'
        );
        db.prepare(
          `UPDATE sdk_messages SET send_status = 'deferred', sdk_uuid = 'u-def' WHERE id = 'u-def'`
        ).run();
        insertSdkMessageAt(
          'a1',
          sessionId,
          now + 4000,
          {
            type: 'assistant',
            uuid: 'a1',
            message: { content: [{ type: 'text', text: 'working' }] },
          },
          'assistant'
        );

        const rows = (await runEntries(taskId)) as Array<{
          blockType: string;
          uuid: string;
        }>;
        const userUuids = rows
          .filter((r) => r.blockType === '__user_message' || r.blockType === '__user_replay')
          .map((r) => r.uuid);
        expect(userUuids).toContain('u-enq');
        expect(userUuids).not.toContain('u-def');
      });

      test('emits no summary when the latest turn is closed', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('a1', sessionId, now + 1000);
        insertResultAt('r1', sessionId, now + 2000, 'success');

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(0);
      });

      test('emits no summary when a hyperneo_action follows a closed result (#2338)', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('a1', sessionId, now + 1000);
        insertResultAt('r1', sessionId, now + 2000, 'success');
        insertSdkMessageAt(
          'ha-resume',
          sessionId,
          now + 3000,
          {
            type: 'hyperneo_action',
            action: 'sdk_resume_choice',
            uuid: 'ha-resume',
            session_id: sessionId,
            choices: [],
          } as Record<string, unknown>,
          'hyperneo_action'
        );

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(0);
      });

      test('stays active when the agent continues after a result in the same turn (#2338)', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt('a1', sessionId, now + 2000, {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
        });
        insertResultAt('r1', sessionId, now + 3000, 'success');
        insertSdkMessageAt('a2', sessionId, now + 4000, {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }],
          },
        });

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
        const entries = summaries[0].entries as Array<Record<string, unknown>>;
        expect(entries.map((e) => e.kind)).toContain('tool_use');
      });

      test('does not show the roster active for a failed user-only turn (#2338)', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt('a1', sessionId, now + 2000);
        insertResultAt('r1', sessionId, now + 3000, 'success');
        insertSdkMessageAt(
          'u-fail',
          sessionId,
          now + 4000,
          { type: 'user', message: { role: 'user', content: 'lost' } },
          'user'
        );

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(0);
      });

      test('does not fall back to an older turn when a newer user-only turn exists (#2338)', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt('a1', sessionId, now + 2000, {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
        });
        insertSdkMessageAt(
          'u-fail',
          sessionId,
          now + 3000,
          { type: 'user', message: { role: 'user', content: 'lost' } },
          'user'
        );

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(0);
      });

      test('a malformed-JSON system row does not abort the active-turn query (#2338)', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        insertSdkMessageAt('a1', sessionId, now + 1000, {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
        });
        db.prepare(
          `INSERT INTO sdk_messages (
             id, session_id, message_type, message_subtype, sdk_message, timestamp,
             send_status, origin, is_renderable, is_terminal, task_id,
             conversation_turn_index, sdk_uuid, replacement_metadata_normalized
           ) VALUES (?, ?, 'system', NULL, ?, ?, 'consumed', 'system', 1, 0, ?, NULL, NULL, 1)`
        ).run(
          'bad-json',
          sessionId,
          'not-well-formed{',
          new Date(now + 2000).toISOString(),
          taskId
        );

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
      });

      test('explodes assistant blocks into per-block entries (tool_use, text, thinking)', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('a1', sessionId, now + 1000, {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [
              { type: 'thinking', thinking: 'Considering options' },
              { type: 'text', text: 'Investigating the failing test' },
              { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
              { type: 'text', text: '   ' },
            ],
          },
        });

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
        const entries = summaries[0].entries as Array<Record<string, unknown>>;
        const kinds = entries.map((e) => e.kind);
        expect(kinds).toEqual(['thinking', 'text', 'tool_use']);
        expect(entries[0].preview).toBe('Considering options');
        expect(entries[1].text).toBe('Investigating the failing test');
        expect(entries[2].toolName).toBe('Bash');
        expect(entries[2].preview).toBe('ls');
      });

      test('emits api_retry rows with retry attempt, delay, and status details', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('a1', sessionId, now + 1000, {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [
              { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'bun test' } },
            ],
          },
        });
        insertSdkMessageAt(
          'retry-1',
          sessionId,
          now + 2000,
          {
            type: 'system',
            subtype: 'api_retry',
            uuid: 'retry-1',
            attempt: 2,
            max_retries: 3,
            retry_delay_ms: 5000,
            error_status: 429,
          },
          'system'
        );

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
        const entries = summaries[0].entries as Array<Record<string, unknown>>;
        expect(entries.map((e) => e.kind)).toEqual(['tool_use', 'api_retry']);
        expect(entries[1]).toMatchObject({
          kind: 'api_retry',
          attempt: 2,
          maxRetries: 3,
          retryDelayMs: 5000,
          errorStatus: 429,
          uuid: 'retry-1',
        });
      });

      test('keeps a retry-only turn active (api_retry before any assistant row) (#2338)', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt(
          'retry-only',
          sessionId,
          now + 2000,
          {
            type: 'system',
            subtype: 'api_retry',
            uuid: 'retry-only',
            attempt: 1,
            max_retries: 3,
            retry_delay_ms: 1000,
            error_status: 429,
          },
          'system'
        );

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
        const entries = summaries[0].entries as Array<Record<string, unknown>>;
        expect(entries.map((e) => e.kind)).toContain('api_retry');
      });

      test('keeps a hook-only turn active (a running hook before any assistant row) (#2338)', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        const hookBase = { hook_id: 'h1', hook_name: 'SessionStart', hook_event: 'SessionStart' };
        insertSdkMessageAt(
          'hk-start',
          sessionId,
          now + 2000,
          { type: 'system', subtype: 'hook_started', uuid: 'hk-start', ...hookBase },
          'system'
        );
        insertSdkMessageAt(
          'hk-prog',
          sessionId,
          now + 3000,
          {
            type: 'system',
            subtype: 'hook_progress',
            uuid: 'hk-prog',
            stdout: 'working',
            ...hookBase,
          },
          'system'
        );

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
        const hkEntries = (summaries[0].entries as Array<Record<string, unknown>>).filter(
          (e) => e.kind === 'hook'
        );
        expect(hkEntries.length).toBeGreaterThanOrEqual(1);
      });

      test('collapses hook_started→progress→response into one roster entry per hook_id', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('a1', sessionId, now + 1000, {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }],
          },
        });
        insertSdkMessageAt(
          'h1s',
          sessionId,
          now + 2000,
          {
            type: 'system',
            subtype: 'hook_started',
            hook_id: 'hook-A',
            hook_name: 'pre-commit',
            hook_event: 'PreToolUse',
            uuid: 'h1s',
          },
          'system'
        );
        insertSdkMessageAt(
          'h1p',
          sessionId,
          now + 3000,
          {
            type: 'system',
            subtype: 'hook_progress',
            hook_id: 'hook-A',
            hook_name: 'pre-commit',
            hook_event: 'PreToolUse',
            stdout: 'running checks',
            uuid: 'h1p',
          },
          'system'
        );
        insertSdkMessageAt(
          'h1r',
          sessionId,
          now + 4000,
          {
            type: 'system',
            subtype: 'hook_response',
            hook_id: 'hook-A',
            hook_name: 'pre-commit',
            hook_event: 'PreToolUse',
            outcome: 'success',
            stdout: 'all good',
            uuid: 'h1r',
          },
          'system'
        );
        insertSdkMessageAt(
          'h2s',
          sessionId,
          now + 5000,
          {
            type: 'system',
            subtype: 'hook_started',
            hook_id: 'hook-B',
            hook_name: 'lint',
            hook_event: 'PostToolUse',
            uuid: 'h2s',
          },
          'system'
        );

        const summaries = await buildSummaries(taskId);
        const entries = summaries[0].entries as Array<Record<string, unknown>>;
        const hooks = entries.filter((e) => e.kind === 'hook');
        expect(hooks).toHaveLength(2);
        const hookA = hooks.find((h) => h.hookName === 'pre-commit');
        const hookB = hooks.find((h) => h.hookName === 'lint');
        expect(hookA?.status).toBe('completed');
        expect(hookA?.hookEvent).toBe('PreToolUse');
        expect(hookB?.status).toBe('running');
      });

      test('breaks same-millisecond hook phase ties by insertion order (rowid)', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('a1', sessionId, now + 1000, {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }],
          },
        });
        const same = now + 2000;
        insertSdkMessageAt(
          'hs',
          sessionId,
          same,
          {
            type: 'system',
            subtype: 'hook_started',
            hook_id: 'h-tie',
            hook_name: 'fast',
            hook_event: 'PreToolUse',
            uuid: 'hs',
          },
          'system'
        );
        insertSdkMessageAt(
          'hp',
          sessionId,
          same,
          {
            type: 'system',
            subtype: 'hook_progress',
            hook_id: 'h-tie',
            hook_name: 'fast',
            hook_event: 'PreToolUse',
            stdout: 'mid',
            uuid: 'hp',
          },
          'system'
        );
        insertSdkMessageAt(
          'hr',
          sessionId,
          same,
          {
            type: 'system',
            subtype: 'hook_response',
            hook_id: 'h-tie',
            hook_name: 'fast',
            hook_event: 'PreToolUse',
            outcome: 'success',
            stdout: 'done',
            uuid: 'hr',
          },
          'system'
        );

        const summaries = await buildSummaries(taskId);
        const hooks = (summaries[0].entries as Array<Record<string, unknown>>).filter(
          (e) => e.kind === 'hook'
        );
        expect(hooks).toHaveLength(1);
        expect(hooks[0].status).toBe('completed');
      });

      test('distinguishes real human input from synthetic agent handoffs via isReplay', async () => {
        const humanSession = 'sess-human';
        const handoffSession = 'sess-handoff';
        const taskId = insertSpaceTask({ taskAgentSessionId: humanSession });
        insertSession(humanSession, 'space_task_agent', '{"status":"processing"}');
        insertSession(handoffSession, 'space_task_agent', '{"status":"processing"}');
        sessionTaskIds.set(handoffSession, taskId);

        insertSdkMessageAt(
          'u-human',
          humanSession,
          now + 1000,
          { type: 'user', uuid: 'u-human', message: { role: 'user', content: 'please retry' } },
          'user'
        );
        insertSdkMessageAt('a-human', humanSession, now + 2000, {
          type: 'assistant',
          uuid: 'a-human',
          message: {
            content: [{ type: 'tool_use', id: 'tu-h', name: 'Bash', input: { command: 'ls' } }],
          },
        });
        insertSdkMessageAt(
          'u-handoff',
          handoffSession,
          now + 3000,
          {
            type: 'user',
            uuid: 'u-handoff',
            isReplay: true,
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'Reviewer Agent: take over' }],
            },
          },
          'user'
        );
        insertSdkMessageAt('a-handoff', handoffSession, now + 4000, {
          type: 'assistant',
          uuid: 'a-handoff',
          message: {
            content: [{ type: 'tool_use', id: 'tu-x', name: 'Bash', input: { command: 'ls' } }],
          },
        });

        const summaries = await buildSummaries(taskId);
        const allEntries = summaries.flatMap((s) => s.entries as Array<Record<string, unknown>>);
        const kinds = allEntries.map((e) => e.kind);
        expect(kinds).toContain('user_message');
        expect(kinds).toContain('agent_handoff');
        const userEntry = allEntries.find((e) => e.kind === 'user_message') as Record<
          string,
          unknown
        >;
        const handoffEntry = allEntries.find((e) => e.kind === 'agent_handoff') as Record<
          string,
          unknown
        >;
        expect(userEntry.text).toBe('please retry');
        expect(handoffEntry.text).toBe('Reviewer Agent: take over');
      });

      test('skips user rows whose content is exclusively tool_result blocks', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          {
            type: 'user',
            uuid: 'u1',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-x',
                  content: [{ type: 'text', text: 'tool output' }],
                },
              ],
            },
          },
          'user'
        );
        insertSdkMessageAt('a1', sessionId, now + 2000, {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }],
          },
        });

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
        const entries = summaries[0].entries as Array<Record<string, unknown>>;
        const kinds = entries.map((e) => e.kind);
        expect(kinds).not.toContain('user_message');
        expect(kinds).not.toContain('agent_handoff');
        expect(kinds).toContain('tool_use');
      });

      test('produces independent summaries per session when multiple sessions are active', async () => {
        const orchestrationSessionId = 'space:test:task:ates-orch';
        const nodeSessionId = 'space:test:task:atea-node';
        const workflowRunId = 'wr-active-turn-multi';
        const workflowNodeId = 'node-multi';
        const taskId = insertSpaceTask({
          taskAgentSessionId: orchestrationSessionId,
          workflowRunId,
        });

        insertSession(orchestrationSessionId, 'space_task_agent', '{"status":"processing"}');
        insertSession(nodeSessionId, 'worker', '{"status":"processing"}');

        insertNodeExecution({
          id: 'ne-multi',
          workflowRunId,
          workflowNodeId,
          agentName: 'coder',
          agentSessionId: nodeSessionId,
          status: 'in_progress',
        });

        insertSdkMessageAt('orch-a1', orchestrationSessionId, now + 1000, {
          type: 'assistant',
          uuid: 'orch-a1',
          message: { content: [{ type: 'text', text: 'orch active' }] },
        });
        insertSdkMessageAt('node-a1', nodeSessionId, now + 1000, {
          type: 'assistant',
          uuid: 'node-a1',
          message: { content: [{ type: 'text', text: 'node active' }] },
        });

        const summaries = await buildSummaries(taskId);
        const bySession = new Map(summaries.map((s) => [s.sessionId, s]));
        expect(bySession.has(orchestrationSessionId)).toBe(true);
        expect(bySession.has(nodeSessionId)).toBe(true);
        const orchEntries = bySession.get(orchestrationSessionId)!.entries as Array<
          Record<string, unknown>
        >;
        const nodeEntries = bySession.get(nodeSessionId)!.entries as Array<Record<string, unknown>>;
        expect(orchEntries.map((e) => e.text)).toContain('orch active');
        expect(nodeEntries.map((e) => e.text)).toContain('node active');
      });

      test('partitions hook runs per session — a shared hook_id cannot collapse two sessions', async () => {
        const orchestrationSessionId = 'space:test:task:hp-orch';
        const nodeSessionId = 'space:test:task:hp-node';
        const workflowRunId = 'wr-hook-partition';
        const workflowNodeId = 'node-hook-part';
        const taskId = insertSpaceTask({
          taskAgentSessionId: orchestrationSessionId,
          workflowRunId,
        });
        insertSession(orchestrationSessionId, 'space_task_agent', '{"status":"processing"}');
        insertSession(nodeSessionId, 'worker', '{"status":"processing"}');
        insertNodeExecution({
          id: 'ne-hook-part',
          workflowRunId,
          workflowNodeId,
          agentName: 'coder',
          agentSessionId: nodeSessionId,
          status: 'in_progress',
        });

        const shared = { hook_id: 'h-shared', hook_name: 'lint', hook_event: 'PreToolUse' };
        for (const [sid, prefix] of [
          [orchestrationSessionId, 'o'],
          [nodeSessionId, 'n'],
        ] as const) {
          insertSdkMessageAt(`${prefix}-a`, sid, now + 500, {
            type: 'assistant',
            uuid: `${prefix}-a`,
            message: { content: [{ type: 'text', text: `${prefix} active` }] },
          });
          insertSdkMessageAt(
            `${prefix}-hs`,
            sid,
            now + 1000,
            { type: 'system', subtype: 'hook_started', uuid: `${prefix}-hs`, ...shared },
            'system'
          );
          insertSdkMessageAt(
            `${prefix}-hr`,
            sid,
            now + 1000,
            {
              type: 'system',
              subtype: 'hook_response',
              uuid: `${prefix}-hr`,
              outcome: 'success',
              ...shared,
            },
            'system'
          );
        }

        const summaries = await buildSummaries(taskId);
        const bySession = new Map(summaries.map((s) => [s.sessionId, s]));
        for (const sid of [orchestrationSessionId, nodeSessionId]) {
          const hooks = (bySession.get(sid)!.entries as Array<Record<string, unknown>>).filter(
            (e) => e.kind === 'hook'
          );
          expect(hooks, `${sid} hook was dropped by a cross-session partition`).toHaveLength(1);
          expect(hooks[0].hookName).toBe('lint');
          expect(hooks[0].status).toBe('completed');
        }
      });

      test('messages.bySession orders same-millisecond hook phases by insertion order (rowid)', async () => {
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        const same = now + 1000;
        const base = { hook_id: 'h-fast', hook_name: 'fast', hook_event: 'PreToolUse' };
        insertSdkMessageAt(
          'hz',
          sessionId,
          same,
          { type: 'system', subtype: 'hook_started', uuid: 'hz', ...base },
          'system'
        );
        insertSdkMessageAt(
          'hy',
          sessionId,
          same,
          { type: 'system', subtype: 'hook_progress', uuid: 'hy', stdout: 'mid', ...base },
          'system'
        );
        insertSdkMessageAt(
          'hx',
          sessionId,
          same,
          {
            type: 'system',
            subtype: 'hook_response',
            uuid: 'hx',
            outcome: 'success',
            ...base,
          },
          'system'
        );

        const entry = NAMED_QUERY_REGISTRY.get('messages.bySession')!;
        const rows = db.prepare(entry.sql).all(sessionId, 100) as Array<{ content: string }>;
        const subtypes = rows
          .map((r) => JSON.parse(r.content) as { subtype?: string })
          .filter((m) => typeof m.subtype === 'string' && m.subtype.startsWith('hook_'))
          .map((m) => m.subtype);
        expect(subtypes).toEqual(['hook_started', 'hook_progress', 'hook_response']);
      });

      test('orders same-millisecond tool_use and hook by insertion order, not UUID id', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        const same = now + 1000;
        insertSdkMessageAt('tzzz-a', sessionId, same, {
          type: 'assistant',
          uuid: 'tzzz-a',
          message: {
            content: [
              { type: 'tool_use', id: 'tu-trigger', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        });
        insertSdkMessageAt(
          'haaa',
          sessionId,
          same,
          {
            type: 'system',
            subtype: 'hook_started',
            uuid: 'haaa',
            hook_id: 'h1',
            hook_name: 'lint',
            hook_event: 'PreToolUse',
          },
          'system'
        );

        const summaries = await buildSummaries(taskId);
        const kinds = (summaries[0].entries as Array<Record<string, unknown>>).map((e) => e.kind);
        expect(kinds).toEqual(['tool_use', 'hook']);
      });
    });

    describe('compact-feed cap and active-turn-summary decoupling', () => {
      function insertSdkMessageAt(
        id: string,
        sessionIdValue: string,
        timestampMs: number,
        sdkMessage?: Record<string, unknown>,
        messageType = 'assistant'
      ): void {
        const iso = new Date(timestampMs).toISOString();
        const payload =
          sdkMessage ??
          ({
            type: 'assistant',
            uuid: id,
            message: { role: 'assistant', content: [{ type: 'text', text: id }] },
          } as Record<string, unknown>);
        const sdkLike = { type: messageType, ...payload } as unknown as SDKMessage;
        const isRenderable = computeIsRenderable(sdkLike);
        const isTerminal = computeIsTerminal(sdkLike);
        const parentToolUseId = extractParentToolUseId(sdkLike);
        const taskIdForSession = sessionTaskIds.get(sessionIdValue) ?? null;
        db.exec(`
					INSERT INTO sdk_messages (
						id, session_id, message_type, message_subtype, sdk_message, timestamp,
						send_status, origin, is_renderable, is_terminal, parent_tool_use_id, task_id
					) VALUES (
						'${id}', '${sessionIdValue}', '${messageType}', NULL, '${JSON.stringify(payload).replace(/'/g, "''")}',
						'${iso}', 'consumed', 'system', ${isRenderable}, ${isTerminal},
						${parentToolUseId ? `'${parentToolUseId}'` : 'NULL'},
						${taskIdForSession ? `'${taskIdForSession}'` : 'NULL'}
					)
				`);
      }

      function queryCompact(taskId: string): Record<string, unknown>[] {
        backfillConversationTurns();
        const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask.compact')!;
        const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
        return entry.mapRow ? rows.map(entry.mapRow) : rows;
      }

      async function runEntries(taskId: string): Promise<Record<string, unknown>[]> {
        backfillConversationTurns();
        const mod = await import('../../../../src/lib/rpc-handlers/live-query-handlers');
        const sql = mod.SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL;
        return db.prepare(sql).all(taskId) as Record<string, unknown>[];
      }

      async function buildSummaries(taskId: string): Promise<
        Array<{
          sessionId: string;
          turnIndex: number;
          entries: Record<string, unknown>[];
        }>
      > {
        const mod = await import('../../../../src/lib/rpc-handlers/live-query-handlers');
        const rows = await runEntries(taskId);
        return mod.buildActiveTurnSummariesFromRows(rows);
      }

      test('compact feed excludes hook_* system rows (roster-only via active-turn summary)', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        insertSdkMessageAt('a1', sessionId, now + 1000, {
          type: 'assistant',
          uuid: 'a1',
          message: { content: [{ type: 'text', text: 'hi' }] },
        });
        for (const [sub, id] of [
          ['hook_started', 'hs'],
          ['hook_progress', 'hp'],
          ['hook_response', 'hr'],
        ] as const) {
          insertSdkMessageAt(
            id,
            sessionId,
            now + 2000,
            {
              type: 'system',
              subtype: sub,
              uuid: id,
              hook_id: 'h1',
              hook_name: 'lint',
              hook_event: 'PreToolUse',
              ...(sub === 'hook_response' ? { outcome: 'success' } : {}),
            },
            'system'
          );
        }

        const ids = queryCompact(taskId).map((r) => String(r.id));
        expect(ids).toContain('a1');
        expect(ids).not.toContain('hs');
        expect(ids).not.toContain('hp');
        expect(ids).not.toContain('hr');
      });

      test('hook burst does not consume the compact tail (excluded before ranking)', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        insertSdkMessageAt('a-old', sessionId, now + 1000, {
          type: 'assistant',
          uuid: 'a-old',
          message: { content: [{ type: 'text', text: 'real work' }] },
        });
        for (let i = 0; i < 6; i += 1) {
          insertSdkMessageAt(
            `hp${i}`,
            sessionId,
            now + 2000 + i,
            {
              type: 'system',
              subtype: 'hook_progress',
              uuid: `hp${i}`,
              hook_id: 'h1',
              hook_name: 'lint',
              hook_event: 'PreToolUse',
              stdout: `phase ${i}`,
            },
            'system'
          );
        }

        const ids = queryCompact(taskId).map((r) => String(r.id));
        expect(ids).toContain('a-old');
        for (let i = 0; i < 6; i += 1) expect(ids).not.toContain(`hp${i}`);
      });

      test('malformed system sdk_message does not break the compact feed', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        insertSdkMessageAt('a-good', sessionId, now + 1000, {
          type: 'assistant',
          uuid: 'a-good',
          message: { content: [{ type: 'text', text: 'ok' }] },
        });
        insertSdkMessageAt(
          'bad-sys',
          sessionId,
          now + 2000,
          { type: 'system', subtype: 'informational', uuid: 'bad-sys' },
          'system'
        );
        db.exec('PRAGMA ignore_check_constraints = ON');
        db.exec('DROP INDEX IF EXISTS idx_sdk_messages_uuid_status');
        db.prepare(`UPDATE sdk_messages SET sdk_message = ? WHERE id = ?`).run(
          '{not-json',
          'bad-sys'
        );
        db.exec('PRAGMA ignore_check_constraints = OFF');

        const ids = queryCompact(taskId).map((r) => String(r.id));
        expect(ids).toContain('a-good');
      });

      test('malformed assistant sdk_message does not break the compact feed (#2338)', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');
        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          { type: 'user', message: { role: 'user', content: 'go' } },
          'user'
        );
        insertSdkMessageAt('a-good', sessionId, now + 2000, {
          type: 'assistant',
          uuid: 'a-good',
          message: { content: [{ type: 'text', text: 'ok' }] },
        });
        insertSdkMessageAt('bad-asst', sessionId, now + 3000, {
          type: 'assistant',
          uuid: 'bad-asst',
          message: { content: [{ type: 'text', text: 'bad' }] },
        });
        db.exec('PRAGMA ignore_check_constraints = ON');
        db.exec('DROP INDEX IF EXISTS idx_sdk_messages_uuid_status');
        db.prepare(`UPDATE sdk_messages SET sdk_message = ? WHERE id = ?`).run(
          '{not-json',
          'bad-asst'
        );
        db.exec('PRAGMA ignore_check_constraints = OFF');

        const ids = queryCompact(taskId).map((r) => String(r.id));
        expect(ids).toContain('a-good');
        expect(ids).not.toContain('bad-asst');
      });

      test('long active turn: compact feed ≤5 non-terminal rows AND summary carries every entry', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        const turnSize = 8;
        const toolNames = [
          'Bash',
          'Read',
          'Grep',
          'Glob',
          'Edit',
          'Write',
          'WebFetch',
          'WebSearch',
        ];
        for (let i = 0; i < turnSize; i += 1) {
          insertSdkMessageAt(`a${i}`, sessionId, now + (i + 1) * 1000, {
            type: 'assistant',
            uuid: `a${i}`,
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: `tu-a${i}`,
                  name: toolNames[i],
                  input: { foo: i },
                },
              ],
            },
          });
        }

        const compactRows = queryCompact(taskId);
        expect(compactRows.length).toBeLessThanOrEqual(5);
        expect(turnSize).toBeGreaterThan(compactRows.length);

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
        const entries = summaries[0].entries as Array<Record<string, unknown>>;
        expect(entries).toHaveLength(turnSize);
        expect(entries.map((e) => e.toolName)).toEqual(toolNames);
        expect(entries.length).toBeGreaterThan(compactRows.length);
      });

      test('active summaries use full-block semantics for tool previews', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        const blocks = [
          {
            id: 'bash',
            name: 'Bash',
            input: { description: 'Run the focused tests', command: 'bun test raw-command' },
          },
          {
            id: 'todo',
            name: 'TodoWrite',
            input: {
              todos: [
                {
                  content: 'Run validation',
                  activeForm: 'Running validation',
                  status: 'in_progress',
                },
              ],
            },
          },
          {
            id: 'mcp',
            name: 'mcp__node-agent__send_message',
            input: { message: 'opaque raw payload' },
          },
          {
            id: 'question',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Which validation path should run?' }] },
          },
          {
            id: 'multi-edit',
            name: 'MultiEdit',
            input: { file_path: '/repo/packages/web/src/MinimalThreadFeed.tsx' },
          },
          {
            id: 'lifecycle',
            name: 'EnterPlanMode',
            input: {},
          },
        ];

        for (let i = 0; i < blocks.length; i += 1) {
          const block = blocks[i];
          insertSdkMessageAt(block.id, sessionId, now + (i + 1) * 1000, {
            type: 'assistant',
            uuid: block.id,
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: `tu-${block.id}`,
                  name: block.name,
                  input: block.input,
                },
              ],
            },
          });
        }
        insertSdkMessageAt('thinking', sessionId, now + 7000, {
          type: 'assistant',
          uuid: 'thinking',
          message: {
            content: [
              {
                type: 'thinking',
                thinking: 'First line\nSecond line with detail',
              },
            ],
          },
        });

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
        const entries = summaries[0].entries as Array<Record<string, unknown>>;

        expect(entries[0]).toMatchObject({
          kind: 'tool_use',
          toolName: 'Bash',
          preview: 'Run the focused tests',
        });
        expect(entries[1]).toMatchObject({
          kind: 'tool_use',
          toolName: 'TodoWrite',
          preview: 'Running: Running validation',
        });
        expect(entries[2]).toMatchObject({
          kind: 'tool_use',
          toolName: 'mcp__node-agent__send_message',
          preview: '',
        });
        expect(entries[3]).toMatchObject({
          kind: 'tool_use',
          toolName: 'AskUserQuestion',
          preview: 'Which validation path should run?',
        });
        expect(entries[4]).toMatchObject({
          kind: 'tool_use',
          toolName: 'MultiEdit',
          preview: 'MinimalThreadFeed.tsx',
        });
        expect(entries[5]).toMatchObject({
          kind: 'tool_use',
          toolName: 'EnterPlanMode',
          preview: 'Entering plan mode',
        });
        expect(entries[6]).toMatchObject({
          kind: 'thinking',
          preview: 'First line\nSecond line with detail',
        });
      });
    });
  });

  describe.skip('legacy goals.byRoom registry shape (retired public query)', () => {
    function insertGoal(overrides: Record<string, unknown> = {}): string {
      const id = `goal-${Date.now()}-${Math.random()}`;
      const linkedTaskIds = JSON.stringify(overrides.linkedTaskIds ?? []);
      const metrics = JSON.stringify(overrides.metrics ?? {});
      db.exec(`
				INSERT INTO goals (
					id, room_id, title, description, status, priority, progress,
					linked_task_ids, metrics, created_at, updated_at
				) VALUES (
					'${id}', '${roomId}', 'Test Goal', 'Desc', 'active', 'normal', 0,
					'${linkedTaskIds}', '${metrics}', ${now}, ${now}
				)
			`);
      return id;
    }

    function queryAndMap(): Record<string, unknown>[] {
      const entry = NAMED_QUERY_REGISTRY.get('goals.byRoom')!;
      const rows = db.prepare(entry.sql).all(roomId) as Record<string, unknown>[];
      return entry.mapRow ? rows.map(entry.mapRow) : rows;
    }

    test('returns camelCase roomId column', () => {
      insertGoal();
      const [row] = queryAndMap();
      expect(row).toHaveProperty('roomId', roomId);
      expect(row).not.toHaveProperty('room_id');
    });

    test('metrics is parsed as an object (empty object by default)', () => {
      insertGoal();
      const [row] = queryAndMap();
      expect(typeof row.metrics).toBe('object');
      expect(row.metrics).toEqual({});
    });

    test('metrics is parsed as an object with values', () => {
      insertGoal({ metrics: { velocity: 42, bugs: 3 } });
      const [row] = queryAndMap();
      expect(row.metrics).toEqual({ velocity: 42, bugs: 3 });
    });

    test('linkedTaskIds is parsed as string[] (empty array by default)', () => {
      insertGoal();
      const [row] = queryAndMap();
      expect(Array.isArray(row.linkedTaskIds)).toBe(true);
      expect(row.linkedTaskIds).toEqual([]);
    });

    test('linkedTaskIds is parsed as string[] with values', () => {
      insertGoal({ linkedTaskIds: ['task-x', 'task-y'] });
      const [row] = queryAndMap();
      expect(row.linkedTaskIds).toEqual(['task-x', 'task-y']);
    });

    test('planning_attempts remains snake_case (not aliased to camelCase)', () => {
      insertGoal();
      const [row] = queryAndMap();
      expect(row).toHaveProperty('planning_attempts');
      expect(row).not.toHaveProperty('planningAttempts');
    });

    test('goal_review_attempts remains snake_case (not aliased to camelCase)', () => {
      insertGoal();
      const [row] = queryAndMap();
      expect(row).toHaveProperty('goal_review_attempts');
      expect(row).not.toHaveProperty('goalReviewAttempts');
    });

    test('schedulePaused is converted from SQLite integer to boolean', () => {
      insertGoal();
      const [row] = queryAndMap();
      expect(row.schedulePaused).toBe(false);
    });

    test('structuredMetrics is undefined when null in DB', () => {
      insertGoal();
      const [row] = queryAndMap();
      expect(row.structuredMetrics).toBeUndefined();
    });

    test('schedule is undefined when null in DB', () => {
      insertGoal();
      const [row] = queryAndMap();
      expect(row.schedule).toBeUndefined();
    });

    test('row shape matches RoomGoal interface end-to-end', () => {
      insertGoal({ metrics: { coverage: 80 }, linkedTaskIds: ['t1'] });
      const [row] = queryAndMap();

      const _typed = row as unknown as RoomGoal;

      expect(typeof _typed.id).toBe('string');
      expect(typeof _typed.roomId).toBe('string');
      expect(Array.isArray(_typed.linkedTaskIds)).toBe(true);
      expect(typeof _typed.metrics).toBe('object');
    });

    test('ORDER BY is priority DESC, created_at ASC, id ASC (deterministic tiebreaker)', () => {
      const sql = NAMED_QUERY_REGISTRY.get('goals.byRoom')!.sql;
      expect(sql).toContain('ORDER BY priority DESC, created_at ASC, id ASC');
    });

    describe('defensive JSON parsing for schedule and structuredMetrics', () => {
      function insertGoalRaw(overrides: Record<string, unknown> = {}): string {
        const id = `goal-${Date.now()}-${Math.random()}`;
        const linkedTaskIds = JSON.stringify(overrides.linkedTaskIds ?? []);
        const metrics = JSON.stringify(overrides.metrics ?? {});
        const schedule = overrides.schedule != null ? `'${String(overrides.schedule)}'` : 'NULL';
        const structuredMetrics =
          overrides.structuredMetrics != null ? `'${String(overrides.structuredMetrics)}'` : 'NULL';
        db.exec(`
					INSERT INTO goals (
						id, room_id, title, description, status, priority, progress,
						linked_task_ids, metrics, created_at, updated_at,
						schedule, structured_metrics
					) VALUES (
						'${id}', '${roomId}', 'Test Goal', 'Desc', 'active', 'normal', 0,
						'${linkedTaskIds}', '${metrics}', ${now}, ${now},
						${schedule}, ${structuredMetrics}
					)
				`);
        return id;
      }

      test('raw cron string in schedule column does not crash — returns undefined', () => {
        insertGoalRaw({ schedule: '@daily' });
        const [row] = queryAndMap();
        expect(row.schedule).toBeUndefined();
      });

      test('valid JSON schedule parses correctly', () => {
        const scheduleJson = JSON.stringify({ expression: '@daily', timezone: 'UTC' });
        insertGoalRaw({ schedule: scheduleJson });
        const [row] = queryAndMap();
        expect(row.schedule).toEqual({ expression: '@daily', timezone: 'UTC' });
      });

      test('corrupted JSON in structuredMetrics column does not crash', () => {
        insertGoalRaw({ structuredMetrics: 'corrupted{json' });
        const [row] = queryAndMap();
        expect(row.structuredMetrics).toBeUndefined();
      });

      test('valid JSON structuredMetrics parses correctly', () => {
        const metricsJson = JSON.stringify([{ name: 'coverage', target: 80, current: 60 }]);
        insertGoalRaw({ structuredMetrics: metricsJson });
        const [row] = queryAndMap();
        expect(row.structuredMetrics).toEqual([{ name: 'coverage', target: 80, current: 60 }]);
      });

      test('corrupted JSON in schedule column does not crash', () => {
        insertGoalRaw({ schedule: 'not-valid-json{' });
        const [row] = queryAndMap();
        expect(row.schedule).toBeUndefined();
      });
    });
  });

  describe('sessionGroupMessages.byGroup', () => {
    const groupId = 'group-contract-test';
    const taskId = 'task-contract-test';
    const workerSessionId = 'worker-session-contract';
    const leaderSessionId = 'leader-session-contract';

    function insertTask(): void {
      db.exec(
        `INSERT OR IGNORE INTO tasks (id, room_id, title, description, status, priority, depends_on, created_at, updated_at)
				 VALUES ('${taskId}', '${roomId}', 'Task', 'Desc', 'in_progress', 'normal', '[]', ${Date.now()}, ${Date.now()})`
      );
    }

    function insertGroup(): void {
      db.exec(
        `INSERT OR IGNORE INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
				 VALUES ('${groupId}', 'task', '${taskId}', 0,
				 '${JSON.stringify({ workerRole: 'coder', feedbackIteration: 2, submittedForReview: false })}',
				 ${Date.now()})`
      );
      db.exec(
        `INSERT OR IGNORE INTO session_group_members (group_id, session_id, role, joined_at)
				 VALUES ('${groupId}', '${workerSessionId}', 'worker', ${Date.now()}),
						('${groupId}', '${leaderSessionId}', 'leader', ${Date.now()})`
      );
    }

    function insertSdkMessage(
      sessionId: string,
      id: string,
      timestampMs: number,
      subtype: string | null = null,
      sdkUuid = id
    ): void {
      db.exec(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status)
				 VALUES ('${id}', '${sessionId}', 'assistant', ${subtype ? `'${subtype}'` : 'NULL'},
				 '${JSON.stringify({ type: 'assistant', uuid: sdkUuid, message: { content: [] } })}',
				 '${new Date(timestampMs).toISOString()}', 'consumed')`
      );
    }

    function insertEvent(kind: string, payload: Record<string, unknown>, createdAt: number): void {
      db.exec(
        `INSERT INTO task_group_events (group_id, kind, payload_json, created_at)
				 VALUES ('${groupId}', '${kind}', '${JSON.stringify(payload)}', ${createdAt})`
      );
    }

    function executeSQLAndMap(): Record<string, unknown>[] {
      const entry = NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!;
      const rows = db.prepare(entry.sql).all(groupId) as Record<string, unknown>[];
      return entry.mapRow ? rows.map(entry.mapRow) : rows;
    }

    test('SQL executes without error against the real schema', () => {
      insertTask();
      insertGroup();
      expect(() => executeSQLAndMap()).not.toThrow();
    });

    test('returns empty array when no sdk/event rows exist for the group', () => {
      insertTask();
      insertGroup();
      const rows = executeSQLAndMap();
      expect(rows).toEqual([]);
    });

    test('returns camelCase row shape and injects _taskMeta for sdk messages', () => {
      insertTask();
      insertGroup();
      insertSdkMessage(workerSessionId, 'worker-msg-1', 1000);
      insertSdkMessage(leaderSessionId, 'leader-msg-1', 2000);

      const rows = executeSQLAndMap();
      expect(rows.length).toBe(2);

      const workerRow = rows[0];
      expect(workerRow).toHaveProperty('groupId', groupId);
      expect(workerRow).toHaveProperty('sessionId', workerSessionId);
      expect(workerRow).toHaveProperty('messageType', 'assistant');
      expect(workerRow).toHaveProperty('createdAt');

      const parsed = JSON.parse(workerRow.content as string) as Record<string, unknown>;
      const meta = parsed._taskMeta as Record<string, unknown>;
      expect(meta.authorRole).toBe('coder');
      expect(meta.authorSessionId).toBe(workerSessionId);
      expect(meta.iteration).toBeUndefined();
      expect(typeof meta.turnId).toBe('string');
      expect(parsed.uuid).toBe('worker-msg-1');
    });

    test('includes operational sdk rows when building the group timeline', () => {
      insertTask();
      insertGroup();
      insertSdkMessage(workerSessionId, 'visible-worker-msg', 1000);
      for (const subtype of ['thinking_tokens', 'session_state_changed', 'commands_changed']) {
        insertSdkMessage(workerSessionId, `operational-${subtype}`, 2000, subtype);
      }

      const rows = executeSQLAndMap();

      expect(rows.map((row) => row.id)).toEqual([
        'visible-worker-msg',
        'operational-commands_changed',
        'operational-session_state_changed',
        'operational-thinking_tokens',
      ]);
    });

    test('includes rows retracted by refusal fallback notices when building the group timeline', () => {
      insertTask();
      insertGroup();
      insertSdkMessage(
        workerSessionId,
        'row-retracted-worker-msg',
        1000,
        null,
        'retracted-worker-msg'
      );
      insertSdkMessage(workerSessionId, 'visible-worker-msg', 2000);
      db.exec(`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status)
				 VALUES ('fallback-notice', '${workerSessionId}', 'system', 'model_refusal_fallback',
				 '${JSON.stringify({ type: 'system', subtype: 'model_refusal_fallback', retracted_message_uuids: ['retracted-worker-msg'] })}',
				 '${new Date(3000).toISOString()}', 'consumed')`);

      const rows = executeSQLAndMap();

      expect(rows.map((row) => row.id)).toEqual([
        'row-retracted-worker-msg',
        'visible-worker-msg',
        'fallback-notice',
      ]);
    });

    test('event rows keep null sessionId and status text extraction', () => {
      insertTask();
      insertGroup();
      insertEvent('status', { text: 'Mid status marker' }, 1500);

      const [row] = executeSQLAndMap();
      expect(row.sessionId).toBeNull();
      expect(row.messageType).toBe('status');
      expect(row.content).toBe('Mid status marker');
    });

    test('has mapRow to enrich sdk content payloads', () => {
      const entry = NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!;
      expect(typeof entry.mapRow).toBe('function');
    });

    test('SQL targets canonical sdk_messages + task_group_events sources', () => {
      const entry = NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!;
      expect(entry.sql).toContain('FROM session_groups');
      expect(entry.sql).toContain('JOIN session_group_members');
      expect(entry.sql).toContain('JOIN sdk_messages');
      expect(entry.sql).toContain('JOIN task_group_events');
    });

    test('SQL filters by group id via target_group CTE', () => {
      const entry = NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!;
      expect(entry.sql).toContain('WHERE id = ?');
    });

    test('ORDER BY is createdAt ASC, id ASC (deterministic tiebreaker)', () => {
      const sql = NAMED_QUERY_REGISTRY.get('sessionGroupMessages.byGroup')!.sql;
      expect(sql).toContain('ORDER BY createdAt ASC, id ASC');
    });
  });

  describe.skip('legacy skills.byRoom registry shape (retired public query)', () => {
    function insertSkill(
      id: string,
      name: string,
      opts: { enabled?: boolean; builtIn?: boolean } = {}
    ): void {
      const enabled = opts.enabled ?? true;
      const builtIn = opts.builtIn ? 1 : 0;
      const config = JSON.stringify({ type: 'builtin', commandName: name });
      db.exec(`
				INSERT INTO skills (id, name, display_name, description, source_type, config, enabled, built_in, validation_status, created_at)
				VALUES ('${id}', '${name}', '${name}', '${name} skill', 'builtin', '${config}', ${enabled ? 1 : 0}, ${builtIn}, 'valid', ${now})
			`);
    }

    function setOverride(roomId: string, skillId: string, enabled: boolean): void {
      db.exec(`
				INSERT INTO room_skill_overrides (skill_id, room_id, enabled)
				VALUES ('${skillId}', '${roomId}', ${enabled ? 1 : 0})
			`);
    }

    function queryAndMap(): Record<string, unknown>[] {
      const entry = NAMED_QUERY_REGISTRY.get('skills.byRoom')!;
      const rows = db.prepare(entry.sql).all(roomId) as Record<string, unknown>[];
      return entry.mapRow ? rows.map(entry.mapRow) : rows;
    }

    test('returns global enabled when no room override row exists', () => {
      insertSkill('s-1', 'alpha', { enabled: true });
      insertSkill('s-2', 'beta', { enabled: false });

      const rows = queryAndMap();
      expect(rows).toHaveLength(2);
      const alpha = rows.find((r) => r.name === 'alpha')!;
      const beta = rows.find((r) => r.name === 'beta')!;
      expect(alpha.enabled).toBe(true);
      expect(beta.enabled).toBe(false);
      expect(alpha.overriddenByRoom).toBe(false);
      expect(beta.overriddenByRoom).toBe(false);
    });

    test('returns room override enabled when override row exists', () => {
      insertSkill('s-1', 'alpha', { enabled: true });
      insertSkill('s-2', 'beta', { enabled: true });

      setOverride(roomId, 's-1', false);

      const rows = queryAndMap();
      const alpha = rows.find((r) => r.name === 'alpha')!;
      const beta = rows.find((r) => r.name === 'beta')!;
      expect(alpha.enabled).toBe(false);
      expect(alpha.overriddenByRoom).toBe(true);
      expect(beta.enabled).toBe(true);
      expect(beta.overriddenByRoom).toBe(false);
    });

    test('room override can enable a globally disabled skill', () => {
      insertSkill('s-1', 'alpha', { enabled: false });
      setOverride(roomId, 's-1', true);

      const [row] = queryAndMap();
      expect(row.enabled).toBe(true);
      expect(row.overriddenByRoom).toBe(true);
    });

    test('config is parsed as JSON object', () => {
      insertSkill('s-1', 'alpha');
      const [row] = queryAndMap();
      expect(typeof row.config).toBe('object');
      expect(row.config).toEqual({ type: 'builtin', commandName: 'alpha' });
    });

    test('builtIn is converted from SQLite integer to boolean', () => {
      insertSkill('s-1', 'builtin-skill', { builtIn: true });
      insertSkill('s-2', 'custom-skill', { builtIn: false });

      const rows = queryAndMap();
      const builtin = rows.find((r) => r.name === 'builtin-skill')!;
      const custom = rows.find((r) => r.name === 'custom-skill')!;
      expect(builtin.builtIn).toBe(true);
      expect(custom.builtIn).toBe(false);
    });

    test('displayName and sourceType are camelCase aliases', () => {
      insertSkill('s-1', 'alpha');
      const [row] = queryAndMap();
      expect(row).toHaveProperty('displayName', 'alpha');
      expect(row).toHaveProperty('sourceType', 'builtin');
      expect(row).not.toHaveProperty('display_name');
      expect(row).not.toHaveProperty('source_type');
    });

    test('ORDER BY is built_in DESC, created_at ASC, id ASC (deterministic)', () => {
      const sql = NAMED_QUERY_REGISTRY.get('skills.byRoom')!.sql;
      expect(sql).toContain('ORDER BY s.built_in DESC, s.created_at ASC, s.id ASC');
    });

    test('LEFT JOIN preserves skills with no override row', () => {
      insertSkill('s-1', 'no-override');
      const rows = queryAndMap();
      expect(rows).toHaveLength(1);
      expect(rows[0].overriddenByRoom).toBe(false);
    });

    test('has mapRow function', () => {
      const entry = NAMED_QUERY_REGISTRY.get('skills.byRoom')!;
      expect(typeof entry.mapRow).toBe('function');
    });
  });

  describe('invariants', () => {
    test('all entries have non-empty SQL', () => {
      for (const [name, entry] of NAMED_QUERY_REGISTRY) {
        expect(entry.sql.trim().length).toBeGreaterThan(0, `${name} has empty SQL`);
      }
    });

    test('all entries have paramCount >= 0', () => {
      for (const [name, entry] of NAMED_QUERY_REGISTRY) {
        expect(entry.paramCount).toBeGreaterThanOrEqual(0, `${name} has negative paramCount`);
      }
    });

    test('all ORDER BY clauses include a deterministic tiebreaker (id or rowid column)', () => {
      for (const [name, entry] of NAMED_QUERY_REGISTRY) {
        const upperSql = entry.sql.toUpperCase();
        expect(upperSql).toContain('ORDER BY');
        const sqlForCheck = upperSql
          .replace(/\s+LIMIT\s+\?(\s+OFFSET\s+\?)?/, '')
          .replace(/\s+/g, ' ')
          .trim();
        const hasTiebreaker = /\b(ID|ROWID|INSORDER)\s+(ASC|DESC)\s*$/.test(sqlForCheck);
        expect(hasTiebreaker).toBe(
          true,
          `${name} ORDER BY lacks deterministic id/rowid tiebreaker`
        );
      }
    });
  });

  describe('scope filters', () => {
    describe('sessions.list', () => {
      function buildFilter() {
        const entry = NAMED_QUERY_REGISTRY.get('sessions.list')!;
        expect(entry.buildScopeFilter).toBeDefined();
        return entry.buildScopeFilter!([0], db)!;
      }

      test('human chat session writes re-run the list', () => {
        const filter = buildFilter();
        expect(filter({ sessionId: 'human-1', sessionType: 'worker' })).toBe(true);
        expect(filter({ sessionId: 'human-2', sessionType: 'general' })).toBe(true);
        expect(filter({ sessionId: 'human-3', sessionType: 'neo' })).toBe(true);
      });

      test('excluded session types skip the list', () => {
        const filter = buildFilter();
        for (const type of [
          'lobby',
          'spaces_global',
          'room_chat',
          'planner',
          'coder',
          'leader',
          'space_chat',
          'space_task_agent',
        ]) {
          expect(filter({ sessionId: 's', sessionType: type })).toBe(false);
        }
      });

      test('worker/space machinery writes skip the list via context', () => {
        const filter = buildFilter();
        expect(
          filter({ sessionId: 'space-worker', sessionType: 'worker', spaceId: 'space-1' })
        ).toBe(false);
        expect(
          filter({ sessionId: 'task-agent', sessionType: 'space_task_agent', spaceId: 'space-1' })
        ).toBe(false);
        expect(filter({ sessionId: 'room-chat', sessionType: 'room_chat', roomId: 'room-1' })).toBe(
          false
        );
        expect(filter({ sessionId: 'space-session', spaceId: 'space-1' })).toBe(false);
        expect(filter({ sessionId: 'room-session', roomId: 'room-1' })).toBe(false);
      });

      test('unscoped or absent-sessionType scopes still re-run', () => {
        const filter = buildFilter();
        expect(filter({})).toBe(true);
        expect(filter({ sessionId: 's' })).toBe(true);
        expect(filter({ sessionId: 's', taskId: 'task-1' })).toBe(true);
      });

      test('session-ID-only scopes resolve visibility from the database', () => {
        db.exec(`
          INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, type, session_context)
          VALUES ('db-worker', 'Worker', '2026-08-20', '2026-08-20', 'active', '{}', '{}', 'worker', '{"spaceId":"space-1"}')
        `);
        db.exec(`
          INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, type, session_context)
          VALUES ('db-task-agent', 'Task Agent', '2026-08-20', '2026-08-20', 'active', '{}', '{}', 'space_task_agent', NULL)
        `);
        db.exec(`
          INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, type, session_context)
          VALUES ('db-human', 'Human', '2026-08-20', '2026-08-20', 'active', '{}', '{}', 'general', NULL)
        `);
        const filter = buildFilter();
        expect(filter({ sessionId: 'db-worker' })).toBe(false);
        expect(filter({ sessionId: 'db-task-agent' })).toBe(false);
        expect(filter({ sessionId: 'db-human' })).toBe(true);
        expect(filter({ sessionId: 'missing-session' })).toBe(true);
      });
    });

    describe('actor message queries', () => {
      let scopedDb: BunDatabase;

      beforeEach(() => {
        scopedDb = new BunDatabase(':memory:');
        scopedDb.exec(`
					CREATE TABLE space_tasks (
						id TEXT PRIMARY KEY,
						workflow_run_id TEXT,
						task_agent_session_id TEXT
					);
					CREATE TABLE node_executions (
						id TEXT PRIMARY KEY,
						workflow_run_id TEXT NOT NULL,
						agent_session_id TEXT
					);
					CREATE TABLE sdk_messages (
						id TEXT PRIMARY KEY,
						session_id TEXT NOT NULL,
						task_id TEXT
					);
				`);
        scopedDb.exec(`
					INSERT INTO space_tasks (id, workflow_run_id, task_agent_session_id)
					VALUES ('task-a', 'run-a', 'task-session-a');
					INSERT INTO node_executions (id, workflow_run_id, agent_session_id)
					VALUES ('node-a', 'run-a', 'node-session-a');
					INSERT INTO sdk_messages (id, session_id, task_id)
					VALUES ('msg-a', 'message-session-a', 'task-a');
				`);
      });

      afterEach(() => {
        scopedDb.close();
      });

      test('task timeline uses the shared task scope filter', () => {
        const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
        expect(entry.buildScopeFilter).toBeDefined();
        const filter = entry.buildScopeFilter!(['task-a'], scopedDb)!;

        expect(filter({ taskId: 'task-a' })).toBe(true);
        expect(filter({ taskId: 'task-b' })).toBe(false);
      });

      test('workflow log filters out unrelated task and session writes', () => {
        const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byWorkflowRun')!;
        expect(entry.buildScopeFilter).toBeDefined();
        const filter = entry.buildScopeFilter!(['run-a', 'run-a', 'run-a'], scopedDb)!;

        expect(filter({ taskId: 'task-a' })).toBe(true);
        expect(filter({ taskId: 'task-b' })).toBe(false);
        expect(filter({ sessionId: 'task-session-a' })).toBe(true);
        expect(filter({ sessionId: 'node-session-a' })).toBe(true);
        expect(filter({ sessionId: 'message-session-a' })).toBe(true);
        expect(filter({ sessionId: 'other-session' })).toBe(false);
        expect(filter({})).toBe(true);
      });
    });

    describe('spaceSessions.bySpace', () => {
      let scopedDb: BunDatabase;
      const SPACE_ID = 'space-scope-test';

      beforeEach(() => {
        scopedDb = new BunDatabase(':memory:');
        scopedDb.exec(`
					CREATE TABLE spaces (
						id TEXT PRIMARY KEY,
						session_ids TEXT NOT NULL DEFAULT '[]'
					)
				`);
        scopedDb.exec(
          `INSERT INTO spaces (id, session_ids) VALUES ('${SPACE_ID}', '["existing-1","existing-2"]')`
        );
      });

      afterEach(() => {
        scopedDb.close();
      });

      function buildFilter() {
        const entry = NAMED_QUERY_REGISTRY.get('spaceSessions.bySpace')!;
        expect(entry.buildScopeFilter).toBeDefined();
        return entry.buildScopeFilter!([SPACE_ID], scopedDb);
      }

      test('accepts writes whose scope.spaceId matches the watched space', () => {
        const filter = buildFilter();
        expect(
          filter({
            sessionId: 'brand-new-session',
            spaceId: SPACE_ID,
          })
        ).toBe(true);
      });

      test('accepts writes for sessions currently in the live membership set', () => {
        const filter = buildFilter();
        expect(filter({ sessionId: 'existing-1' })).toBe(true);
        expect(filter({ sessionId: 'existing-2' })).toBe(true);
      });

      test('reads membership live so members added after subscription are in scope', () => {
        const filter = buildFilter();
        expect(filter({ sessionId: 'late-joiner' })).toBe(false);
        scopedDb.exec(
          `UPDATE spaces SET session_ids = '["existing-1","existing-2","late-joiner"]' WHERE id = '${SPACE_ID}'`
        );
        expect(filter({ sessionId: 'late-joiner' })).toBe(true);
      });

      test('drops sessions removed from membership without requiring resubscribe', () => {
        const filter = buildFilter();
        expect(filter({ sessionId: 'existing-2' })).toBe(true);
        scopedDb.exec(`UPDATE spaces SET session_ids = '["existing-1"]' WHERE id = '${SPACE_ID}'`);
        expect(filter({ sessionId: 'existing-2' })).toBe(false);
      });

      test('falls through when scope has no sessionId (e.g. a spaces-table write)', () => {
        const filter = buildFilter();
        expect(filter({})).toBe(true);
      });

      test('rejects sessions belonging to a different space', () => {
        const filter = buildFilter();
        expect(
          filter({
            sessionId: 'other-session',
            spaceId: 'some-other-space',
          })
        ).toBe(false);
      });

      test('row mapping carries processingState and messageCount like global sessions', () => {
        scopedDb.exec(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            status TEXT,
            processing_state TEXT,
            last_active_at TEXT,
            type TEXT,
            visible_message_count INTEGER NOT NULL DEFAULT 0
          )
        `);
        scopedDb.exec(`
          INSERT INTO sessions (id, title, status, processing_state, last_active_at, type, visible_message_count)
          VALUES ('existing-1', 'My session', 'active',
                  '{"status":"processing","phase":"thinking"}',
                  '2026-07-31 12:00:00', 'worker', 2)
        `);
        scopedDb.exec(`
          INSERT INTO sessions (id, title, status, processing_state, last_active_at, type, visible_message_count)
          VALUES ('existing-2', 'Quiet session', 'active', NULL, '2026-07-31 12:00:00', 'worker', 0)
        `);

        const entry = NAMED_QUERY_REGISTRY.get('spaceSessions.bySpace')!;
        const rows = scopedDb.prepare(entry.sql).all(SPACE_ID) as Record<string, unknown>[];
        const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

        const row = mapped.find((r) => r.id === 'existing-1')!;
        expect(row.processingState).toBe('{"status":"processing","phase":"thinking"}');
        expect(row.messageCount).toBe(2);
        const other = mapped.find((r) => r.id === 'existing-2')!;
        expect(other.messageCount).toBe(0);
        expect(other.processingState).toBeUndefined();
      });

      test('messageCount is decoupled from sdk_messages — no per-session COUNT(*)', () => {
        scopedDb.exec(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            status TEXT,
            processing_state TEXT,
            last_active_at TEXT,
            type TEXT,
            visible_message_count INTEGER NOT NULL DEFAULT 0
          )
        `);
        scopedDb.exec(`
          CREATE TABLE sdk_messages (
            id TEXT,
            session_id TEXT,
            message_type TEXT,
            message_subtype TEXT,
            message_subtype_norm TEXT GENERATED ALWAYS AS (COALESCE(message_subtype, '')) VIRTUAL,
            send_status TEXT,
            parent_tool_use_id TEXT,
            timestamp TEXT
          )
        `);
        scopedDb.exec(`
          INSERT INTO sessions (id, title, status, processing_state, last_active_at, type, visible_message_count)
          VALUES ('existing-1', 'My session', 'active', NULL, '2026-07-31 12:00:00', 'worker', 5)
        `);

        const entry = NAMED_QUERY_REGISTRY.get('spaceSessions.bySpace')!;
        const readCount = (): number => {
          const rows = scopedDb.prepare(entry.sql).all(SPACE_ID) as Record<string, unknown>[];
          const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;
          return Number(mapped.find((r) => r.id === 'existing-1')!.messageCount);
        };

        expect(readCount()).toBe(5);
        scopedDb.exec(`
          INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, send_status, parent_tool_use_id, timestamp)
          VALUES ('m1', 'existing-1', 'assistant', NULL, NULL, NULL, '2026-07-31 12:00:01')
        `);
        expect(readCount()).toBe(5);
        scopedDb.exec(`UPDATE sessions SET visible_message_count = 6 WHERE id = 'existing-1'`);
        expect(readCount()).toBe(6);
      });
    });
  });
});

describe('sessions.list reactive scope filter', () => {
  let dbPath: string;
  let db: Database;
  let reactiveDb: ReactiveDatabase;
  let engine: LiveQueryEngine;

  const SESSIONS_LIST_SQL = NAMED_QUERY_REGISTRY.get('sessions.list')!.sql;

  function makeSession(
    id: string,
    context?: Session['context'],
    type: Session['type'] = 'worker'
  ): Session {
    const now = new Date().toISOString();
    const config: SessionConfig = {
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 4096,
      temperature: 0.7,
    };
    const metadata: SessionMetadata = {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    };
    return {
      id,
      title: `Session ${id}`,
      workspacePath: '/workspace/test',
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
      config,
      metadata,
      type,
      context,
    };
  }

  function spyOnEvaluate() {
    const proto = LiveQueryEngine.prototype as unknown as {
      evaluateQuery: (cacheKey: string) => void;
    };
    return spyOn(proto, 'evaluateQuery');
  }

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `sessions-list-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new Database(dbPath);
    reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);
    engine = new LiveQueryEngine(db.getDatabase(), reactiveDb);
  });

  afterEach(() => {
    engine.dispose();
    try {
      db.close();
    } catch {}
    try {
      rmSync(dbPath, { force: true });
      rmSync(dbPath + '-wal', { force: true });
      rmSync(dbPath + '-shm', { force: true });
    } catch {}
  });

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function subscribeToList(onChange: (diff: QueryDiff<Record<string, unknown>>) => void) {
    const entry = NAMED_QUERY_REGISTRY.get('sessions.list')!;
    return engine.subscribe(SESSIONS_LIST_SQL, [0], onChange, {
      scopeFilter: entry.buildScopeFilter!([0], db.getDatabase()),
    });
  }

  test('human session create re-runs the list and emits the new row', async () => {
    const diffs: QueryDiff<Record<string, unknown>>[] = [];
    subscribeToList((diff) => diffs.push(diff));
    await flush();
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('snapshot');
    expect(diffs[0].rows).toHaveLength(0);

    reactiveDb.db.createSession(makeSession('human-1'));
    await flush();

    expect(diffs).toHaveLength(2);
    expect(diffs[1].type).toBe('delta');
    expect(diffs[1].rows).toHaveLength(1);
    expect(diffs[1].rows[0].id).toBe('human-1');
  });

  test('space and worker session writes do not re-run the list', async () => {
    const spy = spyOnEvaluate();
    const diffs: QueryDiff<Record<string, unknown>>[] = [];
    subscribeToList((diff) => diffs.push(diff));
    await flush();
    spy.mockClear();

    reactiveDb.db.createSession(makeSession('space-worker-1', { spaceId: 'space-1' }));
    await flush();
    expect(spy.mock.calls).toHaveLength(0);
    expect(diffs).toHaveLength(1);

    reactiveDb.db.createSession(
      makeSession('task-agent-1', { spaceId: 'space-1' }, 'space_task_agent')
    );
    await flush();
    expect(spy.mock.calls).toHaveLength(0);
    expect(diffs).toHaveLength(1);

    reactiveDb.db.createSession(makeSession('room-chat-1', { roomId: 'room-1' }, 'room_chat'));
    await flush();
    expect(spy.mock.calls).toHaveLength(0);
    expect(diffs).toHaveLength(1);

    reactiveDb.db.updateSession('space-worker-1', { status: 'active' });
    await flush();
    expect(spy.mock.calls).toHaveLength(0);
    expect(diffs).toHaveLength(1);
  });

  function makeAssistantMessage(uuid: string): SDKMessage {
    return {
      type: 'assistant',
      uuid,
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    } as SDKMessage;
  }

  test('worker session message saves do not re-run the list', async () => {
    reactiveDb.db.createSession(makeSession('space-worker-1', { spaceId: 'space-1' }));
    const spy = spyOnEvaluate();
    const diffs: QueryDiff<Record<string, unknown>>[] = [];
    subscribeToList((diff) => diffs.push(diff));
    await flush();
    spy.mockClear();

    reactiveDb.db.saveSDKMessage('space-worker-1', makeAssistantMessage('worker-msg-1'));
    await flush();

    expect(spy.mock.calls).toHaveLength(0);
    expect(diffs).toHaveLength(1);
  });

  test('human session message saves re-run the list', async () => {
    reactiveDb.db.createSession(makeSession('human-1'));
    const spy = spyOnEvaluate();
    subscribeToList(() => {});
    await flush();
    spy.mockClear();

    reactiveDb.db.saveSDKMessage('human-1', makeAssistantMessage('human-msg-1'));
    await flush();

    expect(spy.mock.calls).toHaveLength(1);
  });

  test('archiving a human session re-runs and drops it from the list', async () => {
    reactiveDb.db.createSession(makeSession('human-1'));
    const diffs: QueryDiff<Record<string, unknown>>[] = [];
    subscribeToList((diff) => diffs.push(diff));
    await flush();
    expect(diffs[0].rows).toHaveLength(1);

    reactiveDb.db.updateSession('human-1', {
      status: 'archived',
      archivedAt: new Date().toISOString(),
    });
    await flush();

    expect(diffs).toHaveLength(2);
    expect(diffs[1].rows).toHaveLength(0);
  });

  test('deleting a human session re-runs and drops it from the list', async () => {
    reactiveDb.db.createSession(makeSession('human-1'));
    const diffs: QueryDiff<Record<string, unknown>>[] = [];
    subscribeToList((diff) => diffs.push(diff));
    await flush();
    expect(diffs[0].rows).toHaveLength(1);

    reactiveDb.db.deleteSession('human-1');
    await flush();

    expect(diffs).toHaveLength(2);
    expect(diffs[1].rows).toHaveLength(0);
  });

  test('visible session gaining a spaceId context re-runs and leaves the list', async () => {
    reactiveDb.db.createSession(makeSession('human-1'));
    const diffs: QueryDiff<Record<string, unknown>>[] = [];
    subscribeToList((diff) => diffs.push(diff));
    await flush();
    expect(diffs[0].rows).toHaveLength(1);

    reactiveDb.db.updateSession('human-1', { context: { spaceId: 'space-1' } });
    await flush();

    expect(diffs).toHaveLength(2);
    expect(diffs[1].rows).toHaveLength(0);
  });

  test('visible session changing to an excluded type re-runs and leaves the list', async () => {
    reactiveDb.db.createSession(makeSession('human-1'));
    const diffs: QueryDiff<Record<string, unknown>>[] = [];
    subscribeToList((diff) => diffs.push(diff));
    await flush();
    expect(diffs[0].rows).toHaveLength(1);

    reactiveDb.db.updateSession('human-1', { type: 'space_task_agent' });
    await flush();

    expect(diffs).toHaveLength(2);
    expect(diffs[1].rows).toHaveLength(0);
  });

  test('unscoped sessions-table events still re-run the list', async () => {
    const spy = spyOnEvaluate();
    subscribeToList(() => {});
    await flush();
    spy.mockClear();

    reactiveDb.notifyChange('sessions');
    await flush();

    expect(spy.mock.calls).toHaveLength(1);
  });

  test('transaction with mixed scopes still re-runs the list', async () => {
    const spy = spyOnEvaluate();
    subscribeToList(() => {});
    await flush();
    spy.mockClear();

    reactiveDb.beginTransaction();
    reactiveDb.db.createSession(makeSession('human-1'));
    reactiveDb.notifyChange('sessions');
    reactiveDb.commitTransaction();
    await flush();

    expect(spy.mock.calls).toHaveLength(1);
  });
});
