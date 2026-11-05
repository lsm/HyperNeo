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
  });

  describe('global scope', () => {
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

    it('spaces rows do not include the blacklisted config column', async () => {
      seedSpaces(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT * FROM spaces' });
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

    it('no scope filter is applied in global scope — all spaces are returned', async () => {
      seedSpaces(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_query({ sql: 'SELECT COUNT(*) AS cnt FROM spaces' });
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
      expect(parsed.tables).not.toContain('rooms');
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
    it('space scope: JOIN with skills (a global-scoped table) is rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT space_tasks.id FROM space_tasks JOIN skills ON space_tasks.id = skills.id',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in space scope');
    });

    it('space scope: JOIN with sensitive table auth_config is rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT * FROM space_tasks JOIN auth_config ON 1 = 1',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in space scope');
    });

    it('global scope: JOIN with auth_config is rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'global', scopeValue: '' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT * FROM spaces JOIN auth_config ON 1 = 1',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in global scope');
    });
  });

  describe('CTE queries in scoped mode with full schema', () => {
    it('CTE over space-scoped table applies scope filter correctly', async () => {
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: "WITH active AS (SELECT id, title FROM space_tasks WHERE status = 'open') SELECT * FROM active",
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].id).toBe('stask-int-1');
    });

    it('CTE referencing sensitive table is rejected', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'WITH sensitive AS (SELECT * FROM auth_config) SELECT * FROM sensitive',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in space scope');
    });

    it('CTE over space-scoped table counts only in-scope rows', async () => {
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'WITH all_tasks AS (SELECT id FROM space_tasks) SELECT COUNT(*) AS cnt FROM all_tasks',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows[0].cnt).toBe(2);
    });

    it('multi-CTE with cross-scope table is rejected even if outer SELECT only uses safe CTE', async () => {
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'WITH safe_cte AS (SELECT * FROM space_tasks), unsafe_cte AS (SELECT * FROM auth_config) SELECT * FROM safe_cte',
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result).raw).toContain('not accessible in space scope');
    });
  });

  describe('HAVING clause and subqueries in SELECT with full schema', () => {
    it('HAVING clause filters aggregated groups after scope filter is applied', async () => {
      seedSpaceTasks(db);
      db.exec(
        "INSERT OR IGNORE INTO space_tasks (id, space_id, task_number, title, created_at, updated_at) VALUES ('stask-int-4', 'space-int-1', 3, 'Space Task 4', 4000, 4000)"
      );
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT status, COUNT(*) AS cnt FROM space_tasks GROUP BY status HAVING cnt > 1',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].status).toBe('open');
      expect(parsed.rows[0].cnt).toBe(2);
    });

    it('HAVING clause only sees in-scope rows — space-int-2 tasks excluded', async () => {
      seedSpaceTasks(db);
      const handlers = createDbQueryToolHandlers(
        { dbPath: ':memory:', scopeType: 'space', scopeValue: 'space-int-1' },
        db
      );
      const result = await handlers.db_query({
        sql: 'SELECT COUNT(*) AS total FROM space_tasks HAVING total > 0',
      });
      const parsed = parseResult(result);

      expect(parsed.isError).toBeFalsy();
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].total).toBe(2);
    });
  });
});
