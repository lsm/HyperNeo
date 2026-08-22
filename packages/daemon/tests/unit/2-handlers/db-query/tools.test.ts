import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';

mock.module('@anthropic-ai/claude-agent-sdk', () => {
  class MockMcpServer {
    readonly _registeredTools: Record<string, object> = {};

    connect(): void {}
    disconnect(): void {}
  }

  let toolBatch: Array<{ name: string; def: object }> = [];

  function tool(name: string, description: string, inputSchema: unknown, handler: unknown): object {
    const def = { name, description, inputSchema, handler };
    toolBatch.push({ name, def });
    return def;
  }

  return {
    query: mock(async () => ({ interrupt: () => {} })),
    interrupt: mock(async () => {}),
    supportedModels: mock(async () => {
      throw new Error('SDK unavailable in unit test');
    }),
    createSdkMcpServer: mock((options: { name: string; version?: string; tools?: unknown[] }) => {
      const server = new MockMcpServer();
      for (const { name, def } of toolBatch) {
        server._registeredTools[name] = def;
      }
      if (Object.keys(server._registeredTools).length === 0 && Array.isArray(options.tools)) {
        for (const candidate of options.tools) {
          const toolDef = candidate as { name?: string };
          if (toolDef.name) {
            server._registeredTools[toolDef.name] = candidate as object;
          }
        }
      }
      toolBatch = [];

      return {
        type: 'sdk' as const,
        name: options.name,
        version: options.version ?? '1.0.0',
        tools: options.tools ?? [],
        instance: server,
      };
    }),
    tool,
  };
});

import { Database } from '../../../../src/storage/sqlite-compat';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDbQueryToolHandlers,
  createDbQueryMcpServer,
} from '../../../../src/lib/db-query/tools.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');

  db.exec(`
		CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			config TEXT,
			parent_id TEXT,
			FOREIGN KEY (parent_id) REFERENCES rooms(id)
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS tasks (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			priority TEXT NOT NULL DEFAULT 'normal',
			restrictions TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (room_id) REFERENCES rooms(id)
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS goals (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			priority TEXT NOT NULL DEFAULT 'normal',
			mission_type TEXT,
			structured_metrics TEXT,
			schedule TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (room_id) REFERENCES rooms(id)
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS mission_executions (
			id TEXT PRIMARY KEY,
			goal_id TEXT NOT NULL,
			execution_number INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'running',
			result_summary TEXT,
			task_ids TEXT NOT NULL DEFAULT '[]',
			started_at INTEGER,
			completed_at INTEGER,
			FOREIGN KEY (goal_id) REFERENCES goals(id),
			UNIQUE(goal_id, execution_number)
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS mission_metric_history (
			id TEXT PRIMARY KEY,
			goal_id TEXT NOT NULL,
			metric_name TEXT NOT NULL,
			value REAL NOT NULL,
			recorded_at INTEGER NOT NULL,
			FOREIGN KEY (goal_id) REFERENCES goals(id)
		)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS spaces (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			workspace_path TEXT NOT NULL,
			config TEXT,
			created_at INTEGER NOT NULL
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			config TEXT,
			gates TEXT,
			channels TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id)
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id)
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_runs (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			workflow_id TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id)
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS gate_data (
			run_id TEXT NOT NULL,
			gate_id TEXT NOT NULL,
			data TEXT NOT NULL DEFAULT '{}',
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, gate_id),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id)
		)
	`);

  return db;
}

function seedRooms(db: Database) {
  db.exec(
    "INSERT INTO rooms (id, name, config) VALUES ('room-1', 'Room 1', '{\"model\":\"opus\"}')"
  );
  db.exec(
    "INSERT INTO rooms (id, name, config) VALUES ('room-2', 'Room 2', '{\"model\":\"sonnet\"}')"
  );
  db.exec("INSERT INTO rooms (id, name, config) VALUES ('room-3', 'Room 3', NULL)");
}

function seedTasks(db: Database) {
  seedRooms(db);
  db.exec(
    "INSERT INTO tasks (id, room_id, title, status, priority, restrictions, created_at) VALUES ('task-1', 'room-1', 'Task 1', 'in_progress', 'high', '{\"maxTokens\":100}', 1000)"
  );
  db.exec(
    "INSERT INTO tasks (id, room_id, title, status, priority, restrictions, created_at) VALUES ('task-2', 'room-1', 'Task 2', 'pending', 'normal', NULL, 2000)"
  );
  db.exec(
    "INSERT INTO tasks (id, room_id, title, status, priority, restrictions, created_at) VALUES ('task-3', 'room-2', 'Task 3', 'completed', 'low', NULL, 3000)"
  );
}

function seedGoals(db: Database) {
  seedRooms(db);
  db.exec(
    "INSERT INTO goals (id, room_id, title, status, mission_type, created_at) VALUES ('goal-1', 'room-1', 'Goal 1', 'active', 'one_shot', 1000)"
  );
  db.exec(
    "INSERT INTO goals (id, room_id, title, status, mission_type, created_at) VALUES ('goal-2', 'room-1', 'Goal 2', 'completed', 'recurring', 2000)"
  );
  db.exec(
    "INSERT INTO goals (id, room_id, title, status, mission_type, created_at) VALUES ('goal-3', 'room-2', 'Goal 3', 'active', NULL, 3000)"
  );
}

function seedMissionExecutions(db: Database) {
  seedGoals(db);
  db.exec(
    "INSERT INTO mission_executions (id, goal_id, execution_number, status, result_summary, started_at) VALUES ('exec-1', 'goal-1', 1, 'completed', 'success', 1000)"
  );
  db.exec(
    "INSERT INTO mission_executions (id, goal_id, execution_number, status, result_summary, started_at) VALUES ('exec-2', 'goal-1', 2, 'running', 'in progress', 2000)"
  );
  db.exec(
    "INSERT INTO mission_executions (id, goal_id, execution_number, status, result_summary, started_at) VALUES ('exec-3', 'goal-2', 1, 'completed', 'done', 3000)"
  );
}

function seedSpaces(db: Database) {
  db.exec(
    "INSERT INTO spaces (id, name, workspace_path, config, created_at) VALUES ('space-1', 'Space 1', '/path1', '{\"agents\":[]}', 1000)"
  );
  db.exec(
    "INSERT INTO spaces (id, name, workspace_path, config, created_at) VALUES ('space-2', 'Space 2', '/path2', '{\"agents\":[]}', 2000)"
  );
}

function seedSpaceWorkflows(db: Database) {
  seedSpaces(db);
  db.exec(
    "INSERT INTO space_workflows (id, space_id, name, config, gates, channels, created_at, updated_at) VALUES ('wf-1', 'space-1', 'WF 1', '{\"key\":\"val\"}', '{\"g1\":{}}', '{\"ch1\":{}}', 1000, 1000)"
  );
  db.exec(
    "INSERT INTO space_workflows (id, space_id, name, config, gates, channels, created_at, updated_at) VALUES ('wf-2', 'space-1', 'WF 2', '{\"key\":\"val2\"}', NULL, NULL, 2000, 2000)"
  );
  db.exec(
    "INSERT INTO space_workflows (id, space_id, name, config, gates, channels, created_at, updated_at) VALUES ('wf-3', 'space-2', 'WF 3', '{\"key\":\"val3\"}', NULL, NULL, 3000, 3000)"
  );
}

function seedSpaceWorkflowRuns(db: Database) {
  seedSpaces(db);
  db.exec(
    "INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at) VALUES ('run-1', 'space-1', 'wf-1', 'Run 1', 'in_progress', 1000)"
  );
  db.exec(
    "INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at) VALUES ('run-2', 'space-1', 'wf-1', 'Run 2', 'completed', 2000)"
  );
  db.exec(
    "INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at) VALUES ('run-3', 'space-2', 'wf-2', 'Run 3', 'pending', 3000)"
  );
}

function seedGateData(db: Database) {
  seedSpaceWorkflowRuns(db);
  db.exec(
    "INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES ('run-1', 'gate-1', '{\"approved\":true}', 1000)"
  );
  db.exec(
    "INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES ('run-2', 'gate-1', '{\"approved\":false}', 2000)"
  );
}

function parseResult(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}) {
  const text = result.content[0].text;
  try {
    return { ...JSON.parse(text), isError: result.isError };
  } catch {
    return { raw: text, isError: result.isError };
  }
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

describe('db-query tools', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('db_query', () => {
    describe('valid SELECT returns rows', () => {
      it('returns rows for a simple SELECT query', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        expect(parsed.rowCount).toBe(2);
        expect(parsed.rows[0].room_id).toBe('room-1');
      });

      it('returns rows with explicit columns', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT id, title FROM tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        expect(parsed.rows[0]).toHaveProperty('id');
        expect(parsed.rows[0]).toHaveProperty('title');
      });

      it('returns rows with WHERE clause', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM tasks WHERE status = ?',
          params: ['pending'],
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0].title).toBe('Task 2');
      });

      it('global scope returns all rows without filtering', async () => {
        seedRooms(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM rooms' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(3);
      });
    });

    describe('rejects non-SELECT statements', () => {
      it('rejects INSERT', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'INSERT INTO rooms (id, name) VALUES (?, ?)',
          params: ['room-x', 'X'],
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('Only SELECT');
      });

      it('rejects UPDATE', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'UPDATE rooms SET name = ? WHERE id = ?',
          params: ['New Name', 'room-1'],
        });
        expect(result.isError).toBe(true);
      });

      it('rejects DELETE', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'DELETE FROM rooms' });
        expect(result.isError).toBe(true);
      });

      it('rejects DROP TABLE', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'DROP TABLE rooms' });
        expect(result.isError).toBe(true);
      });

      it('rejects CREATE TABLE', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'CREATE TABLE foo (id TEXT)',
        });
        expect(result.isError).toBe(true);
      });
    });

    describe('rejects queries referencing tables outside scope', () => {
      it('room scope rejects global-only tables (rooms)', async () => {
        seedRooms(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM rooms' });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('not accessible');
      });

      it('room scope rejects space-scoped tables (space_tasks)', async () => {
        seedSpaces(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM space_tasks' });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('not accessible');
      });

      it('space scope rejects room-scoped tables (tasks)', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });
        expect(result.isError).toBe(true);
      });

      it('prevents cross-scope joins', async () => {
        seedTasks(db);
        seedSpaces(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM tasks JOIN spaces ON tasks.id = spaces.id',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('not accessible');
      });
    });

    describe('scope subquery wrapping filters results correctly', () => {
      it('room scope filters tasks by room_id', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        for (const row of parsed.rows) {
          expect(row.room_id).toBe('room-1');
        }
      });

      it('room scope filters goals by room_id', async () => {
        seedGoals(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM goals' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        for (const row of parsed.rows) {
          expect(row.room_id).toBe('room-1');
        }
      });

      it('space scope filters space_workflow_runs by space_id', async () => {
        seedSpaceWorkflowRuns(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM space_workflow_runs',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        for (const row of parsed.rows) {
          expect(row.space_id).toBe('space-1');
        }
      });

      it('scope filter works alongside user WHERE clause', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM tasks WHERE status = ?',
          params: ['pending'],
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0].title).toBe('Task 2');
        expect(parsed.rows[0].room_id).toBe('room-1');
      });

      it('scope filter works with user params', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM tasks WHERE priority = ?',
          params: ['high'],
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0].title).toBe('Task 1');
      });
    });

    describe('same-scope JOIN queries', () => {
      it('JOINs two room-scoped tables with deduplicated scope filter', async () => {
        seedRooms(db);
        db.exec(
          "INSERT INTO goals (id, room_id, title, status, mission_type, created_at) VALUES ('goal-1', 'room-1', 'Goal 1', 'active', 'one_shot', 1000)"
        );
        db.exec(
          "INSERT INTO goals (id, room_id, title, status, mission_type, created_at) VALUES ('goal-2', 'room-1', 'Goal 2', 'completed', 'recurring', 2000)"
        );
        db.exec(
          "INSERT INTO tasks (id, room_id, title, status, restrictions, created_at) VALUES ('task-1', 'room-1', 'Task 1', 'in_progress', NULL, 3000)"
        );
        db.exec(
          "INSERT INTO tasks (id, room_id, title, status, restrictions, created_at) VALUES ('task-2', 'room-1', 'Task 2', 'pending', NULL, 4000)"
        );
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM tasks JOIN goals ON tasks.room_id = goals.room_id',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(4);
        for (const row of parsed.rows) {
          expect(['Goal 1', 'Goal 2']).toContain(row['title:1']);
        }
      });
    });

    describe('CTE queries', () => {
      it('handles CTE with scoped table reference', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active AS (SELECT * FROM tasks WHERE status = ?) SELECT * FROM active',
          params: ['in_progress'],
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0].title).toBe('Task 1');
      });

      it('CTE name is excluded from table-ref scope validation', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active AS (SELECT id, title FROM tasks) SELECT * FROM active',
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).rowCount).toBe(2);
      });

      it('CTE with explicit outer column list is rewritten correctly in scoped mode', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active AS (SELECT id, title, status FROM tasks WHERE status = ?) SELECT id, title FROM active',
          params: ['pending'],
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(1);
        expect(parsed.rows[0].id).toBe('task-2');
        expect(parsed.rows[0].title).toBe('Task 2');
      });
    });

    describe('indirect scope tables filtered correctly', () => {
      it('mission_executions filtered via goals room scope', async () => {
        seedMissionExecutions(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM mission_executions',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(3);
        const goalIds = parsed.rows.map((r: Record<string, unknown>) => r.goal_id);
        expect(goalIds.sort()).toEqual(['goal-1', 'goal-1', 'goal-2']);
      });

      it('indirect scope does not leak data from other scopes', async () => {
        seedMissionExecutions(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-2' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM mission_executions',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(0);
      });
    });

    describe('row limit cap enforced', () => {
      it('default limit is 200', async () => {
        seedRooms(db);
        for (let i = 0; i < 10; i++) {
          db.exec(
            `INSERT INTO tasks (id, room_id, title, status, created_at) VALUES ('bulk-${i}', 'room-1', 'Bulk ${i}', 'pending', ${i})`
          );
        }
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBeLessThanOrEqual(200);
      });

      it('user-specified limit is respected when under max', async () => {
        seedRooms(db);
        for (let i = 0; i < 10; i++) {
          db.exec(
            `INSERT INTO tasks (id, room_id, title, status, created_at) VALUES ('lim-${i}', 'room-1', 'Limit ${i}', 'pending', ${i})`
          );
        }
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM tasks', limit: 3 });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(3);
      });

      it('limit is capped at 1000 even if user requests more', async () => {
        seedRooms(db);
        for (let i = 0; i < 10; i++) {
          db.exec(
            `INSERT INTO goals (id, room_id, title, status, created_at) VALUES ('glimit-${i}', 'room-1', 'Goal Limit ${i}', 'active', ${i})`
          );
        }
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM goals',
          limit: 5000,
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBeLessThanOrEqual(1000);
      });
    });

    describe('truncated flag', () => {
      it('truncated flag is true when results hit the default limit', async () => {
        seedRooms(db);
        for (let i = 0; i < 250; i++) {
          db.exec(
            `INSERT INTO goals (id, room_id, title, status, created_at) VALUES ('trunc-${i}', 'room-1', 'Truncation Test ${i}', 'active', ${i})`
          );
        }
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM goals' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(200);
        expect(parsed.truncated).toBe(true);
      });

      it('truncated flag is false when results fit within limit', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
        expect(parsed.truncated).toBe(false);
      });
    });

    describe('column blacklist removes sensitive columns', () => {
      it('removes config column from rooms in global scope', async () => {
        seedRooms(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM rooms' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        for (const row of parsed.rows) {
          expect(row).not.toHaveProperty('config');
          expect(row).toHaveProperty('id');
          expect(row).toHaveProperty('name');
        }
      });

      it('removes restrictions column from tasks', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        for (const row of parsed.rows) {
          expect(row).not.toHaveProperty('restrictions');
          expect(row).toHaveProperty('id');
          expect(row).toHaveProperty('title');
        }
      });

      it('removes config column from space_workflows in space scope', async () => {
        seedSpaceWorkflows(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM space_workflows' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        for (const row of parsed.rows) {
          expect(row).not.toHaveProperty('config');
          expect(row).not.toHaveProperty('gates');
          expect(row).not.toHaveProperty('channels');
          expect(row).toHaveProperty('id');
          expect(row).toHaveProperty('name');
        }
      });

      it('blacklist does not apply to tables with no blacklisted columns', async () => {
        seedGoals(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM goals' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        expect(parsed.rows[0]).toHaveProperty('id');
        expect(parsed.rows[0]).toHaveProperty('title');
        expect(parsed.rows[0]).toHaveProperty('status');
        expect(parsed.rows[0]).toHaveProperty('mission_type');
      });
    });

    describe('SQL execution errors return isError', () => {
      it('returns error for reference to nonexistent column', async () => {
        seedRooms(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT nonexistent_col FROM rooms',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('Query execution error');
      });

      it('returns error for type mismatch in params', async () => {
        seedRooms(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM rooms WHERE id = ?',
          params: [123],
        });
        if (result.isError) {
          expect(parseResult(result).raw).toContain('Query execution error');
        }
      });
    });

    describe('SELECT DISTINCT preserved in scope wrapping', () => {
      it('DISTINCT is preserved in scoped queries', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT DISTINCT status FROM tasks',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        const statuses = parsed.rows.map((r: Record<string, unknown>) => r.status);
        expect(statuses.sort()).toEqual(['in_progress', 'pending']);
      });
    });

    describe('quoted identifiers rejected', () => {
      it('rejects double-quoted table names', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM "tasks"' });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('Quoted identifiers');
      });

      it('rejects backtick-quoted table names', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM `tasks`' });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('Quoted identifiers');
      });
    });

    describe('OFFSET rejected', () => {
      it('rejects queries with OFFSET clause', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM rooms LIMIT 10 OFFSET 5',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('OFFSET');
      });
    });

    describe('mixed direct/indirect scope JOIN', () => {
      it('JOINs direct-scope and indirect-scope tables correctly', async () => {
        seedMissionExecutions(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM goals JOIN mission_executions ON goals.id = mission_executions.goal_id',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(3);
      });
    });

    describe('UNION queries rejected at handler level', () => {
      it('rejects UNION query with clear error', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id FROM tasks UNION SELECT id FROM goals',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('Compound');
      });
    });

    describe('INTERSECT and EXCEPT rejected at handler level', () => {
      it('rejects INTERSECT query', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id FROM tasks INTERSECT SELECT id FROM goals',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('INTERSECT');
      });

      it('rejects EXCEPT query', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id FROM tasks EXCEPT SELECT id FROM goals',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('EXCEPT');
      });
    });

    describe('WITH RECURSIVE in scoped mode', () => {
      it('single-column WITH RECURSIVE works in scoped mode', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM cnt WHERE n < 5) SELECT * FROM cnt',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(5);
      });

      it('multi-column WITH RECURSIVE works in global scope', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH RECURSIVE hierarchy(id, name, depth) AS (SELECT id, name, 0 FROM rooms WHERE parent_id IS NULL UNION ALL SELECT r.id, r.name, h.depth + 1 FROM rooms r JOIN hierarchy h ON r.parent_id = h.id) SELECT * FROM hierarchy',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
      });
    });

    describe('named-column CTEs in scoped mode', () => {
      it('preserves CTE column list when scope column is included', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active(id, title, room_id) AS (SELECT id, title, room_id FROM tasks) SELECT * FROM active',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });

      it('fails with clear error when CTE omits scope column', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active(id, title) AS (SELECT id, title FROM tasks) SELECT * FROM active',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('room_id');
      });

      it('rewrites CTE without column list (backward compat)', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active AS (SELECT id, title FROM tasks) SELECT * FROM active',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });
    });

    describe('aggregate queries in scoped mode', () => {
      it('COUNT(*) returns correct count for scoped room', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT COUNT(*) AS cnt FROM tasks',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(1);
        expect(parsed.rows[0].cnt).toBe(2);
      });

      it('GROUP BY with aggregate works in scoped mode', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });

      it('aggregate with existing WHERE adds scope filter with AND', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: "SELECT COUNT(*) AS cnt FROM tasks WHERE status = 'in_progress'",
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].cnt).toBe(1);
      });

      it('SUM aggregate works in scoped mode', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT SUM(created_at) AS total FROM tasks',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].total).toBe(3000);
      });
    });

    describe('DISTINCT queries in scoped mode', () => {
      it('DISTINCT deduplicates on selected columns only', async () => {
        seedRooms(db);
        db.exec(
          "INSERT INTO tasks (id, room_id, title, status, priority, created_at) VALUES ('t1', 'room-1', 'A', 'active', 'high', 1000)"
        );
        db.exec(
          "INSERT INTO tasks (id, room_id, title, status, priority, created_at) VALUES ('t2', 'room-1', 'B', 'active', 'normal', 2000)"
        );
        db.exec(
          "INSERT INTO tasks (id, room_id, title, status, priority, created_at) VALUES ('t3', 'room-1', 'C', 'pending', 'low', 3000)"
        );
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT DISTINCT status FROM tasks',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });
    });

    describe('ORDER BY in scoped mode', () => {
      it('ORDER BY is preserved in room scope', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id, title FROM tasks ORDER BY created_at ASC',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].id).toBe('task-1');
        expect(parsed.rows[1].id).toBe('task-2');
      });

      it('ORDER BY DESC is preserved in room scope', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id, title FROM tasks ORDER BY created_at DESC',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].id).toBe('task-2');
        expect(parsed.rows[1].id).toBe('task-1');
      });
    });

    describe('table-less queries in scoped mode', () => {
      it('SELECT 1 returns result without scope filter', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT 1' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0]).toEqual({ '1': 1 });
      });
    });

    describe('global scope limit arg', () => {
      it('respects explicit limit arg in global scope', async () => {
        seedRooms(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM rooms', limit: 2 });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
        expect(parsed.truncated).toBe(true);
      });

      it('uses stricter of arg limit and SQL LIMIT in global scope', async () => {
        seedRooms(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM rooms LIMIT 10',
          limit: 2,
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });
    });

    describe('aggregate query edge cases', () => {
      it('correlated subquery with aggregate in SELECT list is not misclassified', async () => {
        seedGoals(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id, title, (SELECT COUNT(*) FROM tasks) AS total FROM goals',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });

      it('aggregate on indirect-scope table (scopeJoin) works', async () => {
        seedMissionExecutions(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT COUNT(*) AS n FROM mission_executions',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].n).toBe(3);
      });

      it('HAVING clause works in scoped aggregate mode', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status HAVING cnt > 1',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(0);
      });

      it('aggregate with CTE in scoped mode', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: "WITH pending AS (SELECT * FROM tasks WHERE status = 'pending') SELECT COUNT(*) AS n FROM pending",
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].n).toBe(1);
      });

      it('DISTINCT + ORDER BY combined in scoped mode', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT DISTINCT status FROM tasks ORDER BY status',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
        expect(parsed.rows[0].status).toBe('in_progress');
        expect(parsed.rows[1].status).toBe('pending');
      });
    });

    describe('SQL LIMIT honored in scoped mode', () => {
      it('respects SQL LIMIT in room scope', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM tasks LIMIT 1',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(1);
        expect(parsed.truncated).toBe(true);
      });

      it('uses stricter of arg limit and SQL LIMIT in room scope', async () => {
        seedTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM tasks LIMIT 10',
          limit: 1,
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(1);
      });
    });
  });

  describe('db_list_tables', () => {
    it('returns only scope-appropriate tables for room scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_list_tables();
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.tables).toContain('tasks');
      expect(parsed.tables).toContain('goals');
      expect(parsed.tables).toContain('mission_executions');
      expect(parsed.tables).toContain('mission_metric_history');
      expect(parsed.tables).not.toContain('rooms');
      expect(parsed.tables).not.toContain('spaces');
      expect(parsed.tables).not.toContain('space_tasks');
    });

    it('returns only scope-appropriate tables for space scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_list_tables();
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.tables).toContain('space_tasks');
      expect(parsed.tables).toContain('space_workflow_runs');
      expect(parsed.tables).not.toContain('tasks');
      expect(parsed.tables).not.toContain('goals');
      expect(parsed.tables).not.toContain('rooms');
    });

    it('returns global tables for global scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_list_tables();
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.tables).toContain('rooms');
      expect(parsed.tables).toContain('sessions');
      expect(parsed.tables).toContain('spaces');
      expect(parsed.tables).not.toContain('tasks');
      expect(parsed.tables).not.toContain('goals');
    });

    it('includes table descriptions', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_list_tables();
      const parsed = parseResult(result);

      expect(parsed.description).toContain('tasks');
      expect(parsed.description).toContain('goals');
    });
  });

  describe('db_describe_table', () => {
    it('returns column info for an in-scope table', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'tasks' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.description).toContain('tasks');
      expect(parsed.description).toContain('id');
      expect(parsed.description).toContain('room_id');
      expect(parsed.description).toContain('title');
      expect(parsed.description).toContain('status');
    });

    it('excludes blacklisted columns from output', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'tasks' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.description).toContain('hidden');
      const columnTableMatch = parsed.description.match(
        /\|[\s\S]*?\|[\s\S]*?\|[\s\S]*?\|[\s\S]*?\|[\s\S]*?\|/g
      );
      const columnRows = columnTableMatch?.filter((row: string) => row.includes('TEXT')) ?? [];
      for (const row of columnRows) {
        expect(row).not.toContain('restrictions');
      }
    });

    it('includes foreign key info', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'mission_executions' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.description).toContain('Foreign Keys');
      expect(parsed.description).toContain('goals');
    });

    it('rejects tables outside scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'rooms' });
      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible');
    });

    it('rejects non-existent tables', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_describe_table({
        table_name: 'nonexistent_table',
      });
      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible');
    });

    it('shows hidden column count when columns are blacklisted', async () => {
      seedRooms(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'rooms' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.description).toContain('hidden');
      expect(parsed.description).toContain('config');
    });
  });

  describe('createDbQueryMcpServer', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'hyperneo-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates a server with the correct name and tools', () => {
      const dbPath = join(tmpDir, 'test.db');
      const initDb = new Database(dbPath);
      initDb.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT, config TEXT)');
      initDb.close();

      const server = createDbQueryMcpServer({
        dbPath,
        scopeType: 'global',
        scopeValue: '',
      });

      expect(server.name).toBe('db-query');
      expect(server.type).toBe('sdk');
      expect(server.instance._registeredTools).toHaveProperty('db_query');
      expect(server.instance._registeredTools).toHaveProperty('db_list_tables');
      expect(server.instance._registeredTools).toHaveProperty('db_describe_table');

      server.close();
    });

    it('registers tools with correct descriptions', () => {
      const dbPath = join(tmpDir, 'test.db');
      const initDb = new Database(dbPath);
      initDb.exec(
        'CREATE TABLE tasks (id TEXT PRIMARY KEY, room_id TEXT, title TEXT, restrictions TEXT)'
      );
      initDb.close();

      const server = createDbQueryMcpServer({
        dbPath,
        scopeType: 'room',
        scopeValue: 'room-1',
      });

      const queryTool = server.instance._registeredTools.db_query as {
        description: string;
      };
      expect(queryTool.description).toContain('room scope');
      expect(queryTool.description).toContain('SELECT');

      const listTool = server.instance._registeredTools.db_list_tables as {
        description: string;
      };
      expect(listTool.description).toContain('room');

      server.close();
    });

    it('close() properly closes the connection', () => {
      const dbPath = join(tmpDir, 'test.db');
      const initDb = new Database(dbPath);
      initDb.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY)');
      initDb.close();

      const server = createDbQueryMcpServer({
        dbPath,
        scopeType: 'global',
        scopeValue: '',
      });

      expect(() => server.close()).not.toThrow();
    });

    it('db_list_tables and db_describe_table are functional through the MCP server', async () => {
      const dbPath = join(tmpDir, 'test.db');
      const initDb = new Database(dbPath);
      initDb.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT, config TEXT)');
      initDb.exec("INSERT INTO rooms VALUES ('r1', 'Room 1', '{\"m\":\"o\"}')");
      initDb.close();

      const server = createDbQueryMcpServer({
        dbPath,
        scopeType: 'global',
        scopeValue: '',
      });

      expect(server.type).toBe('sdk');
      const listHandler = (
        server.instance._registeredTools.db_list_tables as {
          handler: () => Promise<{ content: Array<{ text: string }> }>;
        }
      ).handler;
      const listed = await listHandler();
      const listData = JSON.parse(listed.content[0].text);
      expect(listData.tables).toContain('rooms');

      const describeHandler = (
        server.instance._registeredTools.db_describe_table as {
          handler: (args: { table_name: string }) => Promise<{ content: Array<{ text: string }> }>;
        }
      ).handler;
      const described = await describeHandler({ table_name: 'rooms' });
      const describeData = JSON.parse(described.content[0].text);
      expect(describeData.description).toContain('## rooms');
      expect(describeData.description).not.toContain('| config |');

      server.close();
    });

    it.skipIf(!isBun)('db_query runs on the worker through the MCP server', async () => {
      const dbPath = join(tmpDir, 'test.db');
      const initDb = new Database(dbPath);
      initDb.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT, config TEXT)');
      initDb.exec("INSERT INTO rooms VALUES ('r1', 'Room 1', '{\"m\":\"o\"}')");
      initDb.close();

      const server = createDbQueryMcpServer({
        dbPath,
        scopeType: 'global',
        scopeValue: '',
      });

      expect(server.type).toBe('sdk');
      const queryHandler = (
        server.instance._registeredTools.db_query as {
          handler: (args: { sql: string }) => Promise<{ content: Array<{ text: string }> }>;
        }
      ).handler;
      const result = await queryHandler({ sql: 'SELECT * FROM rooms' });
      const data = JSON.parse(result.content[0].text);
      expect(data.rows).toHaveLength(1);
      expect(data.rows[0]).not.toHaveProperty('config');

      server.close();
    });
  });

  describe('scope-appropriate JOINs with parameterized filters', () => {
    it('tasks JOIN goals in room scope with parameterized WHERE narrows results', async () => {
      seedGoals(db);
      db.exec(
        "INSERT INTO tasks (id, room_id, title, status, priority, restrictions, created_at) VALUES ('task-1', 'room-1', 'Task 1', 'in_progress', 'high', '{\"maxTokens\":100}', 1000)"
      );
      db.exec(
        "INSERT INTO tasks (id, room_id, title, status, priority, restrictions, created_at) VALUES ('task-2', 'room-1', 'Task 2', 'pending', 'normal', NULL, 2000)"
      );
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT tasks.id AS task_id, goals.id AS goal_id FROM tasks JOIN goals ON tasks.room_id = goals.room_id WHERE goals.status = ?',
        params: ['active'],
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rowCount).toBe(2);
    });

    it('JOIN of two room-scoped tables isolates rows from other rooms', async () => {
      seedGoals(db);
      db.exec(
        "INSERT INTO tasks (id, room_id, title, status, priority, restrictions, created_at) VALUES ('task-1', 'room-1', 'Task 1', 'in_progress', 'high', NULL, 1000)"
      );
      db.exec(
        "INSERT INTO tasks (id, room_id, title, status, priority, restrictions, created_at) VALUES ('task-3', 'room-2', 'Task 3', 'completed', 'low', NULL, 3000)"
      );
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-2' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT * FROM tasks JOIN goals ON tasks.room_id = goals.room_id',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rowCount).toBe(1);
      expect(parsed.rows[0].room_id).toBe('room-2');
    });
  });

  describe('aggregate functions with scope isolation', () => {
    it('SUM aggregate in room scope sees only in-scope rows', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT SUM(created_at) AS total FROM tasks',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows[0].total).toBe(3000);
    });

    it('GROUP BY status with COUNT in room scope filters out other rooms', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status ORDER BY cnt DESC',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      const total = parsed.rows.reduce(
        (sum: number, r: Record<string, unknown>) => sum + (r.cnt as number),
        0
      );
      expect(total).toBe(2);
    });

    it('ORDER BY with parameterized query returns sorted filtered results', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT id, title FROM tasks WHERE status != ? ORDER BY created_at DESC',
        params: ['completed'],
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.rows[0].id).toBe('task-2');
      expect(parsed.rows[1].id).toBe('task-1');
    });

    it('LIMIT restricts rows after scope filtering in room scope', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT id FROM tasks ORDER BY created_at ASC LIMIT 1',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('task-1');
    });

    it('multiple ? params with scope filter combined work correctly', async () => {
      seedMissionExecutions(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT id FROM mission_executions WHERE status = ? AND execution_number >= ?',
        params: ['completed', 1],
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      const ids = parsed.rows.map((r: Record<string, unknown>) => r.id).sort();
      expect(ids).toEqual(['exec-1', 'exec-3']);
    });
  });
});
