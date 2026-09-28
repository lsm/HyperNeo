import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { Database, type SQLiteValue } from '../../../../src/storage/database';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { DaemonInventoryRepository } from '../../../../src/storage/repositories/daemon-inventory-repository';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { defineOperation } from '../../../../src/lib/operations/registry';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';

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

describe('ordinary chat inspection through the database catalog', () => {
  const caller: OperationCaller = { source: 'mcp', role: 'neo', sessionId: 'neo:root' };
  beforeEach(() => {
    session(caller.sessionId!, null, 100);
    new NeoRepository(db.getDatabase()).reserveBinding({
      sessionId: caller.sessionId!,
      concernId: null,
      kind: 'neo',
    });
  });
  function inspect(sessionId: string, options: Record<string, unknown> = {}, actor = caller) {
    return invokeOperation(
      createDatabaseOperationCatalog(db),
      'daemon.session.inspect',
      { sessionId, ...options },
      actor
    );
  }
  function history(sessionId: string, text: string, time: string) {
    const uuid = crypto.randomUUID();
    expect(
      db.getSDKMessageRepo().saveSDKMessage(sessionId, {
        type: 'assistant',
        uuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      } as SDKMessage)
    ).toBe(true);
    expect(
      db
        .getDatabase()
        .prepare('UPDATE sdk_messages SET timestamp = ? WHERE session_id = ? AND sdk_uuid = ?')
        .run(time, sessionId, uuid).changes
    ).toBe(1);
    const stored = db
      .getDatabase()
      .prepare('SELECT id FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?')
      .get(sessionId, uuid) as { id: string };
    return { uuid, id: stored.id };
  }
  function state() {
    return {
      sessions: db.getDatabase().prepare('SELECT * FROM sessions ORDER BY id').all(),
      messages: db.getDatabase().prepare('SELECT * FROM sdk_messages ORDER BY id').all(),
      jobs: db.getDatabase().prepare('SELECT * FROM job_queue ORDER BY id').all(),
    };
  }
  test.each(['/projects/a/worktrees/feature', null])(
    'reads an existing chat at %s without starting or modifying it',
    async (workspacePath) => {
      session('existing-chat', workspacePath, 200);
      db.getDatabase()
        .prepare('UPDATE sessions SET main_repo_path = ?, processing_state = ? WHERE id = ?')
        .run(
          workspacePath ? '/projects/a' : null,
          '{"status":"waiting_for_input","pendingQuestion":"SECRET-QUESTION"}',
          'existing-chat'
        );
      history('existing-chat', 'Older report', '2026-09-28T01:00:00Z');
      history(
        'existing-chat',
        'Tests are passing, awaiting user decision.',
        '2026-09-28T02:00:00Z'
      );
      const before = state();
      const result = await inspect('existing-chat');
      expect(result).toMatchObject({
        kind: 'completed',
        value: {
          accepted: true,
          capturedAt: expect.any(Number),
          resource: {
            kind: 'session',
            id: 'existing-chat',
            name: 'existing-chat',
            status: 'active',
            recordedProcessingStatus: 'waiting_for_input',
            workspacePath: workspacePath ? '/projects/a' : null,
          },
          messages: [
            { excerpt: 'Tests are passing, awaiting user decision.' },
            { excerpt: 'Older report' },
          ],
          nextBefore: null,
        },
      });
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(state()).toEqual(before);
    }
  );
  test('reuses newest-first timestamp/id cursors and existing replacement filtering', async () => {
    session('history-chat', null, 200);
    const time = '2026-09-28T02:00:00Z';
    const source = history('history-chat', 'First', time);
    history('history-chat', 'Second', time);
    const removed = history('history-chat', 'Replaced text', '2026-09-28T03:00:00Z');
    db.getDatabase()
      .prepare(
        'INSERT INTO sdk_message_replacements (source_message_id, session_id, target_uuid, kind) VALUES (?, ?, ?, ?)'
      )
      .run(source.id, 'history-chat', removed.uuid, 'superseded');
    const first = await inspect('history-chat', { limit: 1 });
    if (first.kind !== 'completed') throw new Error(first.message);
    const page = first.value as {
      messages: { id: string; cursor: string; excerpt: string }[];
      nextBefore: string | null;
    };
    expect(page.messages).toHaveLength(1);
    expect(['First', 'Second']).toContain(page.messages[0].excerpt);
    expect(page.nextBefore).toBe(page.messages[0].cursor);
    const second = await inspect('history-chat', { limit: 1, before: page.nextBefore });
    if (second.kind !== 'completed') throw new Error(second.message);
    const previous = second.value as typeof page;
    expect(previous.messages).toHaveLength(1);
    expect(previous.messages[0].id).not.toBe(page.messages[0].id);
    expect(previous.messages[0].excerpt).not.toBe('Replaced text');
    const last = await inspect('history-chat', { limit: 1, before: previous.nextBefore });
    expect(last).toMatchObject({ kind: 'completed', value: { messages: [], nextBefore: null } });
  });
  test('archive opt-in, missing references and unknown processing are distinct', async () => {
    session('archived-chat', null, 100, 'archived');
    expect(await inspect('archived-chat')).toMatchObject({
      kind: 'completed',
      value: { accepted: false, reason: 'session_archived' },
    });
    expect(await inspect('archived-chat', { includeArchived: true })).toMatchObject({
      kind: 'completed',
      value: {
        accepted: true,
        resource: { status: 'archived', recordedProcessingStatus: null },
        messages: [],
      },
    });
    expect(await inspect('missing')).toMatchObject({
      kind: 'completed',
      value: { accepted: false, reason: 'session_not_found' },
    });
    db.getDatabase()
      .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
      .run('{"status":{"nested":"SECRET"}}', 'archived-chat');
    expect(await inspect('archived-chat', { includeArchived: true })).toMatchObject({
      kind: 'completed',
      value: { resource: { recordedProcessingStatus: null } },
    });
  });
  test.each([
    { spaceId: 'space-a' },
    { taskId: 'unbound-task' },
    { roomId: 'legacy-room' },
    { lobbyId: 'legacy-lobby' },
  ])('does not tunnel through a protected execution context: %j', async (context) => {
    session('protected-chat', null, 100);
    db.getDatabase()
      .prepare('UPDATE sessions SET session_context = ? WHERE id = ?')
      .run(JSON.stringify(context), 'protected-chat');
    history('protected-chat', 'SECRET-EXECUTION', '2026-09-28T01:00:00Z');
    const before = state();
    expect(repo.readSession('protected-chat')?.scopeOwned).toBe(1);
    const result = await inspect('protected-chat');
    expect(result).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'protected_session' },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(state()).toEqual(before);
  });
  test('direct-task provenance and Neo bindings cannot masquerade as ordinary chats', async () => {
    session('direct-worker', null, 100);
    db.getDatabase()
      .prepare('INSERT INTO direct_task_session_provenance (session_id) VALUES (?)')
      .run('direct-worker');
    expect(await inspect('direct-worker')).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'protected_session' },
    });
    expect(repo.readSession(caller.sessionId!)?.neoBound).toBe(1);
    expect(await inspect(caller.sessionId!)).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'protected_session' },
    });
  });
  test('catalog discovery describes the actual primitive while unbound Neo callers cannot inspect', async () => {
    session('existing-chat', null, 100);
    const registry = createDatabaseOperationCatalog(db);
    expect(
      await invokeOperation(
        registry,
        'operations.describe',
        { name: 'daemon.session.inspect' },
        caller
      )
    ).toMatchObject({
      kind: 'completed',
      value: { found: true, inputSchema: expect.objectContaining({ type: 'object' }) },
    });
    expect(await inspect('existing-chat', {}, { ...caller, sessionId: 'not-bound' })).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'inspection_forbidden' },
    });
    expect(await inspect('existing-chat', {}, { source: 'rpc', principal: 'local' })).toMatchObject(
      { kind: 'completed', value: { accepted: true } }
    );
  });
  test('recorded workflow/long-horizon owners stay protected even without scope hints', async () => {
    session('registered-worker', null, 100);
    session('registered-agent', null, 100);
    insert('space_workflows', {
      id: 'owner-flow',
      space_id: 'space-a',
      name: 'Owner',
      instructions: '',
      created_at: 1,
      updated_at: 1,
    });
    insert('space_workflow_runs', {
      id: 'owner-run',
      space_id: 'space-a',
      workflow_id: 'owner-flow',
      title: 'Owner',
      status: 'in_progress',
      created_at: 1,
      updated_at: 1,
    });
    insert('node_executions', {
      id: 'owner-node',
      workflow_run_id: 'owner-run',
      workflow_node_id: 'node',
      agent_name: 'Agent',
      agent_session_id: 'registered-worker',
      created_at: 1,
      updated_at: 1,
    });
    insert('space_long_horizon_agents', {
      id: 'owner-agent',
      space_id: 'space-a',
      handle: 'owner',
      display_name: 'Owner',
      session_id: 'registered-agent',
      created_at: 1,
      updated_at: 1,
    });
    for (const id of ['registered-worker', 'registered-agent']) {
      expect(repo.readSession(id)?.scopeOwned).toBe(1);
      expect(await inspect(id)).toEqual({
        kind: 'completed',
        value: { accepted: false, reason: 'protected_session' },
      });
    }
  });
  test('private Neo and registered-agent parent links are not ordinary forked chats', async () => {
    session('neo-child', null, 100);
    db.getDatabase()
      .prepare('UPDATE sessions SET parent_id = ? WHERE id = ?')
      .run(caller.sessionId, 'neo-child');
    expect(await inspect('neo-child')).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'protected_session' },
    });
    session('agent-parent', null, 100);
    insert('space_long_horizon_agents', {
      id: 'parent-agent',
      space_id: 'space-a',
      handle: 'parent',
      display_name: 'Parent',
      session_id: 'agent-parent',
      created_at: 1,
      updated_at: 1,
    });
    session('agent-child', null, 100);
    db.getDatabase()
      .prepare('UPDATE sessions SET parent_id = ? WHERE id = ?')
      .run('agent-parent', 'agent-child');
    expect(await inspect('agent-child')).toEqual({
      kind: 'completed',
      value: { accepted: false, reason: 'protected_session' },
    });
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
