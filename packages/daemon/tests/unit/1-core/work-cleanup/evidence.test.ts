import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { getConfig } from '../../../../src/config.ts';
import { WorkRefSchema } from '../../../../src/lib/drivers/types.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { FamilyOperationContext } from '../../../../src/lib/rpc-handlers/family-operations/context.ts';
import { workerWorkKey } from '../../../../src/lib/work-locations.ts';
import { createWorkCleanupRuntime } from '../../../../src/lib/work-cleanup/runtime.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const DAY = 24 * 60 * 60 * 1000;
const realNow = Date.now;
let clock = 0;
const UNCOMMITTED = 'The worktree has uncommitted changes; kept.';

describe('createWorkCleanupRuntime', () => {
  const saved = { ...process.env };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-evidence-')));
  const start = Date.parse('2026-11-01T12:00:00Z');
  const evidence = (name: string) => join(root, 'work', 'evidence', name);
  const unsaved = join(root, 'worktrees', 'unsaved');
  const present = join(root, 'elsewhere', 'present');
  const db = new Database(':memory:');
  const told: string[] = [];
  let context: FamilyOperationContext;

  beforeAll(() => {
    process.env.HOME = join(root, 'home');
    process.env.HYPERNEO_DATA_DIR = root;
    process.env.CODEX_HOME = join(root, 'codex');
    process.env.HYPERNEO_TEST_OWN_PROCESSES = '1';
    process.env.NODE_ENV = 'test';
    Date.now = () => clock;
    clock = start;
    runMigrations(db, () => {});
    const todos = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    todos.openAsk({
      id: 'ask',
      sessionId: 'neo',
      projectId: null,
      originMessageId: null,
      title: 'Evidence',
      request: 'Evidence',
      createdAt: 1,
    });
    const todo = (id: string, state: 'done' | 'doing', finishedAt: number, doneWhen = 'Done') => {
      const added = todos.addTodo(
        id,
        'ask',
        { title: id, doneWhen, instruction: null, named: null, check: null },
        1
      );
      todos.updateTodo(added, { state, ...(state === 'done' ? { finishedAt } : {}) }, finishedAt);
      mkdirSync(evidence(id), { recursive: true });
    };
    todo('old-done', 'done', start - 8 * DAY);
    todo('fresh-done', 'done', start - 2 * DAY);
    todo('old-card', 'done', start - 8 * DAY);
    todo('old-live-ref', 'done', start - 8 * DAY);
    todo('live', 'doing', start, `Read ${evidence('old-live-ref')}`);
    todos.askQuestion(
      'card',
      'ask',
      {
        kind: 'reply',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        text: `See ${evidence('old-card')}/result.md`,
      },
      start
    );
    mkdirSync(evidence('stranger'), { recursive: true });
    const session = (id: string, worktree: string) =>
      db
        .prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata,worktree_path)
        VALUES (?,?,'/work','now','now','archived','{}','{}',?)`)
        .run(id, id, worktree);
    mkdirSync(present, { recursive: true });
    session('present', present);
    session('gone-new', join(root, 'removed', 'gone-new'));
    session('gone-old', join(root, 'removed', 'gone-old'));
    for (const path of [
      present,
      join(root, 'removed', 'gone-new'),
      join(root, 'removed', 'gone-old'),
    ])
      mkdirSync(evidence(workerWorkKey(path)), { recursive: true });
    mkdirSync(evidence('hn-000000000000'), { recursive: true });
    db.prepare('INSERT INTO work_cleanup_gone (key, gone_at) VALUES (?, ?), (?, ?)').run(
      workerWorkKey(present),
      start - 30 * DAY,
      workerWorkKey(join(root, 'removed', 'gone-old')),
      start - 8 * DAY
    );
    mkdirSync(unsaved, { recursive: true });
    const finished = todos.addTodo(
      'unsaved-todo',
      'ask',
      { title: 'unsaved', doneWhen: 'Done', instruction: null, named: null, check: null },
      1
    );
    sessions.create(finished.id, { verb: 'start', adapter: 'codex-desktop' });
    db.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(
      JSON.stringify({ adapter: 'codex-desktop', id: 'unsaved-worker' }),
      finished.id
    );
    todos.updateTodo(finished, { state: 'done', finishedAt: start - DAY }, start - DAY);
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.status',
        description: 'Synthetic status',
        inputSchema: z.object({ ref: WorkRefSchema }),
        resultSchema: z.unknown(),
        execute: async ({ ref }) => ({
          ok: true,
          value: {
            ref,
            title: ref.id,
            status: 'stopped',
            lastActivityAt: 1,
            place: { machine: 'fixture', folder: join(root, 'source'), name: 'Fixture' },
            execution: { directory: unsaved, machine: 'fixture' },
          },
        }),
      }),
      defineOperation({
        name: 'neo.session.archive',
        description: 'Synthetic archive',
        inputSchema: z.object({ ref: WorkRefSchema }),
        resultSchema: z.unknown(),
        execute: async () => ({
          ok: true,
          value: {
            archived: true,
            worktree: { directory: unsaved, removed: false, reason: UNCOMMITTED },
          },
        }),
      }),
    ]);
    context = {
      deps: {
        config: getConfig({ dbPath: join(root, 'database', 'daemon.db') }),
        db: { getDatabase: () => db, gateway: gatewayFor(db) },
        sessionManager: { getOperationRegistry: () => registry },
        jobProcessor: { register: () => {} },
        jobQueue: {},
      },
      workCleanupAttention: async (entry: { facts: { text: string } }) => {
        told.push(entry.facts.text);
      },
    } as unknown as FamilyOperationContext;
  });

  afterAll(() => {
    Date.now = realNow;
    db.close();
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  test('removes evidence only after its time and references allow it, and tells unsaved work once', async () => {
    const runtime = createWorkCleanupRuntime(context);
    const sweep = () => runtime.execute({}, { source: 'rpc', principal: 'local' });
    await sweep();
    expect(existsSync(evidence('old-done'))).toBe(false);
    for (const kept of ['fresh-done', 'old-card', 'old-live-ref', 'live', 'stranger'])
      expect(existsSync(evidence(kept))).toBe(true);
    expect(existsSync(evidence(workerWorkKey(present)))).toBe(true);
    expect(existsSync(evidence(workerWorkKey(join(root, 'removed', 'gone-new'))))).toBe(true);
    expect(existsSync(evidence(workerWorkKey(join(root, 'removed', 'gone-old'))))).toBe(false);
    expect(existsSync(evidence('hn-000000000000'))).toBe(true);
    expect(
      db.prepare('SELECT key FROM work_cleanup_gone WHERE key = ?').get(workerWorkKey(present))
    ).toBeNull();
    expect(told.join('\n')).not.toContain('unsaved-todo');

    clock = start + 4 * DAY;
    await sweep();
    expect(existsSync(evidence(workerWorkKey(join(root, 'removed', 'gone-new'))))).toBe(true);
    const notice = told.at(-1)!;
    expect(notice).toContain('unsaved-todo');
    expect(notice).toContain(unsaved);

    clock = start + 8 * DAY;
    await sweep();
    expect(told.at(-1)).not.toContain('unsaved-todo');
    expect(existsSync(evidence(workerWorkKey(join(root, 'removed', 'gone-new'))))).toBe(false);
    expect(existsSync(evidence('fresh-done'))).toBe(false);
    expect(existsSync(evidence('live'))).toBe(true);
    expect(existsSync(evidence('old-card'))).toBe(true);
    expect(existsSync(evidence('stranger'))).toBe(true);
    expect(existsSync(unsaved)).toBe(true);
  });
});
