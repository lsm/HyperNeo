import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { Database, type SQLiteValue } from '../../../../src/storage/database';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { DaemonInventoryRepository } from '../../../../src/storage/repositories/daemon-inventory-repository';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { defineOperation } from '../../../../src/lib/operations/registry';

let db: Database;
let repo: DaemonInventoryRepository;

function insert(table: string, values: Record<string, SQLiteValue>) {
  const columns = Object.keys(values);
  db.getDatabase()
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...Object.values(values));
}

function session(id: string, workspacePath: string | null, time: number, status = 'active') {
  insert('sessions', {
    id,
    title: id,
    workspace_path: workspacePath,
    created_at: new Date(time).toISOString(),
    last_active_at: new Date(time).toISOString(),
    status,
    config: '{"systemPrompt":"SECRET-CONFIG"}',
    metadata: '{"transcript":"SECRET-TRANSCRIPT"}',
  });
}

beforeEach(async () => {
  db = new Database(':memory:', { messageSearchIndexFlushIntervalMs: 0 });
  await db.initialize(createReactiveDatabase(db));
  repo = new DaemonInventoryRepository(db.getDatabase());
  insert('spaces', {
    id: 'space-a',
    slug: 'space-a',
    name: 'Project A',
    workspace_path: '/projects/a',
    instructions: 'SECRET-INSTRUCTIONS',
    created_at: 100,
    updated_at: 100,
  });
});
afterEach(() => db.close());

describe('DaemonInventoryRepository', () => {
  test('reads project and non-project chats without loading prompts or transcripts', () => {
    session('project-chat', '/projects/a/worktrees/feature', 200);
    db.getDatabase()
      .prepare('UPDATE sessions SET main_repo_path = ? WHERE id = ?')
      .run('/projects/a', 'project-chat');
    session('family-chat', null, 100);
    const snapshot = repo.read({ limit: 20, includeArchived: false });
    const chats = snapshot.find(({ kind }) => kind === 'session')!;
    expect(chats).toMatchObject({ total: 2 });
    expect(chats.entries).toEqual([
      {
        id: 'project-chat',
        name: 'project-chat',
        status: 'active',
        updatedAt: 200,
        workspacePath: '/projects/a',
        links: [],
      },
      {
        id: 'family-chat',
        name: 'family-chat',
        status: 'active',
        updatedAt: 100,
        workspacePath: null,
        links: [],
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET');
  });

  test('projects each primitive with real persisted links and no invented scope status', () => {
    session('worker', '/projects/a', 200);
    const base = { space_id: 'space-a', created_at: 100, updated_at: 100 };
    insert('space_workflows', {
      ...base,
      id: 'workflow-a',
      name: 'Feature delivery',
      instructions: 'SECRET',
    });
    insert('space_workflow_runs', {
      ...base,
      id: 'run-a',
      workflow_id: 'workflow-a',
      title: 'Release',
      status: 'in_progress',
    });
    insert('space_goals', { ...base, id: 'goal-a', title: 'Ship feature', description: 'SECRET' });
    insert('evolution_scopes', {
      ...base,
      id: 'scope-a',
      name: 'Improve delivery',
      kind: 'project',
      objective: 'SECRET',
      space_goal_id: 'goal-a',
    });
    insert('space_long_horizon_agents', {
      ...base,
      id: 'agent-a',
      handle: 'senior-swe',
      display_name: 'Senior SWE',
      session_id: 'worker',
      instructions: 'SECRET',
    });
    insert('space_tasks', {
      ...base,
      id: 'task-a',
      task_number: 1,
      title: 'Implement feature',
      status: 'in_progress',
      workflow_run_id: 'run-a',
      task_agent_session_id: 'worker',
      goal_id: 'goal-a',
      evolution_scope_id: 'scope-a',
    });
    const pages = repo.read({ limit: 20, includeArchived: false });
    expect(pages.map(({ kind }) => kind)).toEqual([
      'session',
      'space',
      'task',
      'agent',
      'workflow',
      'workflow_run',
      'goal',
      'evolution_scope',
    ]);
    expect(pages.every(({ total, entries }) => total === 1 && entries.length === 1)).toBe(true);
    const item = (kind: string) => pages.find((page) => page.kind === kind)!.entries[0];
    expect(item('task').links).toEqual([
      { kind: 'space', id: 'space-a' },
      { kind: 'session', id: 'worker' },
      { kind: 'workflow_run', id: 'run-a' },
      { kind: 'goal', id: 'goal-a' },
      { kind: 'evolution_scope', id: 'scope-a' },
    ]);
    expect(item('agent')).toMatchObject({
      name: 'Senior SWE',
      links: [
        { kind: 'space', id: 'space-a' },
        { kind: 'session', id: 'worker' },
      ],
    });
    expect(item('workflow_run')).toMatchObject({
      status: 'in_progress',
      links: [
        { kind: 'space', id: 'space-a' },
        { kind: 'workflow', id: 'workflow-a' },
      ],
    });
    expect(item('evolution_scope')).toMatchObject({
      status: null,
      links: [
        { kind: 'space', id: 'space-a' },
        { kind: 'goal', id: 'goal-a' },
      ],
    });
    expect(JSON.stringify(pages)).not.toContain('SECRET');
  });

  test('bounds reads per kind while preserving exact counts and stable ordering', () => {
    session('b', null, 200);
    session('a', null, 200);
    session('old', null, 100);
    session('archived', null, 300, 'archived');
    const read = (includeArchived: boolean) =>
      repo.read({ limit: 2, includeArchived }).find(({ kind }) => kind === 'session')!;
    expect(read(false)).toMatchObject({ total: 3, entries: [{ id: 'a' }, { id: 'b' }] });
    expect(read(true)).toMatchObject({ total: 4, entries: [{ id: 'archived' }, { id: 'a' }] });
  });

  test('honors task archive timestamps and actual stopped/paused Space flags', () => {
    insert('space_tasks', {
      id: 'archived-task',
      title: 'Old one-off task',
      created_at: 100,
      updated_at: 100,
      archived_at: 200,
    });
    const tasks = (includeArchived: boolean) =>
      repo.read({ limit: 20, includeArchived }).find(({ kind }) => kind === 'task')!;
    expect(tasks(false)).toMatchObject({ total: 0, entries: [] });
    expect(tasks(true)).toMatchObject({ total: 1, entries: [{ id: 'archived-task' }] });
    const spaceStatus = () =>
      repo.read({ limit: 20, includeArchived: false }).find(({ kind }) => kind === 'space')!
        .entries[0].status;
    db.getDatabase().exec("UPDATE spaces SET paused = 1 WHERE id = 'space-a'");
    expect(spaceStatus()).toBe('paused');
    db.getDatabase().exec("UPDATE spaces SET stopped = 1 WHERE id = 'space-a'");
    expect(spaceStatus()).toBe('stopped');
  });

  test('reads fresh state without writes or cached snapshots', () => {
    const changes = () => db.getDatabase().prepare('SELECT total_changes() AS n').get();
    const before = changes();
    expect(
      repo.read({ limit: 20, includeArchived: false }).find(({ kind }) => kind === 'session')!.total
    ).toBe(0);
    expect(changes()).toEqual(before);
    session('new-chat', null, 200);
    const afterInsert = changes();
    expect(
      repo.read({ limit: 20, includeArchived: false }).find(({ kind }) => kind === 'session')!
        .entries[0].id
    ).toBe('new-chat');
    expect(changes()).toEqual(afterInsert);
  });

  test.each([0, -1, 51, 1.5])('rejects invalid direct-reader limits: %s', (limit) => {
    expect(() => repo.read({ limit, includeArchived: false })).toThrow('Invalid inventory limit');
  });
});

describe('daemon.snapshot catalog binding', () => {
  test('discovery does not touch a database before it is initialized', async () => {
    const unavailable = {
      getDatabase: () => {
        throw new Error('Database is not initialized');
      },
    } as unknown as Database;
    const registry = createDatabaseOperationCatalog(unavailable, db.getJobQueueRepo());
    expect(await invokeOperation(registry, 'operations.list', {}, { source: 'rpc' })).toMatchObject(
      {
        kind: 'completed',
        value: expect.arrayContaining([expect.objectContaining({ name: 'daemon.snapshot' })]),
      }
    );
  });

  test('is discoverable and invocable through the default database operation catalog', async () => {
    session('project-chat', '/projects/a', 200);
    const registry = createDatabaseOperationCatalog(db);
    const snapshot = registry.get('daemon.snapshot');
    expect(snapshot?.policy).toEqual({ safetyClass: 'read', roles: ['neo'] });
    const caller = { source: 'rpc' as const, principal: 'local' };
    const listing = await invokeOperation(registry, 'operations.list', {}, caller);
    expect(listing).toMatchObject({
      kind: 'completed',
      value: expect.arrayContaining([expect.objectContaining({ name: 'daemon.snapshot' })]),
    });
    const result = await invokeOperation(registry, 'daemon.snapshot', { limit: 1 }, caller);
    expect(result).toMatchObject({
      kind: 'completed',
      value: {
        resources: expect.arrayContaining([
          expect.objectContaining({ kind: 'session', total: 1, truncated: false }),
        ]),
        capabilities: registry.entries.map(({ name }) => name).sort(),
      },
    });
    const description = await invokeOperation(
      registry,
      'operations.describe',
      { name: 'daemon.snapshot' },
      caller
    );
    expect(description).toMatchObject({
      kind: 'completed',
      value: { found: true, inputSchema: expect.objectContaining({ type: 'object' }) },
    });
  });

  test('uses existing caller-aware discovery rather than inventing capability permissions', async () => {
    const operation = (
      name: string,
      policy: { safetyClass: 'human_only' | 'read'; roles?: readonly ['workflow_worker'] }
    ) =>
      defineOperation({
        name,
        description: name,
        inputSchema: z.object({}),
        resultSchema: z.object({}),
        policy,
        execute: async () => ({}),
      });
    const registry = createDatabaseOperationCatalog(db, undefined, {}, [
      operation('human.only', { safetyClass: 'human_only' }),
      operation('worker.only', { safetyClass: 'read', roles: ['workflow_worker'] }),
    ]);
    const result = await invokeOperation(
      registry,
      'daemon.snapshot',
      {},
      { source: 'mcp', role: 'neo', sessionId: 'caller' }
    );
    expect(result).toMatchObject({
      kind: 'completed',
      value: { capabilities: expect.arrayContaining(['daemon.snapshot', 'operations.describe']) },
    });
    if (result.kind !== 'completed') throw new Error(result.message);
    expect((result.value as { capabilities: string[] }).capabilities).not.toContain('human.only');
    expect((result.value as { capabilities: string[] }).capabilities).not.toContain('worker.only');
  });
});
