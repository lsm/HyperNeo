/**
 * Contract tests for the named-query registry defined in live-query-handlers.ts
 *
 * These tests verify that:
 *  1. The registry is exported and contains the expected named queries.
 *  2. Active row shapes returned by executing SQL match the frontend contracts.
 *  3. JSON blob columns are parsed to JS values before delivery.
 *  4. Retired Room-scoped query names are absent from the active registry.
 *  5. All active queries have deterministic ORDER BY with tiebreakers.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables, runMigration74 } from '../../../../src/storage/schema';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/rpc-handlers/live-query-handlers';
import {
  computeIsRenderable,
  computeIsTerminal,
  extractParentToolUseId,
} from '../../../../src/storage/repositories/sdk-message-repository';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { NeoTask, RoomGoal } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('NAMED_QUERY_REGISTRY', () => {
  let db: BunDatabase;
  const roomId = 'room-contract-test';
  const now = Date.now();

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createTables(db);
    runMigration74(db);
    // Insert minimal room row to satisfy FK constraints
    db.exec(
      `INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test Room', ${now}, ${now})`
    );
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Registry shape
  // -------------------------------------------------------------------------

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
  });

  test('retired Room-scoped query names are not active contracts', () => {
    expect([...NAMED_QUERY_REGISTRY.keys()]).not.toContain('tasks.byRoom');
    expect([...NAMED_QUERY_REGISTRY.keys()]).not.toContain('tasks.byRoom.all');
    expect([...NAMED_QUERY_REGISTRY.keys()]).not.toContain('goals.byRoom');
    expect([...NAMED_QUERY_REGISTRY.keys()]).not.toContain('mcpEnablement.byRoom');
    expect([...NAMED_QUERY_REGISTRY.keys()]).not.toContain('skills.byRoom');
  });

  // -------------------------------------------------------------------------
  // tasks.byRoom — column aliasing and JSON parsing
  // -------------------------------------------------------------------------

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

      // Type assertion — if the shape is wrong, TS will catch it in CI
      const _typed = row as unknown as NeoTask;

      // Verify key structural properties at runtime
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
      // Both should have the same columns (keys)
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
					depends_on TEXT NOT NULL DEFAULT '[]',
					current_step TEXT,
					error TEXT,
					result TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				);
			`);
      // Migration 122 / createTables already adds `task_id` directly to
      // sdk_messages. Tests inserting messages must stamp `task_id` so the
      // live-query SQL (which filters via sm.task_id = ?) can reach them.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id)`);
      db.exec(
        `INSERT OR IGNORE INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
				 VALUES ('${spaceId}', '${spaceId}', '/tmp/test-space', 'Test Space', ${now}, ${now})`
      );
      sessionTaskIds.clear();
    });

    // Map session_id → task_id so message inserts can stamp the denormalised
    // `sdk_messages.task_id` column the live-query SQL filters on. Reset per
    // test via the outer beforeEach replaying through this.
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
      // Bind the task agent session to this task so subsequent message
      // inserts stamp `sdk_messages.task_id` exactly the way the
      // SDKMessageRepository does in production (derived from the
      // session_context.taskId carried by the orchestration session).
      if (overrides.taskAgentSessionId) {
        sessionTaskIds.set(String(overrides.taskAgentSessionId), id);
      }
      return id;
    }

    function insertSession(
      id: string,
      type: string,
      processingState: string,
      sessionContext?: string
    ): void {
      db.exec(`
				INSERT INTO sessions (
					id, title, workspace_path, created_at, last_active_at, status, config, metadata,
					is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id,
					available_commands, processing_state, archived_at, type, session_context
				) VALUES (
					'${id}', 'Session', '/tmp/test-space', '${nowIso}', '${nowIso}', 'active', '{}', '{}',
					0, NULL, NULL, NULL, NULL, NULL, NULL, '${processingState}', NULL, '${type}', '${sessionContext ?? '{}'}'
				)
			`);
    }

    /**
     * Mirror NodeExecutionRepository.create — insert a node_executions row.
     * Also bind the agent_session_id to every space_task on the same
     * workflow_run_id so subsequent message inserts stamp `sdk_messages.task_id`
     * against the orchestration task (the way the SDKMessageRepository would
     * if it were called with a node-agent session whose session_context.taskId
     * is the orchestration task).
     */
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
        // Bind the node-agent session to the orchestration task on this
        // workflow run — i.e. the task whose own task_agent_session_id is
        // distinct from the node agent's session. This mirrors what the
        // SDKMessageRepository would derive from sessions.session_context.taskId
        // in production.
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

      // Insert the orchestration task (target_task) — this is the Task Agent's own task.
      // It has a different session ID from the node agent sub-session.
      const taskId = insertSpaceTask({
        id: 'orch-task-1',
        taskAgentSessionId: orchestrationSessionId,
        workflowRunId,
        status: 'in_progress',
      });

      // Insert a separate step task for the node agent (different from the orchestration task).
      insertSpaceTask({
        id: 'step-task-1',
        agentName,
        workflowRunId,
        workflowNodeId,
        taskAgentSessionId: nodeSessionId,
        status: 'in_progress',
      });

      // Insert a matching node_execution record with agent_session_id
      insertNodeExecution({
        id: 'ne-1',
        workflowRunId,
        workflowNodeId,
        agentName,
        agentSessionId: nodeSessionId,
        status: 'in_progress',
      });

      // Insert session and SDK messages for the node agent
      insertSession(nodeSessionId, 'worker', '{"status":"processing","phase":"coding"}');
      insertSdkMessage('sdk-node-1', nodeSessionId);
      insertSdkMessage('sdk-node-2', nodeSessionId);

      const rows = queryAndMap(taskId);
      // Should return the orchestration row (Leg 1) and the node agent row (Leg 2)
      const nodeAgentRow = rows.find((r) => r.kind === 'node_agent');
      expect(nodeAgentRow).toBeDefined();
      expect(nodeAgentRow!.label).toBeTruthy(); // COALESCE(sa.name, ne.agent_name, 'agent')
      expect(nodeAgentRow!.role).toBe('coder');
      expect(nodeAgentRow!.state).toBe('active');
      expect(nodeAgentRow!.processingStatus).toBe('processing');
      expect(nodeAgentRow!.processingPhase).toBe('coding');
      expect(nodeAgentRow!.messageCount).toBe(2);
      expect(nodeAgentRow!.sessionId).toBe(nodeSessionId);
      expect(nodeAgentRow!.workflowNodeId).toBe(workflowNodeId);
      expect(nodeAgentRow!.agentName).toBe('coder');
    });

    test('Leg 2 (node_agents): skips rows without agent_session_id', () => {
      const workflowRunId = 'wr-no-session-test';
      const taskId = insertSpaceTask({ workflowRunId, status: 'in_progress' });

      // Insert node_execution WITHOUT agent_session_id
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

      // No SDK messages at all — the activity feed should still surface
      // both the orchestration session and the node-agent session.
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
      for (const subtype of ['thinking_tokens', 'session_state_changed', 'commands_changed']) {
        insertSdkMessageAt(
          `sdk-operational-${subtype}`,
          nodeSessionId,
          now + 2000,
          'system',
          'consumed',
          'system',
          subtype,
          { type: 'system', subtype }
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

      const entry = NAMED_QUERY_REGISTRY.get('actorMessages.byTask')!;
      const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
      const mapped = entry.mapRow ? rows.map(entry.mapRow) : rows;

      expect(mapped.map((row) => row.id)).toEqual([
        'msg:row-retracted',
        'msg:sdk-visible-after-retry',
        'msg:sdk-fallback-notice',
      ]);
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

    test('classifies by session type, not current task_agent_session_id pointer', () => {
      // Simulate a scenario where the orchestration session was replaced
      // (rehydrate self-heal) but historical messages still exist. The
      // session.type column is the stable source of truth — messages from
      // the old session must keep their task_agent classification even
      // though the task pointer now points at a different session.
      const oldOrchSessionId = 'space:test-space:task:orch-old';
      const newOrchSessionId = 'space:test-space:task:orch-new';
      const taskId = insertSpaceTask({
        taskAgentSessionId: newOrchSessionId, // pointer rotated to new session
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
      // Ensure the message helper stamps task_id for this session
      sessionTaskIds.set(oldOrchSessionId, taskId);
      insertSdkMessage('sdk-old', oldOrchSessionId);

      const rows = queryMessages(taskId);
      const oldRow = rows.find((r) => r.sessionId === oldOrchSessionId);
      expect(oldRow).toBeDefined();
      expect(oldRow!.kind).toBe('task_agent'); // still task_agent because session.type says so
      expect(oldRow!.label).toBe('Task Agent');
    });

    // -------------------------------------------------------------------------
    // spaceTaskMessages.byTask.compact — per-session turn compaction
    // -------------------------------------------------------------------------

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
        // Use the production helpers so test data stays aligned with the
        // values the SDKMessageRepository would actually stamp.
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

      test('keeps last 5 non-terminal rows per turn and always keeps terminal rows', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        for (let i = 1; i <= 7; i += 1) {
          insertSdkMessageAt(`t1-n${i}`, sessionId, now + i * 1000);
        }
        insertResultMessageAt('t1-r', sessionId, now + 8000, 'success');
        for (let i = 1; i <= 7; i += 1) {
          insertSdkMessageAt(`t2-n${i}`, sessionId, now + (8 + i) * 1000);
        }
        insertResultMessageAt('t2-r', sessionId, now + 16000, 'error_during_execution');

        const rows = queryCompact(taskId);
        expect(rows.map((r) => r.id)).toEqual([
          't1-n3',
          't1-n4',
          't1-n5',
          't1-n6',
          't1-n7',
          't1-r',
          't2-n3',
          't2-n4',
          't2-n5',
          't2-n6',
          't2-n7',
          't2-r',
        ]);
        const t1Row = rows.find((r) => r.id === 't1-r')!;
        const t2Row = rows.find((r) => r.id === 't2-r')!;
        expect(t1Row.turnIndex).toBe(1);
        expect(t2Row.turnIndex).toBe(2);
        expect(t1Row.turnHiddenMessageCount).toBe(2);
        expect(t2Row.turnHiddenMessageCount).toBe(2);
      });

      test('terminal row does not count toward the 5-row non-terminal cap', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        for (let i = 1; i <= 6; i += 1) {
          insertSdkMessageAt(`n${i}`, sessionId, now + i * 1000);
        }
        insertResultMessageAt('r1', sessionId, now + 7000, 'success');

        const rows = queryCompact(taskId);
        expect(rows.map((r) => r.id)).toEqual(['n2', 'n3', 'n4', 'n5', 'n6', 'r1']);
        expect(rows).toHaveLength(6);
      });

      test('pins the initial user message in a turn and places hidden count after it', () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt(
          'u-initial',
          sessionId,
          now + 1000,
          {
            type: 'user',
            isSynthetic: true,
            message: { role: 'user', content: 'Initial turn prompt' },
          },
          'user'
        );
        for (let i = 1; i <= 7; i += 1) {
          insertSdkMessageAt(`a${i}`, sessionId, now + (1 + i) * 1000);
        }
        insertResultMessageAt('r1', sessionId, now + 10000, 'success');

        const rows = queryCompact(taskId);
        expect(rows.map((r) => r.id)).toEqual(['u-initial', 'a3', 'a4', 'a5', 'a6', 'a7', 'r1']);
        const resultRow = rows.find((r) => r.id === 'r1')!;
        expect(resultRow.turnHiddenMessageCount).toBe(2);
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

        expect(orchIds).toEqual(['orch-n2', 'orch-n3', 'orch-n4', 'orch-n5', 'orch-n6', 'orch-r']);
        expect(nodeIds).toEqual(['node-n2', 'node-n3', 'node-n4', 'node-n5', 'node-n6', 'node-r']);
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
        expect(rows.map((r) => r.id)).toEqual(['a2', 'a3', 'a4', 'a5', 'a6', 'r1']);
        expect(rows.map((r) => r.id)).not.toContain('u1');
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
          'row-retracted',
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

        // system:init lands at position 1 of the session — well outside the
        // tail-of-5 window once the agent has produced any non-trivial run.
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
        // system:init survives even though it sits well before the tail
        // window — UI affordances depend on it being present.
        expect(rows.map((r) => r.id)).toEqual([
          'sys-init',
          'u-initial',
          'a3',
          'a4',
          'a5',
          'a6',
          'a7',
          'r1',
        ]);
        // The hidden-count math should ignore system rows entirely
        // (they're sidecar metadata, not real "messages") — only the two
        // pruned assistant rows count toward hidden.
        const resultRow = rows.find((r) => r.id === 'r1')!;
        expect(resultRow.turnHiddenMessageCount).toBe(2);
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
          'operational-commands_changed',
          'operational-session_state_changed',
          'operational-thinking_tokens',
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

    // -----------------------------------------------------------------------
    // SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL — server-derived running
    // roster source. Backing SQL for the separate `spaceTaskActiveTurn.byTask`
    // LiveQuery; the client renders this directly without re-deriving from
    // the (potentially truncated) compact rows.
    // -----------------------------------------------------------------------

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
        // Use the production helpers so test data stays aligned with the
        // values the SDKMessageRepository would actually stamp.
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

      test('emits a summary only for the active (non-terminal) turn per session', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        // Closed turn: assistant text → result.
        insertSdkMessageAt('t1-a1', sessionId, now + 1000, {
          type: 'assistant',
          uuid: 't1-a1',
          message: { content: [{ type: 'text', text: 'closed-text' }] },
        });
        insertResultAt('t1-r', sessionId, now + 2000, 'success');

        // Active turn: tool_use only, NO result row yet.
        insertSdkMessageAt('t2-a1', sessionId, now + 3000, {
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
        expect(entries).toHaveLength(1);
        expect(entries[0].kind).toBe('tool_use');
        expect(entries[0].toolName).toBe('Bash');
        expect(entries[0].preview).toBe('bun test');
        // No closed-turn entries leak through.
        const previews = entries.map((e) => String(e.preview ?? e.text ?? ''));
        expect(previews).not.toContain('closed-text');
      });

      test('emits no summary when the latest turn is closed', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        insertSdkMessageAt('a1', sessionId, now + 1000);
        insertResultAt('r1', sessionId, now + 2000, 'success');

        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(0);
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
              { type: 'text', text: '   ' }, // whitespace-only — server should drop
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

      test('distinguishes real human input from synthetic agent handoffs via isReplay', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        // Real human input — isReplay falsy.
        insertSdkMessageAt(
          'u1',
          sessionId,
          now + 1000,
          {
            type: 'user',
            uuid: 'u1',
            message: { role: 'user', content: 'please retry' },
          },
          'user'
        );
        // Synthetic handoff — isReplay = true.
        insertSdkMessageAt(
          'u2',
          sessionId,
          now + 2000,
          {
            type: 'user',
            uuid: 'u2',
            isReplay: true,
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'Reviewer Agent: take over' }],
            },
          },
          'user'
        );
        // Active turn open with a tool_use to anchor the active-turn detection.
        insertSdkMessageAt('a1', sessionId, now + 3000, {
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
        // Server distinguishes the two user-row variants on the wire.
        expect(kinds).toContain('user_message');
        expect(kinds).toContain('agent_handoff');
        const userEntry = entries.find((e) => e.kind === 'user_message') as Record<string, unknown>;
        const handoffEntry = entries.find((e) => e.kind === 'agent_handoff') as Record<
          string,
          unknown
        >;
        expect(userEntry.text).toBe('please retry');
        expect(handoffEntry.text).toBe('Reviewer Agent: take over');
      });

      test('skips user rows whose content is exclusively tool_result blocks', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        // User row with only a tool_result block — should be dropped.
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
        // Anchor the active turn with an assistant block.
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
        // No user_message / agent_handoff entry from the tool_result row.
        expect(kinds).not.toContain('user_message');
        expect(kinds).not.toContain('agent_handoff');
        // The assistant tool_use survives.
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

        // Both sessions have an active turn (no result row yet) — both
        // should appear in the summaries.
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
    });

    // ---------------------------------------------------------------------
    // Integration: the central decoupling claim of the PR — a long active
    // turn yields ≤5 rows in the compact feed (server cap unchanged) AND
    // every entry in `activeTurnSummaries` (no cap on the summary side).
    // ---------------------------------------------------------------------

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
        // Use the production helpers so test data stays aligned with the
        // values the SDKMessageRepository would actually stamp. Without
        // this, derived columns fall back to schema defaults, which lets
        // the compact query include rows that should be filtered out.
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
        const entry = NAMED_QUERY_REGISTRY.get('spaceTaskMessages.byTask.compact')!;
        const rows = db.prepare(entry.sql).all(taskId) as Record<string, unknown>[];
        return entry.mapRow ? rows.map(entry.mapRow) : rows;
      }

      async function runEntries(taskId: string): Promise<Record<string, unknown>[]> {
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

      test('long active turn: compact feed ≤5 non-terminal rows AND summary carries every entry', async () => {
        const taskId = insertSpaceTask({ taskAgentSessionId: sessionId });
        insertSession(sessionId, 'space_task_agent', '{"status":"processing"}');

        // Insert 8 distinct assistant tool_use rows in the same active turn.
        // Each emits one ActivityEntry (one tool_use block per row), so the
        // summary should carry exactly 8 entries while the compact feed
        // caps at 5.
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
        // Active turn: no terminal `result` row inserted.

        // Compact feed: capped at the per-turn non-terminal limit (5).
        const compactRows = queryCompact(taskId);
        expect(compactRows.length).toBeLessThanOrEqual(
          5 // SPACE_TASK_MESSAGES_COMPACT_NON_TERMINAL_PER_TURN_LIMIT
        );
        // Sanity: cap was actually exercised — we inserted more than the cap.
        expect(turnSize).toBeGreaterThan(compactRows.length);

        // Active-turn summary: uncapped, full chronological activity.
        const summaries = await buildSummaries(taskId);
        expect(summaries).toHaveLength(1);
        const entries = summaries[0].entries as Array<Record<string, unknown>>;
        expect(entries).toHaveLength(turnSize);
        expect(entries.map((e) => e.toolName)).toEqual(toolNames);
        // Confirms entries are not subject to the compact cap that limits
        // the row stream — this is the decoupling the PR establishes.
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

  // -------------------------------------------------------------------------
  // goals.byRoom — column aliasing, JSON parsing, snake_case exceptions
  // -------------------------------------------------------------------------

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
      // schedule_paused defaults to 0 → false
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

      // Type assertion — if the shape is wrong, TS will catch it in CI
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

  // -------------------------------------------------------------------------
  // sessionGroupMessages.byGroup — canonical timeline from sdk_messages + events
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // skills.byRoom — global skills with per-room override via LEFT JOIN
  // -------------------------------------------------------------------------

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

      // Override alpha to disabled in the room
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

  // -------------------------------------------------------------------------
  // General registry invariants
  // -------------------------------------------------------------------------

  describe('invariants', () => {
    test('all entries have non-empty SQL', () => {
      for (const [name, entry] of NAMED_QUERY_REGISTRY) {
        expect(entry.sql.trim().length).toBeGreaterThan(0, `${name} has empty SQL`);
      }
    });

    test('all entries have paramCount >= 0', () => {
      for (const [name, entry] of NAMED_QUERY_REGISTRY) {
        // Global queries (e.g. mcpServers.global) need no params and use paramCount: 0.
        // Room-scoped queries require at least 1 param (e.g. roomId).
        expect(entry.paramCount).toBeGreaterThanOrEqual(0, `${name} has negative paramCount`);
      }
    });

    test('all ORDER BY clauses include a deterministic tiebreaker (id column)', () => {
      for (const [name, entry] of NAMED_QUERY_REGISTRY) {
        const upperSql = entry.sql.toUpperCase();
        expect(upperSql).toContain('ORDER BY');
        // Strip trailing LIMIT / OFFSET clauses before checking the tiebreaker so that
        // paginated queries also pass this invariant.
        const sqlForCheck = upperSql
          .replace(/\s+LIMIT\s+\?(\s+OFFSET\s+\?)?/, '')
          .replace(/\s+/g, ' ')
          .trim();
        // Must end with either `id ASC` or `id DESC` (tiebreaker)
        const hasIdTiebreaker = /\bID\s+(ASC|DESC)\s*$/.test(sqlForCheck);
        expect(hasIdTiebreaker).toBe(true, `${name} ORDER BY lacks deterministic id tiebreaker`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scope filter contracts
  // -------------------------------------------------------------------------

  describe('scope filters', () => {
    describe('sessions.list', () => {
      test('has no scope filter so visible→hidden updateSession transitions invalidate', () => {
        // `sessions.list` post-update scope cannot distinguish a session
        // becoming hidden from one that was always hidden, so the only
        // safe behaviour is to re-evaluate on every `sessions` write.
        // Any scope filter here would be unsound — keep it absent.
        const entry = NAMED_QUERY_REGISTRY.get('sessions.list')!;
        expect(entry.buildScopeFilter).toBeUndefined();
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
        // New session created with spaceId set to ours — even before the
        // spaces.session_ids row catches up — must be considered in scope.
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
        // At subscription time `late-joiner` is not a member, but the new
        // implementation re-reads membership on every call.
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
        // `existing-2` is no longer a member, scope.spaceId is absent —
        // filter should reject and avoid unnecessary re-evaluation.
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
    });
  });
});
