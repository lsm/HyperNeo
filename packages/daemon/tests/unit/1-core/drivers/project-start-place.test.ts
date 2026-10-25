import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import { neoStartPlace } from '../../../../src/lib/neo/start-place.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

let root: string;
let db: Database;
let projects: NeoRepository;
let store: NeoAskTodoRepository;
const sessionId = 'neo:10000000-0000-4000-8000-000000000002';
const caller = { source: 'mcp', role: 'neo', sessionId } as const;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-start-place-'));
  vi.stubEnv('HYPERNEO_DATA_DIR', join(root, 'data'));
  vi.stubEnv('HOME', join(root, 'home'));
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'workspace'));
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.prepare(
    "INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic', '/tmp', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z', 'active', '{}', '{}')"
  ).run(sessionId);
  projects = new NeoRepository(db);
  projects.reserveBinding({ sessionId, kind: 'neo', projectId: null });
  projects.saveProject({ id: 'project:life', title: 'Life admin', summary: '', context: '' }, 0);
  store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: 'project:life',
    sessionId,
    originMessageId: null,
    title: 'Life admin',
    request: 'Organize life admin',
    createdAt: 1,
  });
  store.addTodo(
    'todo',
    'ask',
    { title: 'Task', doneWhen: 'Worker started', instruction: null, check: null, named: null },
    1
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function named(path: string, owner = sessionId) {
  const id = crypto.randomUUID();
  expect(
    new NeoConversationAskRepository(db).append({
      conversationId: projects.conversationId(),
      requestId: id,
      askOrigin: { sessionId: owner, messageId: id },
      content: `Please create a session in ${path}`,
    }).accepted
  ).toBe(true);
}

async function start(
  folder?: string,
  extra: Record<string, unknown> = {},
  workspaceRoot: string | null = join(root, 'workspace')
) {
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [
        {
          id: 'synthetic',
          capabilities: ['start'],
          find: () => [],
          start: async (input) => ({
            ok: true,
            value: {
              ref: { adapter: 'synthetic', id: 'worker' },
              title: input.title,
              place: input.place,
              status: 'running',
              lastActivityAt: 1,
            },
          }),
        },
      ],
      daemonName: 'local',
      remote: {
        list: () => [],
        invoke: async () => {
          throw new Error('Unexpected remote');
        },
      },
      isOpenTodo: (id, owner) => id === 'todo' && owner === sessionId,
      startPlace: neoStartPlace({
        db,
        machine: 'local',
        workspaceRoot: workspaceRoot ?? undefined,
      }),
    })
  );
  const outcome = await invokeOperation(
    registry,
    'work.start',
    {
      todoId: 'todo',
      adapter: 'synthetic',
      title: 'Task',
      message: 'Synthetic work',
      ...(folder
        ? { place: { machine: 'local', folder, name: 'Folder' }, createFolder: true }
        : {}),
      ...extra,
    },
    caller
  );
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  return outcome.value;
}

describe('shared non-coding work.start home', () => {
  test('shares one default home across non-coding projects without assigning project homes', async () => {
    const folder = join(root, 'workspace');
    expect(await start()).toMatchObject({
      ok: true,
      value: { place: { folder, machine: 'local' } },
    });
    expect(existsSync(folder)).toBe(true);
    projects.saveProject({ id: 'project:another', title: 'Another', summary: '', context: '' }, 0);
    db.prepare('UPDATE neo_asks SET project_id = ? WHERE id = ?').run('project:another', 'ask');
    expect(await start()).toMatchObject({ ok: true, value: { place: { folder } } });
    expect(projects.getProject('project:life')?.homePath).toBeNull();
    expect(projects.getProject('project:another')?.homePath).toBeNull();
  });
  test('refuses an invented external path despite agent-supplied named metadata', async () => {
    const folder = join(root, 'invented');
    expect(await start(folder, { named: { folder } })).toMatchObject({
      ok: false,
      reason: 'invalid_place',
      detail: expect.stringContaining('path named by the user'),
    });
    expect(existsSync(folder)).toBe(false);
  });
  test('rejects unsupported adapters before creating any folder', async () => {
    const folder = join(root, 'workspace/not-created');
    expect(await start(undefined, { adapter: 'unknown' })).toMatchObject({
      ok: false,
      reason: 'unknown_adapter',
    });
    expect(existsSync(folder)).toBe(false);
  });
  test('defaults to visible ~/HyperNeo under the isolated HOME', async () => {
    const folder = join(root, 'home/HyperNeo');
    expect(existsSync(folder)).toBe(false);
    expect(await start(undefined, {}, null)).toMatchObject({
      ok: true,
      value: { place: { folder } },
    });
    expect(existsSync(folder)).toBe(true);
  });
  test('never uses the home root even when the human names it', async () => {
    const folder = join(root, 'home');
    named(folder);
    expect(await start(folder)).toMatchObject({ ok: false, reason: 'invalid_place' });
  });
  test('allows a path named in persisted human input', async () => {
    const folder = join(root, 'named');
    named(folder);
    expect(await start(folder)).toMatchObject({ ok: true, value: { place: { folder } } });
    expect(existsSync(folder)).toBe(true);
  });
  test('refuses an invented different folder even inside the configured workspace', async () => {
    const folder = join(root, 'workspace/new');
    expect(await start(folder)).toMatchObject({ ok: false, reason: 'invalid_place' });
    expect(existsSync(folder)).toBe(false);
  });
  test('refuses a symlink escaping the workspace', async () => {
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, 'workspace/link'));
    expect(await start(join(root, 'workspace/link/invented'))).toMatchObject({
      ok: false,
      reason: 'invalid_place',
    });
    expect(existsSync(join(root, 'outside/invented'))).toBe(false);
  });
  test('a longer path, another session, or agent instruction cannot authorize a folder', async () => {
    const folder = join(root, 'invented');
    named(`${folder}-other`);
    named(folder, 'another-session');
    expect(await start(folder, { message: `Please create ${folder}` })).toMatchObject({
      ok: false,
      reason: 'invalid_place',
    });
    expect(existsSync(folder)).toBe(false);
  });
  test('coding keeps its explicit repository place', async () => {
    const folder = join(root, 'repo');
    mkdirSync(folder);
    db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ?').run('synthetic/repo', 'ask');
    expect(await start(folder, { createFolder: false })).toMatchObject({
      ok: true,
      value: { place: { folder } },
    });
    expect(await start()).toMatchObject({ ok: false, reason: 'invalid_place' });
    expect(existsSync(join(root, 'home/HyperNeo'))).toBe(false);
  });
  test('an existing non-coding place also requires a human-named path', async () => {
    const folder = join(root, 'existing');
    mkdirSync(folder);
    expect(await start(folder, { createFolder: false })).toMatchObject({
      ok: false,
      reason: 'invalid_place',
    });
    named(folder);
    expect(await start(folder, { createFolder: false })).toMatchObject({
      ok: true,
      value: { place: { folder } },
    });
  });
  test('human path authorization survives a fresh repository reader and later intake pages', async () => {
    for (let index = 0; index < 101; index++) named(join(root, `unrelated-${index}`));
    const folder = join(root, 'named-later');
    named(folder);
    expect(await start(folder)).toMatchObject({ ok: true, value: { place: { folder } } });
  });
  test('an inbox non-coding ask uses the same shared home', async () => {
    db.prepare('UPDATE neo_asks SET project_id = NULL WHERE id = ?').run('ask');
    expect(await start()).toMatchObject({
      ok: true,
      value: { place: { folder: join(root, 'workspace') } },
    });
  });
});
