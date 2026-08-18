import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createDbQueryToolHandlers } from '../../../../src/lib/db-query/tools.ts';

function createFullSchemaDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  return db;
}

function seedRooms(db: Database): void {
  db.exec(
    "INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES ('room-int-1', 'Integration Room 1', 1000, 1000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES ('room-int-2', 'Integration Room 2', 2000, 2000)"
  );
}

function seedTasks(db: Database): void {
  seedRooms(db);
  db.exec(
    "INSERT OR IGNORE INTO tasks (id, room_id, title, description, created_at) VALUES ('task-int-1', 'room-int-1', 'Integration Task 1', '', 1000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO tasks (id, room_id, title, description, status, created_at) VALUES ('task-int-2', 'room-int-1', 'Integration Task 2', '', 'in_progress', 2000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO tasks (id, room_id, title, description, created_at) VALUES ('task-int-3', 'room-int-2', 'Integration Task 3', '', 3000)"
  );
}

function seedGoals(db: Database): void {
  seedRooms(db);
  db.exec(
    "INSERT OR IGNORE INTO goals (id, room_id, title, created_at, updated_at) VALUES ('goal-int-1', 'room-int-1', 'Goal Int 1', 1000, 1000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO goals (id, room_id, title, created_at, updated_at) VALUES ('goal-int-2', 'room-int-1', 'Goal Int 2', 2000, 2000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO goals (id, room_id, title, created_at, updated_at) VALUES ('goal-int-3', 'room-int-2', 'Goal Int 3', 3000, 3000)"
  );
}

function seedMissionExecutions(db: Database): void {
  seedGoals(db);
  db.exec(
    "INSERT OR IGNORE INTO mission_executions (id, goal_id, execution_number, status) VALUES ('exec-int-1', 'goal-int-1', 1, 'running')"
  );
  db.exec(
    "INSERT OR IGNORE INTO mission_executions (id, goal_id, execution_number, status) VALUES ('exec-int-2', 'goal-int-1', 2, 'completed')"
  );
  db.exec(
    "INSERT OR IGNORE INTO mission_executions (id, goal_id, execution_number, status) VALUES ('exec-int-3', 'goal-int-2', 1, 'completed')"
  );
  db.exec(
    "INSERT OR IGNORE INTO mission_executions (id, goal_id, execution_number, status) VALUES ('exec-int-4', 'goal-int-3', 1, 'running')"
  );
}

function seedSpaces(db: Database): void {
  db.exec(
    "INSERT OR IGNORE INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('space-int-1', 'space-int-1', '/tmp/space-int-1', 'Space Int 1', 1000, 1000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('space-int-2', 'space-int-2', '/tmp/space-int-2', 'Space Int 2', 2000, 2000)"
  );
}

function seedSpaceTasks(db: Database): void {
  seedSpaces(db);
  db.exec(
    "INSERT OR IGNORE INTO space_tasks (id, space_id, task_number, title, created_at, updated_at) VALUES ('stask-int-1', 'space-int-1', 1, 'Space Task 1', 1000, 1000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO space_tasks (id, space_id, task_number, title, status, created_at, updated_at) VALUES ('stask-int-2', 'space-int-1', 2, 'Space Task 2', 'in_progress', 2000, 2000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO space_tasks (id, space_id, task_number, title, created_at, updated_at) VALUES ('stask-int-3', 'space-int-2', 1, 'Space Task 3', 3000, 3000)"
  );
}

function seedSpaceWorkflows(db: Database): void {
  seedSpaces(db);
  db.exec(
    "INSERT OR IGNORE INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('swf-int-1', 'space-int-1', 'Workflow Int 1', 1000, 1000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('swf-int-2', 'space-int-2', 'Workflow Int 2', 2000, 2000)"
  );
}

function seedSpaceWorkflowRuns(db: Database): void {
  seedSpaceWorkflows(db);
  db.exec(
    "INSERT OR IGNORE INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES ('swfr-int-1', 'space-int-1', 'swf-int-1', 'Run Int 1', 1000, 1000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES ('swfr-int-2', 'space-int-1', 'swf-int-1', 'Run Int 2', 2000, 2000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES ('swfr-int-3', 'space-int-2', 'swf-int-2', 'Run Int 3', 3000, 3000)"
  );
}

function seedGateData(db: Database): void {
  seedSpaceWorkflowRuns(db);
  db.exec(
    "INSERT OR IGNORE INTO gate_data (run_id, gate_id, data, updated_at) VALUES ('swfr-int-1', 'gate-a', '{\"approved\":true}', 1000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO gate_data (run_id, gate_id, data, updated_at) VALUES ('swfr-int-2', 'gate-a', '{\"approved\":false}', 2000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO gate_data (run_id, gate_id, data, updated_at) VALUES ('swfr-int-3', 'gate-b', '{\"approved\":true}', 3000)"
  );
}

function seedRoomGithubMappings(db: Database): void {
  seedRooms(db);
  db.exec(
    "INSERT OR IGNORE INTO room_github_mappings (id, room_id, repositories, created_at, updated_at) VALUES ('rgm-int-1', 'room-int-1', '[\"owner/repo1\"]', 1000, 1000)"
  );
  db.exec(
    "INSERT OR IGNORE INTO room_github_mappings (id, room_id, repositories, created_at, updated_at) VALUES ('rgm-int-2', 'room-int-2', '[\"owner/repo2\"]', 2000, 2000)"
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

describe('db-query integration', () => {
  let db: Database;

  beforeEach(() => {
    db = createFullSchemaDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('room scope', () => {
    it('can query tasks filtered to the specified room_id', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      for (const row of parsed.rows) {
        expect(row.room_id).toBe('room-int-1');
      }
    });

    it('task rows do not include the blacklisted restrictions column', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      for (const row of parsed.rows) {
        expect(row).not.toHaveProperty('restrictions');
      }
    });

    it('can query goals filtered to the specified room_id', async () => {
      seedGoals(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id, title FROM goals' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      const ids = parsed.rows.map((r: Record<string, unknown>) => r.id).sort();
      expect(ids).toEqual(['goal-int-1', 'goal-int-2']);
    });

    it('goals not in the scoped room are excluded', async () => {
      seedGoals(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-2' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id FROM goals' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('goal-int-3');
    });

    it('can query mission_executions filtered via goals indirect scope', async () => {
      seedMissionExecutions(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id, goal_id FROM mission_executions' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(3);
      const ids = parsed.rows.map((r: Record<string, unknown>) => r.id).sort();
      expect(ids).toEqual(['exec-int-1', 'exec-int-2', 'exec-int-3']);
    });

    it('mission_executions from other rooms are excluded via indirect scope', async () => {
      seedMissionExecutions(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-2' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id FROM mission_executions' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('exec-int-4');
    });

    it('can query room_github_mappings filtered to the specified room_id', async () => {
      seedRoomGithubMappings(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT id, room_id FROM room_github_mappings',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('rgm-int-1');
    });

    it('can JOIN tasks and goals (both room-scoped) with scope filter applied', async () => {
      seedTasks(db);
      seedGoals(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT tasks.id AS task_id, goals.id AS goal_id FROM tasks JOIN goals ON tasks.room_id = goals.room_id',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(4);
    });

    it('cannot query space-scoped table space_tasks — rejected with scope error', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM space_tasks' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('cannot query space-scoped table space_workflows — rejected with scope error', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM space_workflows' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('cannot query sensitive table auth_config — rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM auth_config' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('cannot query sensitive table global_settings — rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM global_settings' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('cross-scope JOIN tasks with space_tasks is rejected for room scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT * FROM tasks JOIN space_tasks ON tasks.id = space_tasks.id',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('parameterized query with ? placeholder filters correctly in room scope', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT id FROM tasks WHERE status = ?',
        params: ['in_progress'],
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('task-int-2');
    });

    it('COUNT aggregate returns correct count for scoped room', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT COUNT(*) AS cnt FROM tasks' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows[0].cnt).toBe(2);
    });

    it('GROUP BY status works in room scope with full schema', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status ORDER BY status',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      const statuses = parsed.rows.map((r: Record<string, unknown>) => r.status).sort();
      expect(statuses).toEqual(['in_progress', 'pending']);
    });

    it('ORDER BY and LIMIT work in room scope with full schema', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('task-int-2');
    });

    it('db_list_tables shows room-scoped tables only (no space or global tables)', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_list_tables();
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.tables).toContain('tasks');
      expect(parsed.tables).toContain('goals');
      expect(parsed.tables).toContain('mission_executions');
      expect(parsed.tables).not.toContain('space_tasks');
      expect(parsed.tables).not.toContain('space_workflows');
      expect(parsed.tables).not.toContain('auth_config');
      expect(parsed.tables).not.toContain('global_settings');
    });

    it('db_describe_table works for tasks table in room scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'tasks' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.description).toContain('tasks');
      expect(parsed.description).not.toContain('| restrictions |');
    });

    it('db_describe_table rejects out-of-scope space_tasks in room scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'space_tasks' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });
  });

  describe('space scope', () => {
    it('can query space_tasks filtered to the specified space_id', async () => {
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM space_tasks' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      for (const row of parsed.rows) {
        expect(row.space_id).toBe('space-int-1');
      }
    });

    it('space_tasks from other spaces are excluded', async () => {
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-2' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id FROM space_tasks' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('stask-int-3');
    });

    it('can query space_workflows filtered to the specified space_id', async () => {
      seedSpaceWorkflows(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id, name FROM space_workflows' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('swf-int-1');
    });

    it('space_workflows blacklisted columns (config, gates, channels) are excluded', async () => {
      seedSpaceWorkflows(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
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

    it('cannot query room-scoped table tasks — rejected with scope error', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM tasks' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in space scope');
    });

    it('cannot query room-scoped table goals — rejected with scope error', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM goals' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in space scope');
    });

    it('cannot query sensitive table auth_config from space scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM auth_config' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in space scope');
    });

    it('COUNT aggregate in space scope returns correct filtered count', async () => {
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT COUNT(*) AS cnt FROM space_tasks' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows[0].cnt).toBe(2);
    });

    it('db_list_tables shows space-scoped tables only (no room or global tables)', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_list_tables();
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.tables).toContain('space_tasks');
      expect(parsed.tables).toContain('space_workflows');
      expect(parsed.tables).not.toContain('tasks');
      expect(parsed.tables).not.toContain('goals');
      expect(parsed.tables).not.toContain('auth_config');
    });

    it('db_describe_table rejects out-of-scope tasks in space scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'tasks' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in space scope');
    });

    it('cross-scope JOIN space_tasks with tasks is rejected for space scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT * FROM space_tasks JOIN tasks ON space_tasks.id = tasks.id',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in space scope');
    });

    it('can query sessions belonging to this space (session ID prefix filtering)', async () => {
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-1:task:task-1', 'Task Agent 1', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-1:task:task-1:node:n1', 'Node 1', datetime('now'), datetime('now'), 'ended', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-2:task:task-9', 'Other Space Task', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('regular-session-xyz', 'Regular', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );

      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id, title FROM sessions' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      const ids = parsed.rows.map((r: Record<string, unknown>) => r.id).sort();
      expect(ids).toEqual([
        'space:space-int-1:task:task-1',
        'space:space-int-1:task:task-1:node:n1',
      ]);
    });

    it('sessions from other spaces are excluded (space isolation)', async () => {
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-1:task:task-A', 'Space 1 Task', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-2:task:task-B', 'Space 2 Task', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );

      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-2' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id FROM sessions' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('space:space-int-2:task:task-B');
    });

    it('sessions rows exclude blacklisted columns (config, session_context)', async () => {
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata, session_context) VALUES ('space:space-int-1:task:task-X', 'Sensitive Test', datetime('now'), datetime('now'), 'active', '{\"secret\":true}', '{}', '{\"spaceId\":\"space-int-1\"}')"
      );

      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM sessions' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      for (const row of parsed.rows) {
        expect(row).not.toHaveProperty('config');
        expect(row).not.toHaveProperty('session_context');
        expect(row).toHaveProperty('id');
        expect(row).toHaveProperty('title');
        expect(row).toHaveProperty('status');
      }
    });

    it('can query sdk_messages for sessions in this space', async () => {
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-1:task:msg-task', 'Msg Task', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-2:task:msg-task2', 'Other Msg Task', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );

      db.exec(
        "INSERT OR IGNORE INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp) VALUES ('msg-1', 'space:space-int-1:task:msg-task', 'user', '{\"role\":\"user\"}', '2024-01-01T00:00:00Z')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp) VALUES ('msg-2', 'space:space-int-1:task:msg-task', 'assistant', '{\"role\":\"assistant\"}', '2024-01-01T00:00:01Z')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp) VALUES ('msg-3', 'space:space-int-2:task:msg-task2', 'user', '{\"role\":\"user\"}', '2024-01-01T00:00:02Z')"
      );

      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT id, session_id, message_type FROM sdk_messages',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
      const ids = parsed.rows.map((r: Record<string, unknown>) => r.id).sort();
      expect(ids).toEqual(['msg-1', 'msg-2']);
      for (const row of parsed.rows) {
        expect(row.session_id).toBe('space:space-int-1:task:msg-task');
      }
    });

    it('sdk_messages from other spaces are excluded', async () => {
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-1:task:iso-1', 'Iso1', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-2:task:iso-2', 'Iso2', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp) VALUES ('iso-msg-1', 'space:space-int-1:task:iso-1', 'user', '{}', '2024-01-01T00:00:00Z')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp) VALUES ('iso-msg-2', 'space:space-int-2:task:iso-2', 'user', '{}', '2024-01-01T00:00:01Z')"
      );

      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-2' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id FROM sdk_messages' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('iso-msg-2');
    });

    it('can query session_group_members filtered by space session ID prefix', async () => {
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-1:task:sg-task', 'SG Task', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-2:task:sg-task2', 'SG Task2', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO session_groups (id, group_type, ref_id, created_at) VALUES ('grp-s1', 'task', 'ref-1', 1000)"
      );
      db.exec(
        "INSERT OR IGNORE INTO session_groups (id, group_type, ref_id, created_at) VALUES ('grp-s2', 'task', 'ref-2', 2000)"
      );
      db.exec(
        "INSERT OR IGNORE INTO session_group_members (group_id, session_id, role, joined_at) VALUES ('grp-s1', 'space:space-int-1:task:sg-task', 'coder', 1000)"
      );
      db.exec(
        "INSERT OR IGNORE INTO session_group_members (group_id, session_id, role, joined_at) VALUES ('grp-s2', 'space:space-int-2:task:sg-task2', 'coder', 2000)"
      );

      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT group_id, session_id FROM session_group_members',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].group_id).toBe('grp-s1');
      expect(parsed.rows[0].session_id).toBe('space:space-int-1:task:sg-task');
    });

    it('can query session_groups scoped via session_group_members', async () => {
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-1:task:sgg-task', 'SGG Task', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-2:task:sgg-task2', 'SGG Task2', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO session_groups (id, group_type, ref_id, created_at) VALUES ('sgg-grp-1', 'task', 'ref-A', 1000)"
      );
      db.exec(
        "INSERT OR IGNORE INTO session_groups (id, group_type, ref_id, created_at) VALUES ('sgg-grp-2', 'task', 'ref-B', 2000)"
      );
      db.exec(
        "INSERT OR IGNORE INTO session_group_members (group_id, session_id, role, joined_at) VALUES ('sgg-grp-1', 'space:space-int-1:task:sgg-task', 'coder', 1000)"
      );
      db.exec(
        "INSERT OR IGNORE INTO session_group_members (group_id, session_id, role, joined_at) VALUES ('sgg-grp-2', 'space:space-int-2:task:sgg-task2', 'coder', 2000)"
      );

      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id, group_type FROM session_groups' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('sgg-grp-1');
    });

    it('db_list_tables includes sessions, sdk_messages, session_groups, session_group_members in space scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_list_tables();
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.tables).toContain('sessions');
      expect(parsed.tables).toContain('sdk_messages');
      expect(parsed.tables).toContain('session_groups');
      expect(parsed.tables).toContain('session_group_members');
      expect(parsed.tables).toContain('space_tasks');
      expect(parsed.tables).not.toContain('tasks');
      expect(parsed.tables).not.toContain('rooms');
    });

    it('db_describe_table works for sessions in space scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'sessions' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.description).toContain('sessions');
      expect(parsed.description).not.toContain('| config |');
      expect(parsed.description).not.toContain('| session_context |');
      expect(parsed.description).toContain('id');
      expect(parsed.description).toContain('title');
      expect(parsed.description).toContain('status');
    });

    it('db_describe_table works for sdk_messages in space scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_describe_table({ table_name: 'sdk_messages' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.description).toContain('sdk_messages');
      expect(parsed.description).toContain('session_id');
      expect(parsed.description).toContain('message_type');
    });

    it('COUNT aggregate on sessions in space scope counts only space sessions', async () => {
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-1:task:cnt-1', 'Count 1', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-1:task:cnt-2', 'Count 2', datetime('now'), datetime('now'), 'ended', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('space:space-int-2:task:cnt-3', 'Other', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );
      db.exec(
        "INSERT OR IGNORE INTO sessions (id, title, created_at, last_active_at, status, config, metadata) VALUES ('unrelated-session', 'Unrelated', datetime('now'), datetime('now'), 'active', '{}', '{}')"
      );

      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT COUNT(*) AS cnt FROM sessions',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows[0].cnt).toBe(2);
    });

    it('cannot access sessions from room scope (sessions not in room scope)', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM sessions' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('cannot access sdk_messages from room scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM sdk_messages' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });
  });

  describe('global scope', () => {
    it('can query all rows from rooms (no scope filter)', async () => {
      seedRooms(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id FROM rooms' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
    });

    it('can query all rows from spaces (no scope filter)', async () => {
      seedSpaces(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT id FROM spaces' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(2);
    });

    it('rooms rows do not include the blacklisted config column', async () => {
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

    it('cannot query sensitive table auth_config from global scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM auth_config' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in global scope');
    });

    it('cannot query sensitive table global_settings from global scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM global_settings' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in global scope');
    });

    it('cannot query internal table session_groups from global scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM session_groups' });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in global scope');
    });

    it('no scope filter is applied in global scope — all rooms are returned', async () => {
      seedRooms(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT COUNT(*) AS cnt FROM rooms' });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows[0].cnt).toBe(2);
    });

    it('db_list_tables shows global-scoped tables only', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_list_tables();
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.tables).toContain('rooms');
      expect(parsed.tables).toContain('spaces');
      expect(parsed.tables).toContain('sessions');
      expect(parsed.tables).toContain('skills');
      expect(parsed.tables).not.toContain('tasks');
      expect(parsed.tables).not.toContain('space_tasks');
      expect(parsed.tables).not.toContain('auth_config');
      expect(parsed.tables).not.toContain('global_settings');
    });
  });

  describe('cross-scope join prevention', () => {
    it('room scope: JOIN with space_tasks (a space-scoped table) is rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT tasks.id FROM tasks JOIN space_tasks ON tasks.id = space_tasks.id',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('room scope: JOIN with space_workflow_runs (space-scoped) is rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT * FROM goals JOIN space_workflow_runs ON goals.room_id = space_workflow_runs.space_id',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('space scope: JOIN with tasks (a room-scoped table) is rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT space_tasks.id FROM space_tasks JOIN tasks ON space_tasks.id = tasks.id',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in space scope');
    });

    it('room scope: JOIN with sensitive table auth_config is rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT * FROM tasks JOIN auth_config ON 1 = 1',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('global scope: JOIN with auth_config is rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT * FROM rooms JOIN auth_config ON 1 = 1',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in global scope');
    });
  });

  describe('CTE queries in scoped mode with full schema', () => {
    it('CTE over room-scoped table applies scope filter correctly', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: "WITH active AS (SELECT id, title FROM tasks WHERE status = 'pending') SELECT * FROM active",
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('task-int-1');
    });

    it('CTE referencing space-scoped table is rejected in room scope', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'WITH space AS (SELECT * FROM space_tasks) SELECT * FROM space',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('CTE referencing sensitive table is rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'WITH sensitive AS (SELECT * FROM auth_config) SELECT * FROM sensitive',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });

    it('CTE over room-scoped table counts only in-scope rows', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'WITH all_tasks AS (SELECT id FROM tasks) SELECT COUNT(*) AS cnt FROM all_tasks',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows[0].cnt).toBe(2);
    });

    it('multi-CTE with cross-scope table is rejected even if outer SELECT only uses safe CTE', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'WITH room_cte AS (SELECT * FROM tasks), space_cte AS (SELECT * FROM space_tasks) SELECT * FROM room_cte',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in room scope');
    });
  });

  describe('HAVING clause and subqueries in SELECT with full schema', () => {
    it('HAVING clause filters aggregated groups after scope filter is applied', async () => {
      seedTasks(db);
      db.exec(
        "INSERT OR IGNORE INTO tasks (id, room_id, title, description, status, created_at) VALUES ('task-int-4', 'room-int-1', 'Integration Task 4', '', 'pending', 4000)"
      );
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status HAVING cnt > 1',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].status).toBe('pending');
      expect(parsed.rows[0].cnt).toBe(2);
    });

    it('HAVING clause only sees in-scope rows — room-int-2 tasks excluded', async () => {
      seedTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'room', scopeValue: 'room-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT COUNT(*) AS total FROM tasks HAVING total > 0',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].total).toBe(2);
    });
  });
});
