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
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			title TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			parent_id TEXT,
			config TEXT,
			session_context TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (parent_id) REFERENCES sessions(id)
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
			priority TEXT NOT NULL DEFAULT 'normal',
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
		CREATE TABLE IF NOT EXISTS workflow_run_artifacts (
			run_id TEXT NOT NULL,
			artifact_id TEXT NOT NULL,
			data TEXT NOT NULL DEFAULT '{}',
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, artifact_id),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id)
		)
	`);

  return db;
}

function seedSessions(db: Database) {
  db.exec(
    "INSERT INTO sessions (id, title, status, parent_id, config, created_at) VALUES ('sess-1', 'Session 1', 'active', NULL, '{\"model\":\"opus\"}', 1000)"
  );
  db.exec(
    "INSERT INTO sessions (id, title, status, parent_id, config, created_at) VALUES ('sess-2', 'Session 2', 'active', 'sess-1', '{\"model\":\"sonnet\"}', 2000)"
  );
  db.exec(
    "INSERT INTO sessions (id, title, status, parent_id, config, created_at) VALUES ('sess-3', 'Session 3', 'ended', 'sess-2', NULL, 3000)"
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

function seedSpaceTasks(db: Database) {
  seedSpaces(db);
  db.exec(
    "INSERT INTO space_tasks (id, space_id, title, status, priority, created_at) VALUES ('task-1', 'space-1', 'Task 1', 'in_progress', 'high', 1000)"
  );
  db.exec(
    "INSERT INTO space_tasks (id, space_id, title, status, priority, created_at) VALUES ('task-2', 'space-1', 'Task 2', 'pending', 'normal', 2000)"
  );
  db.exec(
    "INSERT INTO space_tasks (id, space_id, title, status, priority, created_at) VALUES ('task-3', 'space-2', 'Task 3', 'completed', 'low', 3000)"
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

function seedRunArtifacts(db: Database) {
  seedSpaceWorkflowRuns(db);
  db.exec(
    "INSERT INTO workflow_run_artifacts (run_id, artifact_id, data, updated_at) VALUES ('run-1', 'art-1', '{\"approved\":true}', 1000)"
  );
  db.exec(
    "INSERT INTO workflow_run_artifacts (run_id, artifact_id, data, updated_at) VALUES ('run-2', 'art-1', '{\"approved\":false}', 2000)"
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
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM space_tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        expect(parsed.rowCount).toBe(2);
        expect(parsed.rows[0].space_id).toBe('space-1');
      });

      it('returns rows with explicit columns', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT id, title FROM space_tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        expect(parsed.rows[0]).toHaveProperty('id');
        expect(parsed.rows[0]).toHaveProperty('title');
      });

      it('returns rows with WHERE clause', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM space_tasks WHERE status = ?',
          params: ['pending'],
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0].title).toBe('Task 2');
      });

      it('global scope returns all rows without filtering', async () => {
        seedSessions(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM sessions' });
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
          sql: 'INSERT INTO sessions (id, title) VALUES (?, ?)',
          params: ['sess-x', 'X'],
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
          sql: 'UPDATE sessions SET title = ? WHERE id = ?',
          params: ['New Name', 'space-1'],
        });
        expect(result.isError).toBe(true);
      });

      it('rejects DELETE', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'DELETE FROM sessions' });
        expect(result.isError).toBe(true);
      });

      it('rejects DROP TABLE', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'DROP TABLE sessions' });
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
      it('space scope rejects global-only tables (spaces)', async () => {
        seedSpaces(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM spaces' });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('not accessible');
      });

      it('prevents cross-scope joins', async () => {
        seedSpaceTasks(db);
        seedSpaces(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM space_tasks JOIN spaces ON space_tasks.id = spaces.id',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('not accessible');
      });
    });

    describe('scope subquery wrapping filters results correctly', () => {
      it('space scope filters space_tasks by space_id', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM space_tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        for (const row of parsed.rows) {
          expect(row.space_id).toBe('space-1');
        }
      });

      it('space scope filters space_workflow_runs by space_id', async () => {
        seedSpaceWorkflowRuns(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM space_workflow_runs' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        for (const row of parsed.rows) {
          expect(row.space_id).toBe('space-1');
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
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM space_tasks WHERE status = ?',
          params: ['pending'],
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0].title).toBe('Task 2');
        expect(parsed.rows[0].space_id).toBe('space-1');
      });

      it('scope filter works with user params', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM space_tasks WHERE priority = ?',
          params: ['high'],
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0].title).toBe('Task 1');
      });
    });

    describe('same-scope JOIN queries', () => {
      it('JOINs two space-scoped tables with deduplicated scope filter', async () => {
        seedSessions(db);
        db.exec(
          "INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at) VALUES ('run-a', 'space-1', 'wf-1', 'Run A', 'active', 1000)"
        );
        db.exec(
          "INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at) VALUES ('run-b', 'space-1', 'wf-1', 'Run B', 'completed', 2000)"
        );
        db.exec(
          "INSERT INTO space_tasks (id, space_id, title, status, created_at) VALUES ('task-1', 'space-1', 'Task 1', 'in_progress', 3000)"
        );
        db.exec(
          "INSERT INTO space_tasks (id, space_id, title, status, created_at) VALUES ('task-2', 'space-1', 'Task 2', 'pending', 4000)"
        );
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM space_tasks JOIN space_workflow_runs ON space_tasks.space_id = space_workflow_runs.space_id',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(4);
        for (const row of parsed.rows) {
          expect(['Run A', 'Run B']).toContain(row['title:1']);
        }
      });
    });

    describe('CTE queries', () => {
      it('handles CTE with scoped table reference', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active AS (SELECT * FROM space_tasks WHERE status = ?) SELECT * FROM active',
          params: ['in_progress'],
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(1);
        expect(parsed.rows[0].title).toBe('Task 1');
      });

      it('CTE name is excluded from table-ref scope validation', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active AS (SELECT id, title FROM space_tasks) SELECT * FROM active',
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).rowCount).toBe(2);
      });

      it('CTE with explicit outer column list is rewritten correctly in scoped mode', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active AS (SELECT id, title, status FROM space_tasks WHERE status = ?) SELECT id, title FROM active',
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
      it('workflow_run_artifacts filtered via space_workflow_runs indirect scope', async () => {
        seedRunArtifacts(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM workflow_run_artifacts',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        const runIds = parsed.rows.map((r: Record<string, unknown>) => r.run_id);
        expect(runIds.sort()).toEqual(['run-1', 'run-2']);
      });

      it('indirect scope does not leak data from other scopes', async () => {
        seedRunArtifacts(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-2' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM workflow_run_artifacts',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(0);
      });
    });

    describe('row limit cap enforced', () => {
      it('default limit is 200', async () => {
        seedSessions(db);
        for (let i = 0; i < 10; i++) {
          db.exec(
            `INSERT INTO space_tasks (id, space_id, title, status, created_at) VALUES ('bulk-${i}', 'space-1', 'Bulk ${i}', 'pending', ${i})`
          );
        }
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM space_tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBeLessThanOrEqual(200);
      });

      it('user-specified limit is respected when under max', async () => {
        seedSessions(db);
        for (let i = 0; i < 10; i++) {
          db.exec(
            `INSERT INTO space_tasks (id, space_id, title, status, created_at) VALUES ('lim-${i}', 'space-1', 'Limit ${i}', 'pending', ${i})`
          );
        }
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM space_tasks', limit: 3 });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(3);
      });

      it('limit is capped at 1000 even if user requests more', async () => {
        seedSessions(db);
        for (let i = 0; i < 10; i++) {
          db.exec(
            `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at) VALUES ('rlimit-${i}', 'space-1', 'wf-1', 'Run Limit ${i}', 'active', ${i})`
          );
        }
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM space_workflow_runs',
          limit: 5000,
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBeLessThanOrEqual(1000);
      });
    });

    describe('truncated flag', () => {
      it('truncated flag is true when results hit the default limit', async () => {
        seedSessions(db);
        for (let i = 0; i < 250; i++) {
          db.exec(
            `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at) VALUES ('trunc-${i}', 'space-1', 'wf-1', 'Truncation Test ${i}', 'active', ${i})`
          );
        }
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM space_workflow_runs' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(200);
        expect(parsed.truncated).toBe(true);
      });

      it('truncated flag is false when results fit within limit', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM space_tasks' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
        expect(parsed.truncated).toBe(false);
      });
    });

    describe('column blacklist removes sensitive columns', () => {
      it('removes config column from sessions in global scope', async () => {
        seedSessions(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM sessions' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        for (const row of parsed.rows) {
          expect(row).not.toHaveProperty('config');
          expect(row).toHaveProperty('id');
          expect(row).toHaveProperty('name');
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
        seedSpaceWorkflowRuns(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM space_workflow_runs' });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(2);
        expect(parsed.rows[0]).toHaveProperty('id');
        expect(parsed.rows[0]).toHaveProperty('title');
        expect(parsed.rows[0]).toHaveProperty('status');
        expect(parsed.rows[0]).toHaveProperty('workflow_id');
      });
    });

    describe('SQL execution errors return isError', () => {
      it('returns error for reference to nonexistent column', async () => {
        seedSessions(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT nonexistent_col FROM sessions',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('Query execution error');
      });

      it('returns error for type mismatch in params', async () => {
        seedSessions(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM sessions WHERE id = ?',
          params: [123],
        });
        if (result.isError) {
          expect(parseResult(result).raw).toContain('Query execution error');
        }
      });
    });

    describe('SELECT DISTINCT preserved in scope wrapping', () => {
      it('DISTINCT is preserved in scoped queries', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT DISTINCT status FROM space_tasks',
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
        const result = await handlers.db_query({ sql: 'SELECT * FROM "space_tasks"' });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('Quoted identifiers');
      });

      it('rejects backtick-quoted table names', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM `space_tasks`' });
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
          sql: 'SELECT * FROM sessions LIMIT 10 OFFSET 5',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('OFFSET');
      });
    });

    describe('mixed direct/indirect scope JOIN', () => {
      it('JOINs direct-scope and indirect-scope tables correctly', async () => {
        seedRunArtifacts(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM space_workflow_runs JOIN workflow_run_artifacts ON space_workflow_runs.id = workflow_run_artifacts.run_id',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows).toHaveLength(3);
      });
    });

    describe('UNION queries rejected at handler level', () => {
      it('rejects UNION query with clear error', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id FROM space_tasks UNION SELECT id FROM space_workflow_runs',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('Compound');
      });
    });

    describe('INTERSECT and EXCEPT rejected at handler level', () => {
      it('rejects INTERSECT query', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id FROM space_tasks INTERSECT SELECT id FROM space_workflow_runs',
        });
        expect(result.isError).toBe(true);
        expect(parseResult(result).raw).toContain('INTERSECT');
      });

      it('rejects EXCEPT query', async () => {
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id FROM space_tasks EXCEPT SELECT id FROM space_workflow_runs',
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
          sql: 'WITH RECURSIVE hierarchy(id, title, depth) AS (SELECT id, title, 0 FROM sessions WHERE parent_id IS NULL UNION ALL SELECT s.id, s.title, h.depth + 1 FROM sessions s JOIN hierarchy h ON s.parent_id = h.id) SELECT * FROM hierarchy',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
      });
    });

    describe('named-column CTEs in scoped mode', () => {
      it('preserves CTE column list when scope column is included', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active(id, title, space_id) AS (SELECT id, title, space_id FROM space_tasks) SELECT * FROM active',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });

      it('still scopes a CTE that omits the scope column from its projection', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active(id, title) AS (SELECT id, title FROM space_tasks) SELECT * FROM active',
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });

      it('rewrites CTE without column list (backward compat)', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'WITH active AS (SELECT id, title FROM space_tasks) SELECT * FROM active',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });
    });

    describe('aggregate queries in scoped mode', () => {
      it('COUNT(*) returns correct count for the scoped space', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT COUNT(*) AS cnt FROM space_tasks',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(1);
        expect(parsed.rows[0].cnt).toBe(2);
      });

      it('GROUP BY with aggregate works in scoped mode', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT status, COUNT(*) AS cnt FROM space_tasks GROUP BY status',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });

      it('aggregate with existing WHERE adds scope filter with AND', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: "SELECT COUNT(*) AS cnt FROM space_tasks WHERE status = 'in_progress'",
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].cnt).toBe(1);
      });

      it('SUM aggregate works in scoped mode', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT SUM(created_at) AS total FROM space_tasks',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].total).toBe(3000);
      });
    });

    describe('DISTINCT queries in scoped mode', () => {
      it('DISTINCT deduplicates on selected columns only', async () => {
        seedSessions(db);
        db.exec(
          "INSERT INTO space_tasks (id, space_id, title, status, priority, created_at) VALUES ('t1', 'space-1', 'A', 'active', 'high', 1000)"
        );
        db.exec(
          "INSERT INTO space_tasks (id, space_id, title, status, priority, created_at) VALUES ('t2', 'space-1', 'B', 'active', 'normal', 2000)"
        );
        db.exec(
          "INSERT INTO space_tasks (id, space_id, title, status, priority, created_at) VALUES ('t3', 'space-1', 'C', 'pending', 'low', 3000)"
        );
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT DISTINCT status FROM space_tasks',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });
    });

    describe('ORDER BY in scoped mode', () => {
      it('ORDER BY is preserved in space scope', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id, title FROM space_tasks ORDER BY created_at ASC',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].id).toBe('task-1');
        expect(parsed.rows[1].id).toBe('task-2');
      });

      it('ORDER BY DESC is preserved in space scope', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id, title FROM space_tasks ORDER BY created_at DESC',
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
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
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
        seedSessions(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({ sql: 'SELECT * FROM sessions', limit: 2 });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
        expect(parsed.truncated).toBe(true);
      });

      it('uses stricter of arg limit and SQL LIMIT in global scope', async () => {
        seedSessions(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM sessions LIMIT 10',
          limit: 2,
        });
        const parsed = parseResult(result);

        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });
    });

    describe('aggregate query edge cases', () => {
      it('correlated subquery with aggregate in SELECT list is not misclassified', async () => {
        seedSpaceWorkflowRuns(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT id, title, (SELECT COUNT(*) FROM space_tasks) AS total FROM space_workflow_runs',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
      });

      it('aggregate on indirect-scope table (scopeJoin) works', async () => {
        seedRunArtifacts(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT COUNT(*) AS n FROM workflow_run_artifacts',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].n).toBe(2);
      });

      it('HAVING clause works in scoped aggregate mode', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT status, COUNT(*) AS cnt FROM space_tasks GROUP BY status HAVING cnt > 1',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(0);
      });

      it('aggregate with CTE in scoped mode', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: "WITH pending AS (SELECT * FROM space_tasks WHERE status = 'pending') SELECT COUNT(*) AS n FROM pending",
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rows[0].n).toBe(1);
      });

      it('DISTINCT + ORDER BY combined in scoped mode', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT DISTINCT status FROM space_tasks ORDER BY status',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(2);
        expect(parsed.rows[0].status).toBe('in_progress');
        expect(parsed.rows[1].status).toBe('pending');
      });
    });

    describe('SQL LIMIT honored in scoped mode', () => {
      it('respects SQL LIMIT in space scope', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM space_tasks LIMIT 1',
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(1);
        expect(parsed.truncated).toBe(true);
      });

      it('uses stricter of arg limit and SQL LIMIT in space scope', async () => {
        seedSpaceTasks(db);
        const handlers = createDbQueryToolHandlers(
          { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
          db
        );
        const result = await handlers.db_query({
          sql: 'SELECT * FROM space_tasks LIMIT 10',
          limit: 1,
        });
        const parsed = parseResult(result);
        expect(parsed.isError).toBeFalsy();
        expect(parsed.rowCount).toBe(1);
      });
    });
  });

  describe('db_list_tables', () => {
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
      expect(parsed.tables).not.toContain('spaces');
    });

    it('returns global tables for global scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_list_tables();
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.tables).toContain('sessions');
      expect(parsed.tables).toContain('spaces');
      expect(parsed.tables).not.toContain('space_tasks');
      expect(parsed.tables).not.toContain('space_workflow_runs');
    });

    it('includes table descriptions', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_list_tables();
      const parsed = parseResult(result);

      expect(parsed.description).toContain('space_tasks');
      expect(parsed.description).toContain('space_workflow_runs');
    });
  });

  describe('db_describe_table', () => {
    it('returns column info for an in-scope table', async () => {
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'space_tasks' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.description).toContain('space_tasks');
      expect(parsed.description).toContain('id');
      expect(parsed.description).toContain('space_id');
      expect(parsed.description).toContain('title');
      expect(parsed.description).toContain('status');
    });

    it('excludes blacklisted columns from output', async () => {
      seedSpaceWorkflows(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'space_workflows' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.description).toContain('hidden');
      const columnTableMatch = parsed.description.match(
        /\|[\s\S]*?\|[\s\S]*?\|[\s\S]*?\|[\s\S]*?\|[\s\S]*?\|/g
      );
      const columnRows = columnTableMatch?.filter((row: string) => row.includes('TEXT')) ?? [];
      for (const row of columnRows) {
        expect(row).not.toContain('config');
      }
    });

    it('includes foreign key info', async () => {
      seedRunArtifacts(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'workflow_run_artifacts' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.description).toContain('Foreign Keys');
      expect(parsed.description).toContain('space_workflow_runs');
    });

    it('rejects tables outside scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'spaces' });
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
      seedSessions(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'sessions' });
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
      initDb.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, config TEXT)');
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
        'CREATE TABLE space_tasks (id TEXT PRIMARY KEY, space_id TEXT, title TEXT, status TEXT)'
      );
      initDb.close();

      const server = createDbQueryMcpServer({
        dbPath,
        scopeType: 'space',
        scopeValue: 'space-1',
      });

      const queryTool = server.instance._registeredTools.db_query as {
        description: string;
      };
      expect(queryTool.description).toContain('space scope');
      expect(queryTool.description).toContain('SELECT');

      const listTool = server.instance._registeredTools.db_list_tables as {
        description: string;
      };
      expect(listTool.description).toContain('space');

      server.close();
    });

    it('close() properly closes the connection', () => {
      const dbPath = join(tmpDir, 'test.db');
      const initDb = new Database(dbPath);
      initDb.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
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
      initDb.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, config TEXT)');
      initDb.exec("INSERT INTO sessions VALUES ('s1', 'Session 1', '{\"m\":\"o\"}')");
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
      expect(listData.tables).toContain('sessions');

      const describeHandler = (
        server.instance._registeredTools.db_describe_table as {
          handler: (args: { table_name: string }) => Promise<{ content: Array<{ text: string }> }>;
        }
      ).handler;
      const described = await describeHandler({ table_name: 'sessions' });
      const describeData = JSON.parse(described.content[0].text);
      expect(describeData.description).toContain('## sessions');
      expect(describeData.description).not.toContain('| config |');

      server.close();
    });

    it.skipIf(!isBun)('db_query runs on the worker through the MCP server', async () => {
      const dbPath = join(tmpDir, 'test.db');
      const initDb = new Database(dbPath);
      initDb.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, config TEXT)');
      initDb.exec("INSERT INTO sessions VALUES ('s1', 'Session 1', '{\"m\":\"o\"}')");
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
      const result = await queryHandler({ sql: 'SELECT * FROM sessions' });
      const data = JSON.parse(result.content[0].text);
      expect(data.rows).toHaveLength(1);
      expect(data.rows[0]).not.toHaveProperty('config');

      server.close();
    });

    it('db_query returns a controlled error when workers are unavailable', async () => {
      const dbPath = join(tmpDir, 'test.db');
      const initDb = new Database(dbPath);
      initDb.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, config TEXT)');
      initDb.exec("INSERT INTO sessions VALUES ('s1', 'Session 1', '{\"m\":\"o\"}')");
      initDb.close();

      const server = createDbQueryMcpServer({
        dbPath,
        scopeType: 'global',
        scopeValue: '',
      });

      const originalWorker = (globalThis as { Worker?: unknown }).Worker;
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        value: undefined,
        writable: true,
      });
      try {
        const queryHandler = (
          server.instance._registeredTools.db_query as {
            handler: (args: { sql: string }) => Promise<{
              content: Array<{ text: string }>;
              isError?: boolean;
            }>;
          }
        ).handler;
        const result = await queryHandler({ sql: 'SELECT * FROM sessions' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('db_query worker unavailable');
      } finally {
        Object.defineProperty(globalThis, 'Worker', {
          configurable: true,
          value: originalWorker,
          writable: true,
        });
      }

      server.close();
    });
  });

  describe('scope-appropriate JOINs with parameterized filters', () => {
    it('space_tasks JOIN space_workflow_runs in space scope with parameterized WHERE narrows results', async () => {
      seedSpaceWorkflowRuns(db);
      db.exec(
        "INSERT INTO space_tasks (id, space_id, title, status, priority, created_at) VALUES ('task-1', 'space-1', 'Task 1', 'in_progress', 'high', 1000)"
      );
      db.exec(
        "INSERT INTO space_tasks (id, space_id, title, status, priority, created_at) VALUES ('task-2', 'space-1', 'Task 2', 'pending', 'normal', 2000)"
      );
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT space_tasks.id AS task_id, space_workflow_runs.id AS run_id FROM space_tasks JOIN space_workflow_runs ON space_tasks.space_id = space_workflow_runs.space_id WHERE space_workflow_runs.status = ?',
        params: ['active'],
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rowCount).toBe(2);
    });

    it('JOIN of two space-scoped tables isolates rows from other spaces', async () => {
      seedSpaceWorkflowRuns(db);
      db.exec(
        "INSERT INTO space_tasks (id, space_id, title, status, priority, created_at) VALUES ('task-1', 'space-1', 'Task 1', 'in_progress', 'high', 1000)"
      );
      db.exec(
        "INSERT INTO space_tasks (id, space_id, title, status, priority, created_at) VALUES ('task-3', 'space-2', 'Task 3', 'completed', 'low', 3000)"
      );
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-2' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT * FROM space_tasks JOIN space_workflow_runs ON space_tasks.space_id = space_workflow_runs.space_id',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rowCount).toBe(1);
      expect(parsed.rows[0].space_id).toBe('space-2');
    });
  });

  describe('aggregate functions with scope isolation', () => {
    it('SUM aggregate in space scope sees only in-scope rows', async () => {
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT SUM(created_at) AS total FROM space_tasks',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows[0].total).toBe(3000);
    });

    it('GROUP BY status with COUNT in space scope filters out other spaces', async () => {
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT status, COUNT(*) AS cnt FROM space_tasks GROUP BY status ORDER BY cnt DESC',
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
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT id, title FROM space_tasks WHERE status != ? ORDER BY created_at DESC',
        params: ['completed'],
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.rows[0].id).toBe('task-2');
      expect(parsed.rows[1].id).toBe('task-1');
    });

    it('LIMIT restricts rows after scope filtering in space scope', async () => {
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT id FROM space_tasks ORDER BY created_at ASC LIMIT 1',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('task-1');
    });

    it('multiple ? params with scope filter combined work correctly', async () => {
      seedRunArtifacts(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT run_id FROM workflow_run_artifacts WHERE artifact_id = ? AND updated_at >= ?',
        params: ['art-1', 1000],
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      const ids = parsed.rows.map((r: Record<string, unknown>) => r.run_id).sort();
      expect(ids).toEqual(['run-1', 'run-2']);
    });
  });
});
