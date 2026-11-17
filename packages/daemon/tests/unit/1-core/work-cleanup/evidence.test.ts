import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { getConfig } from '../../../../src/config.ts';
import { WorkRefSchema } from '../../../../src/lib/drivers/types.ts';
import { WORKTREE_IN_USE, worktreeUnverified } from '../../../../src/lib/drivers/work-placement.ts';
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
  const unverifiable = join(root, 'worktrees', 'unverifiable');
  const present = join(root, 'elsewhere', 'present');
  const restored = join(root, 'elsewhere', 'restored');
  const archivedOnly = join(root, 'removed', 'archived-only');
  const locked = join(root, 'locked');
  const db = new Database(':memory:');
  const delivered: string[] = [];
  const attempts: string[] = [];
  let deliver = true;
  let unsavedReason = UNCOMMITTED;
  let archives = 0;
  let rejectReferenced = false;
  let statusCalls = 0;
  let failStatusFrom = Number.POSITIVE_INFINITY;
  let busy: ChildProcess | undefined;
  let context: FamilyOperationContext;

  beforeAll(() => {
    process.env.HOME = root;
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
      return added;
    };
    todo('old-done', 'done', start - 8 * DAY);
    todo('fresh-done', 'done', start - 2 * DAY);
    todo('old-card', 'done', start - 8 * DAY);
    todo('old-live-ref', 'done', start - 8 * DAY);
    todo('old-option', 'done', start - 8 * DAY);
    todo('old-retire', 'done', start - 8 * DAY);
    todo('old-busy', 'done', start - 8 * DAY);
    todo('old"quote', 'done', start - 8 * DAY);
    todo('old file', 'done', start - 8 * DAY);
    todo('old-home', 'done', start - 8 * DAY);
    todo('live', 'doing', start, `Read ${evidence('old-live-ref')}`);
    todo('live-percent', 'doing', start, 'Inspect byte %FF in the dump');
    todo('old-sib', 'done', start - 8 * DAY);
    todo('old-late', 'done', start - 8 * DAY);
    todo('old-em', 'done', start - 8 * DAY);
    todo('old-strong', 'done', start - 8 * DAY);
    const rejected = todos.addTodo(
      'old-reject',
      'ask',
      { title: 'old-reject', doneWhen: 'Done', instruction: null, named: null, check: null },
      1
    );
    todos.updateTodo(rejected, { state: 'done', finishedAt: start - 8 * DAY }, start - 8 * DAY);
    const card = {
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
    };
    todos.askQuestion(
      'card',
      'ask',
      { ...card, kind: 'reply', text: `See ${evidence('old-card')}/result.md` },
      start
    );
    todos.askQuestion(
      'choice',
      'ask',
      {
        ...card,
        kind: 'choice',
        options: [`Keep ${evidence('old-option')}`, 'Drop it'],
        text: 'Which result stays?',
        retireWhen: {
          pack: 'core',
          kind: 'file',
          params: { path: join(evidence('old-retire'), 'result.md') },
        },
      },
      start
    );
    todos.askQuestion(
      'quoted',
      'ask',
      {
        ...card,
        kind: 'reply',
        text: 'Retire when the result exists.',
        retireWhen: {
          pack: 'core',
          kind: 'file',
          params: { path: join(evidence('old"quote'), 'result.md') },
        },
      },
      start
    );
    todos.askQuestion(
      'linked',
      'ask',
      {
        ...card,
        kind: 'reply',
        text: `[Result](file://${evidence('old file').replaceAll(' ', '%20')}/result.md)`,
      },
      start
    );
    todos.askQuestion(
      'home',
      'ask',
      { ...card, kind: 'reply', text: 'See ~/work/evidence/old-home/result.md' },
      start
    );
    todos.askQuestion(
      'sibling',
      'ask',
      { ...card, kind: 'reply', text: `See ${evidence('old-sib-2')}/result.md` },
      start
    );
    todos.askQuestion(
      'emphasis',
      'ask',
      {
        ...card,
        kind: 'reply',
        text: `Review _${evidence('old-em')}_ and __${evidence('old-strong')}__`,
      },
      start
    );
    mkdirSync(evidence('stranger'), { recursive: true });
    const session = (id: string, worktree: string | null, metadata = '{}') =>
      db
        .prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata,worktree_path)
        VALUES (?,?,'/work','now','now','archived','{}',?,?)`)
        .run(id, id, metadata, worktree);
    mkdirSync(present, { recursive: true });
    session('present', present);
    session('gone-new', join(root, 'removed', 'gone-new'));
    session('gone-old', join(root, 'removed', 'gone-old'));
    session('restored', restored);
    session('locked', join(locked, 'tree'));
    session(
      'archived-only',
      null,
      JSON.stringify({ archivedWorktree: { worktreePath: archivedOnly, branch: 'b' } })
    );
    for (const path of [
      present,
      join(root, 'removed', 'gone-new'),
      join(root, 'removed', 'gone-old'),
      restored,
      archivedOnly,
      join(locked, 'tree'),
    ])
      mkdirSync(evidence(workerWorkKey(path)), { recursive: true });
    mkdirSync(evidence('hn-000000000000'), { recursive: true });
    const gone = db.prepare('INSERT INTO work_cleanup_gone (key, gone_at) VALUES (?, ?)');
    gone.run(workerWorkKey(present), start - 30 * DAY);
    gone.run(workerWorkKey(join(root, 'removed', 'gone-old')), start - 8 * DAY);
    gone.run(workerWorkKey(restored), start - 8 * DAY);
    gone.run(workerWorkKey(archivedOnly), start - 8 * DAY);
    gone.run(workerWorkKey(join(locked, 'tree')), start - 8 * DAY);
    mkdirSync(join(locked, 'tree'), { recursive: true });
    chmodSync(locked, 0o000);
    const worker = (todoId: string, id: string, directory: string) => {
      mkdirSync(directory, { recursive: true });
      const finished = todos.addTodo(
        todoId,
        'ask',
        { title: todoId, doneWhen: 'Done', instruction: null, named: null, check: null },
        1
      );
      sessions.create(finished.id, { verb: 'start', adapter: 'codex-desktop' });
      db.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(
        JSON.stringify({ adapter: 'codex-desktop', id }),
        finished.id
      );
      todos.updateTodo(finished, { state: 'done', finishedAt: start - DAY }, start - DAY);
    };
    worker('unsaved-todo', 'unsaved-worker', unsaved);
    worker('unverified-todo', 'unverified-worker', unverifiable);
    const directory = (id: string) => (id === 'unsaved-worker' ? unsaved : unverifiable);
    const registry = createOperationRegistry([
      defineOperation({
        name: 'work.status',
        description: 'Synthetic status',
        inputSchema: z.object({ ref: WorkRefSchema }),
        resultSchema: z.unknown(),
        execute: async ({ ref }) =>
          ref.id === 'unsaved-worker' && ++statusCalls >= failStatusFrom
            ? { ok: false }
            : {
                ok: true,
                value: {
                  ref,
                  title: ref.id,
                  status: 'stopped',
                  lastActivityAt: 1,
                  place: { machine: 'fixture', folder: join(root, 'source'), name: 'Fixture' },
                  execution: { directory: directory(ref.id), machine: 'fixture' },
                },
              },
      }),
      defineOperation({
        name: 'neo.session.archive',
        description: 'Synthetic archive',
        inputSchema: z.object({ ref: WorkRefSchema }),
        resultSchema: z.unknown(),
        execute: async ({ ref }) => ({
          ok: (archives++, true),
          value: {
            archived: true,
            worktree: {
              directory: directory(ref.id),
              removed: false,
              reason:
                ref.id === 'unsaved-worker'
                  ? unsavedReason
                  : worktreeUnverified(new Error('git status failed')),
            },
          },
        }),
      }),
    ]);
    const real = gatewayFor(db);
    let restoredRead = false;
    let lateCard = false;
    const gateway = {
      ...real,
      call: (op: unknown, method: string, ...args: unknown[]) => {
        if (method === 'evidence' && args[0] === workerWorkKey(restored) && !restoredRead) {
          restoredRead = true;
          mkdirSync(restored, { recursive: true });
        }
        if (method === 'referenced' && rejectReferenced)
          return Promise.reject(new Error('reference read failed'));
        const result = (real.call as (...all: unknown[]) => unknown)(op, method, ...args);
        if (method !== 'referenced' || lateCard) return result;
        lateCard = true;
        return Promise.resolve(result).then((value) => {
          todos.askQuestion(
            'late',
            'ask',
            { ...card, kind: 'reply', text: `See ${evidence('old-late')}/result.md` },
            start
          );
          return value;
        });
      },
    };
    context = {
      deps: {
        config: getConfig({ dbPath: join(root, 'database', 'daemon.db') }),
        db: { getDatabase: () => db, gateway },
        sessionManager: { getOperationRegistry: () => registry },
        jobProcessor: { register: () => {} },
        jobQueue: {},
      },
      workCleanupAttention: async (entry: { facts: { text: string } }) => {
        attempts.push(entry.facts.text);
        if (!deliver) return { dropped: 'no Neo session' };
        delivered.push(entry.facts.text);
        return { told: 'digest', step: 0, uuid: 'fixture', text: entry.facts.text };
      },
    } as unknown as FamilyOperationContext;
    busy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: evidence('old-busy'),
      stdio: 'ignore',
    });
  });

  afterAll(() => {
    busy?.kill();
    chmodSync(locked, 0o755);
    Date.now = realNow;
    db.close();
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  const notices = (texts: string[], todo: string) =>
    texts.filter((text) => text.includes('Unsaved work kept') && text.includes(`todo ${todo}`));

  test('removes evidence only after its time and references allow it, and tells unsaved work once', async () => {
    const runtime = createWorkCleanupRuntime(context);
    const sweep = () => runtime.execute({}, { source: 'rpc', principal: 'local' });
    await sweep();
    expect(existsSync(evidence('old-done'))).toBe(false);
    expect(existsSync(evidence('old-sib'))).toBe(false);
    expect(existsSync(evidence('old-late'))).toBe(true);
    for (const kept of [
      'fresh-done',
      'old-card',
      'old-live-ref',
      'old-option',
      'old-retire',
      'old-busy',
      'old"quote',
      'old file',
      'old-home',
      'old-em',
      'old-strong',
      'live',
      'stranger',
    ])
      expect(existsSync(evidence(kept))).toBe(true);
    expect(existsSync(evidence(workerWorkKey(present)))).toBe(true);
    expect(existsSync(evidence(workerWorkKey(join(root, 'removed', 'gone-new'))))).toBe(true);
    expect(existsSync(evidence(workerWorkKey(join(root, 'removed', 'gone-old'))))).toBe(false);
    expect(existsSync(evidence(workerWorkKey(archivedOnly)))).toBe(false);
    expect(existsSync(evidence(workerWorkKey(restored)))).toBe(true);
    expect(existsSync(evidence(workerWorkKey(join(locked, 'tree'))))).toBe(true);
    expect(existsSync(evidence('hn-000000000000'))).toBe(true);
    const goneRow = db.prepare('SELECT key FROM work_cleanup_gone WHERE key = ?');
    expect(goneRow.get(workerWorkKey(present))).toBeNull();
    expect(goneRow.get(workerWorkKey(restored))).toBeNull();
    expect(goneRow.get(workerWorkKey(join(root, 'removed', 'gone-old')))).toBeNull();
    expect(goneRow.get(workerWorkKey(archivedOnly))).toBeNull();
    expect(attempts.join('\n')).not.toContain('Unsaved work kept');
    busy?.kill();

    clock = start + DAY;
    unsavedReason = WORKTREE_IN_USE;
    await sweep();

    clock = start + 2 * DAY;
    unsavedReason = UNCOMMITTED;
    failStatusFrom = statusCalls + 2;
    await sweep();
    failStatusFrom = Number.POSITIVE_INFINITY;

    clock = start + 3.5 * DAY;
    unsavedReason = UNCOMMITTED;
    deliver = false;
    await sweep();
    expect(notices(attempts, 'unsaved-todo')).toHaveLength(1);
    expect(notices(attempts, 'unverified-todo')).toHaveLength(1);
    expect(notices(delivered, 'unsaved-todo')).toHaveLength(0);

    clock = start + 4 * DAY;
    deliver = true;
    await sweep();
    expect(existsSync(evidence(workerWorkKey(join(root, 'removed', 'gone-new'))))).toBe(true);
    expect(notices(delivered, 'unsaved-todo')).toHaveLength(1);
    expect(notices(delivered, 'unsaved-todo')[0]).toContain(unsaved);
    expect(notices(delivered, 'unverified-todo')).toHaveLength(1);
    expect(notices(delivered, 'unverified-todo')[0]).toContain(unverifiable);

    clock = start + 6 * DAY;
    unsavedReason = WORKTREE_IN_USE;
    await sweep();
    clock = start + 8 * DAY;
    unsavedReason = UNCOMMITTED;
    await sweep();
    expect(notices(delivered, 'unsaved-todo')).toHaveLength(1);
    expect(notices(delivered, 'unverified-todo')).toHaveLength(1);
    expect(existsSync(evidence(workerWorkKey(join(root, 'removed', 'gone-new'))))).toBe(false);
    expect(existsSync(evidence('fresh-done'))).toBe(false);
    expect(existsSync(evidence('old-busy'))).toBe(false);
    for (const kept of [
      'live',
      'old-card',
      'old-option',
      'old-retire',
      'old"quote',
      'old file',
      'old-home',
      'old-em',
      'old-strong',
      'stranger',
    ])
      expect(existsSync(evidence(kept))).toBe(true);
    expect(existsSync(unsaved)).toBe(true);
    expect(existsSync(unverifiable)).toBe(true);
  });

  test('a failed reference read keeps all evidence and still sweeps worktrees', async () => {
    mkdirSync(evidence('old-reject'), { recursive: true });
    rejectReferenced = true;
    const before = archives;
    try {
      const digest = (await createWorkCleanupRuntime(context).execute(
        {},
        { source: 'rpc', principal: 'local' }
      )) as { kept: Record<string, string[]> };
      expect(digest.kept.error).toContain(evidence('old-reject'));
    } finally {
      rejectReferenced = false;
    }
    expect(existsSync(evidence('old-reject'))).toBe(true);
    expect(archives).toBeGreaterThan(before);
  });

  test('keeps evidence whose folder resolves outside the data directory', async () => {
    const other = join(root, 'linked');
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'evidence', 'old-done'), { recursive: true });
    mkdirSync(other, { recursive: true });
    symlinkSync(outside, join(other, 'work'));
    process.env.HYPERNEO_DATA_DIR = other;
    try {
      const runtime = createWorkCleanupRuntime(context);
      await runtime.execute({}, { source: 'rpc', principal: 'local' });
    } finally {
      process.env.HYPERNEO_DATA_DIR = root;
    }
    expect(existsSync(join(outside, 'evidence', 'old-done'))).toBe(true);
  });
});
