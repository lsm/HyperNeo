import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { cleanupOwnedWorktree } from '../../../../src/lib/drivers/work-placement.ts';
import { configureWorkerSandbox } from '../../../../src/lib/drivers/worker-sandbox.ts';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { prepareCodingExecution } from '../../../../src/lib/neo/packs/coding/prepare-execution.ts';
import {
  admitSessionArchive,
  NEO_TODO_RELEASE_PRINCIPAL,
} from '../../../../src/lib/neo/session-archive-operation.ts';
import { releaseNeoTodoWorkers } from '../../../../src/lib/neo/todo-release.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { WorktreeManager } from '../../../../src/lib/worktree-manager.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  readStartedWork,
  recordWorkerStarted,
} from '../../../../src/storage/repositories/work-started-sessions-worker.ts';
import { recordedWorkInvoke } from '../../helpers/recorded-work-invoke.ts';

const worker = { adapter: 'hyperneo', id: 'worker-1' };
const startedByUs = (db: Database) => readStartedWork(db, null, undefined, worker).length > 0;
const completed = (value: unknown): OperationOutcome =>
  ({ kind: 'completed', value }) as OperationOutcome;
const scratch = mkdtempSync(join(tmpdir(), 'todo-release-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  });
function pushedCheckout() {
  const root = mkdtempSync(join(scratch, 'repo-'));
  git(root, 'init', '-q', '--bare', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'work');
  const work = join(root, 'work');
  writeFileSync(join(work, 'a.txt'), 'a');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-q', '--no-gpg-sign', '-m', 'a');
  git(work, 'push', '-q', 'origin', 'HEAD');
  return work;
}

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.prepare(
    "INSERT INTO neo_conversation (singleton,id,created_at) VALUES (1,'conversation',0)"
  ).run();
  new JobQueueRepository(db).commitSubmissionReceipt('neo-turn-report:v2:cutoff', 'v2', () => 0);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  recordWorkerStarted(db, worker);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: 'm1',
    title: 'Rows',
    request: 'Build the rows',
    createdAt: 1,
  });
  const archived: unknown[] = [];
  const compacted: string[] = [];
  const events: string[] = [];
  let cacheUntil: WorkAdapter['cacheUntil'];
  let compact: WorkAdapter['compact'] = async (ref) => {
    compacted.push(ref.id);
    events.push(`compact ${ref.id}`);
    return { ok: true, value: { compacted: true } };
  };
  const notices: string[] = [];
  let archive: (caller: OperationCaller) => unknown = () => ({
    ok: true,
    value: { archived: true },
  });
  let onStatus = () => {};
  let folder = pushedCheckout();
  let next = worker;
  let onStart: ((input: Record<string, unknown>) => unknown) | undefined;
  const packs: NeoPack[] = [];
  const reuse = (mode: string) =>
    db
      .prepare(
        `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
         VALUES ('core', 'global', '', 'sessionReuse', ?, 'human', 1)
         ON CONFLICT (pack, scope_kind, scope_key, key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(JSON.stringify(mode));
  reuse('per_todo');
  const invoke = recordedWorkInvoke(sessions.inputs, async (caller, name, input) => {
    if (name === 'work.start' && onStart) return completed(await onStart(input));
    if (name === 'work.start')
      return completed({
        ok: true,
        value: {
          ref: next,
          receipt: { executionId: next.id, inputId: 'i' },
          lastActivityAt: 1,
        },
      });
    if (name === 'work.send') {
      events.push(`send ${(input.ref as typeof worker).id}`);
      return completed({
        ok: true,
        value: { delivered: true, receipt: { executionId: worker.id, inputId: 'i' } },
      });
    }
    if (name === 'neo.session.archive') {
      archived.push(input.ref);
      return completed(await archive(caller));
    }
    if (name === 'work.status') onStatus();
    if (name === 'work.status')
      return completed({
        ok: true,
        value: { ref: input.ref, execution: { directory: folder, machine: 'laptop' } },
      });
    return completed(null);
  });
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 99, perGroup: 99 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    invoke,
    workerCompact: () => ({ compact, cacheUntil }),
    packs: () => packs,
    tell: async (_ask, _todo, note) => {
      notices.push(note);
    },
    attend: async () => {},
    changed: () => {},
  });
  const add = (
    target: NeoDriverTarget,
    named: Record<string, unknown> | null = null,
    askId = 'ask',
    createdAt = 1
  ) => {
    const todo = store.addTodo(
      crypto.randomUUID(),
      askId,
      {
        approvedAt: 1,
        dependsOn: [],
        title: 'Rows',
        doneWhen: 'PR merged',
        check: null,
        instruction: 'Build the rows.',
        named,
      },
      createdAt
    );
    sessions.create(todo.id, target);
    return todo;
  };
  const finishTodo = async (todo: NeoTodo) => {
    await runner.start(todo.id);
    store.updateTodo(
      store.getTodo(todo.id)!,
      { state: 'done', finishedAt: Date.now() },
      Date.now()
    );
  };
  const refresh = (warn: (message: string, error: unknown) => void = () => {}) =>
    runner.refresh(warn);
  return {
    db,
    add,
    finishTodo,
    refresh,
    archived,
    compacted,
    events,
    start: (todoId: string) => runner.start(todoId),
    fill: () => runner.fill(),
    setCompact: (next: WorkAdapter['compact']) => {
      compact = next;
    },
    setCacheUntil: (next: WorkAdapter['cacheUntil']) => {
      cacheUntil = next;
    },
    notices,
    setArchive: (next: (caller: OperationCaller) => unknown) => {
      archive = next;
    },
    setFolder: (next: string) => {
      folder = next;
    },
    setOnStart: (next: typeof onStart) => {
      onStart = next;
    },
    packs,
    setOnStatus: (next: () => void) => {
      onStatus = next;
    },
    sessions,
    invoke,
    released: () =>
      db.prepare("SELECT todo_id FROM pack_facts WHERE pack = 'core' AND key = 'released'").all(),
    queueOn: (todoId: string) => sessions.queueOn(todoId, worker, 'Next step.'),
    folder: () => folder,
    reuse,
    startNext: (ref: typeof worker) => {
      next = ref;
      recordWorkerStarted(db, ref);
    },
    store,
  };
}

const started: NeoDriverTarget = {
  verb: 'start',
  adapter: 'hyperneo',
  place: { machine: 'laptop', name: 'repo', folder: '/repo' },
};

describe('neo todo runner refresh releases finished workers', () => {
  test('archives the worker a finished todo started, once', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      await h.refresh();
      await h.refresh();
      expect(h.archived).toEqual([worker]);
    } finally {
      h.db.close();
    }
  });

  test('keeps a reused existing session once, even when the target requested a start', async () => {
    const h = setup();
    try {
      const db = { getDatabase: () => h.db } as never;
      h.setArchive(
        (caller) =>
          admitSessionArchive(worker, caller, db, startedByUs(h.db)) ?? {
            ok: true,
            value: { archived: true },
          }
      );
      await h.finishTodo(h.add(started));
      h.db
        .prepare('DELETE FROM work_started_sessions WHERE adapter = ? AND id = ?')
        .run(worker.adapter, worker.id);
      await h.refresh();
      await h.refresh();
      expect(h.archived).toEqual([]);
      expect(
        h.db
          .prepare('SELECT 1 FROM work_started_sessions WHERE adapter = ? AND id = ?')
          .get(worker.adapter, worker.id)
      ).toBeNull();
      expect(h.released()).toHaveLength(1);
      const fact = h.db
        .prepare("SELECT value_json FROM pack_facts WHERE pack = 'core' AND key = 'released'")
        .get() as { value_json: string };
      expect(JSON.parse(fact.value_json)).toEqual({ kept: 'not_started_by_us' });
    } finally {
      h.db.close();
    }
  });

  test('does not fence an unowned session after work is sent to it', async () => {
    const h = setup();
    try {
      const db = { getDatabase: () => h.db } as never;
      h.setArchive(
        (caller) =>
          admitSessionArchive(worker, caller, db, startedByUs(h.db)) ?? {
            ok: true,
            value: { archived: true },
          }
      );
      h.db
        .prepare('DELETE FROM work_started_sessions WHERE adapter = ? AND id = ?')
        .run(worker.adapter, worker.id);
      await h.finishTodo(h.add({ verb: 'send', ref: worker }));
      await h.refresh();
      await h.refresh();
      expect(
        h.db
          .prepare('SELECT 1 FROM work_started_sessions WHERE adapter = ? AND id = ?')
          .get(worker.adapter, worker.id)
      ).toBeNull();
      expect(h.archived).toEqual([]);
      const fact = h.db
        .prepare("SELECT value_json FROM pack_facts WHERE pack = 'core' AND key = 'released'")
        .get() as { value_json: string };
      expect(JSON.parse(fact.value_json)).toEqual({ kept: 'sent_to_existing' });
    } finally {
      h.db.close();
    }
  });

  test('archives a daemon-started worker after work was sent to it', async () => {
    const h = setup();
    try {
      recordWorkerStarted(h.db, worker);
      const db = { getDatabase: () => h.db } as never;
      h.setArchive(
        (caller) =>
          admitSessionArchive(worker, caller, db, startedByUs(h.db)) ?? {
            ok: true,
            value: { archived: true },
          }
      );
      const todo = h.add({ verb: 'send', ref: worker });
      h.sessions.recordRef(todo.id, worker);
      await h.finishTodo(todo);
      await h.refresh();
      expect(h.archived).toEqual([worker]);
      expect(h.released()).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test('keeps a worker the human named', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add({ ...started, name: 'Jason' }, { session: 'Jason' }));
      await h.refresh();
      expect(h.archived).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('archives a worker only Neo named', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add({ ...started, name: 'dev-6' }));
      await h.refresh();
      expect(h.archived).toEqual([worker]);
    } finally {
      h.db.close();
    }
  });

  test('keeps a Neo-named worker the human later chose for another todo', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add({ ...started, name: 'dev-6' }));
      await h.finishTodo(h.add({ verb: 'send', ref: worker }, { session: 'dev-6' }));
      await h.refresh();
      expect(h.archived).toEqual([]);
      expect(h.released()).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });

  test('does not release a worker sent work when the archive does not succeed', async () => {
    const h = setup();
    try {
      h.setArchive(() => ({ ok: false, reason: 'busy' }));
      const todo = h.add({ verb: 'send', ref: worker });
      h.sessions.recordRef(todo.id, worker);
      await h.finishTodo(todo);
      await h.refresh();
      expect(h.archived).toEqual([worker]);
      expect(h.released()).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('keeps a worker another live todo is bound to', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      h.queueOn(h.add(started).id);
      await h.refresh();
      expect(h.archived).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('retries a refused or failing archive on the next refresh without throwing', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      h.setArchive(() => ({ ok: false, reason: 'busy', detail: 'still in a turn' }));
      await h.refresh();
      h.setArchive(() => {
        throw new Error('adapter unreachable');
      });
      await h.refresh();
      h.setArchive(() => ({ ok: true, value: { archived: true } }));
      await h.refresh();
      await h.refresh();
      expect(h.archived).toEqual([worker, worker, worker]);
    } finally {
      h.db.close();
    }
  });
});

describe('neo todo runner refresh releases removed todos and busy folders', () => {
  test('archives the worker a removed todo started', async () => {
    const h = setup();
    try {
      const todo = h.add(started);
      await h.finishTodo(todo);
      h.db.prepare("UPDATE neo_todos SET state = 'removed' WHERE id = ?").run(todo.id);
      await h.refresh();
      expect(h.archived).toEqual([worker]);
    } finally {
      h.db.close();
    }
  });

  test('keeps a folder a running process is inside and retries once it exits', async () => {
    const h = setup();
    const root = join(scratch, `linked-${crypto.randomUUID()}`);
    mkdirSync(root);
    const linked = join(root, 'worker');
    git(h.folder(), 'worktree', 'add', '-q', '--detach', linked);
    h.setFolder(linked);
    h.setArchive(async () => ({
      ok: true,
      value: { archived: true, worktree: await cleanupOwnedWorktree(linked, [root]) },
    }));
    const busy = spawn('sleep', ['60'], { cwd: linked, stdio: 'ignore' });
    try {
      await h.finishTodo(h.add(started));
      await h.refresh();
      expect(existsSync(linked)).toBe(true);
      expect(h.released()).toEqual([]);
      busy.kill();
      await new Promise((done) => busy.once('exit', done));
      await h.refresh();
      expect(existsSync(linked)).toBe(false);
      expect(h.released()).toHaveLength(1);
    } finally {
      busy.kill();
      h.db.close();
    }
  });
});

describe('neo todo runner refresh retries a worktree the archive kept', () => {
  test('records the release only once the kept worktree is removed', async () => {
    const h = setup();
    let kept = true;
    h.setArchive(() => ({
      ok: true,
      value: {
        archived: kept,
        worktree: kept
          ? {
              directory: h.folder(),
              removed: false,
              reason: 'Could not verify or remove the worktree; kept: synthetic failure',
            }
          : { directory: h.folder(), removed: true },
      },
    }));
    try {
      await h.finishTodo(h.add(started));
      await h.refresh();
      expect(h.released()).toEqual([]);
      kept = false;
      await h.refresh();
      expect(h.released()).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });
});

describe('neo todo runner refresh retries a folder whose process check failed', () => {
  test.skipIf(process.platform === 'linux')(
    'keeps the folder and leaves the worker releasable when lsof fails',
    async () => {
      const h = setup();
      const root = join(scratch, `probe-${crypto.randomUUID()}`);
      const bin = join(scratch, `bin-${crypto.randomUUID()}`);
      mkdirSync(root);
      mkdirSync(bin);
      writeFileSync(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const linked = join(root, 'worker');
      git(h.folder(), 'worktree', 'add', '-q', '--detach', linked);
      h.setFolder(linked);
      h.setArchive(async () => ({
        ok: true,
        value: { archived: true, worktree: await cleanupOwnedWorktree(linked, [root]) },
      }));
      const path = process.env.PATH;
      try {
        await h.finishTodo(h.add(started));
        process.env.PATH = `${bin}:${path}`;
        await h.refresh();
        expect(existsSync(linked)).toBe(true);
        expect(h.released()).toEqual([]);
        process.env.PATH = path;
        await h.refresh();
        expect(existsSync(linked)).toBe(false);
        expect(h.released()).toHaveLength(1);
      } finally {
        process.env.PATH = path;
        h.db.close();
      }
    }
  );
});

describe('neo todo runner refresh on Linux', () => {
  test.skipIf(process.platform !== 'linux')(
    'finds a process inside the folder without lsof and removes it once the process exits',
    async () => {
      const h = setup();
      const root = join(scratch, `nolsof-${crypto.randomUUID()}`);
      const bin = join(scratch, `bin-${crypto.randomUUID()}`);
      mkdirSync(root);
      mkdirSync(bin);
      writeFileSync(join(bin, 'lsof'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
      const linked = join(root, 'worker');
      git(h.folder(), 'worktree', 'add', '-q', '--detach', linked);
      h.setFolder(linked);
      h.setArchive(async () => ({
        ok: true,
        value: { archived: true, worktree: await cleanupOwnedWorktree(linked, [root]) },
      }));
      const busy = spawn('sleep', ['60'], { cwd: linked, stdio: 'ignore' });
      const path = process.env.PATH;
      try {
        await h.finishTodo(h.add(started));
        process.env.PATH = `${bin}:${path}`;
        await h.refresh();
        expect(existsSync(linked)).toBe(true);
        expect(h.released()).toEqual([]);
        busy.kill();
        await new Promise((done) => busy.once('exit', done));
        await h.refresh();
        expect(existsSync(linked)).toBe(false);
        expect(h.released()).toHaveLength(1);
      } finally {
        process.env.PATH = path;
        busy.kill();
        h.db.close();
      }
    }
  );
});

describe('neo todo runner refresh keeps workers with unsaved work', () => {
  test('records an unowned worker with a dirty folder on the first refresh', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      h.db
        .prepare('DELETE FROM work_started_sessions WHERE adapter = ? AND id = ?')
        .run(worker.adapter, worker.id);
      writeFileSync(join(h.folder(), 'draft.txt'), 'draft');
      await h.refresh();
      const fact = h.db
        .prepare("SELECT value_json FROM pack_facts WHERE pack = 'core' AND key = 'released'")
        .get() as { value_json: string };
      expect(JSON.parse(fact.value_json)).toEqual({ kept: 'not_started_by_us' });
      expect(h.archived).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('logs an unchanged pending reason only once', async () => {
    const h = setup();
    const warnings: unknown[] = [];
    try {
      await h.finishTodo(h.add(started));
      writeFileSync(join(h.folder(), 'draft.txt'), 'draft');
      const warn = (message: string, error: unknown) => {
        if (message.includes('worker archive pending')) warnings.push(error);
      };
      await h.refresh(warn);
      await h.refresh(warn);
      expect(warnings).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test('logs a pending archive reason once when its details change', async () => {
    const h = setup();
    const warnings: unknown[] = [];
    let detail = 1;
    try {
      await h.finishTodo(h.add(started));
      h.setArchive(() => ({ ok: false, reason: 'busy', detail }));
      const warn = (message: string, error: unknown) => {
        if (message.includes('worker archive pending')) warnings.push(error);
      };
      await h.refresh(warn);
      detail = 2;
      await h.refresh(warn);
      expect(warnings).toHaveLength(1);
      h.setArchive(() => {
        throw new Error('archive unavailable');
      });
      await h.refresh(warn);
      expect(warnings).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });

  test('wakes Neo once after a worker remains pending for 24 hours', async () => {
    const h = setup();
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(now);
    try {
      const todo = h.add(started);
      await h.finishTodo(todo);
      writeFileSync(join(h.folder(), 'draft.txt'), 'draft');
      await h.refresh();
      clock.mockReturnValue(now + 24 * 60 * 60 * 1000);
      await h.refresh();
      await h.refresh();
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain(todo.id);
      expect(h.notices[0]).toContain(worker.id);
      expect(h.notices[0]).toContain('uncommitted changes');
    } finally {
      clock.mockRestore();
      h.db.close();
    }
  });

  test('keeps a worker with uncommitted changes until they are pushed', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      writeFileSync(join(h.folder(), 'draft.txt'), 'draft');
      await h.refresh();
      expect(h.archived).toEqual([]);
      rmSync(join(h.folder(), 'draft.txt'));
      await h.refresh();
      expect(h.archived).toEqual([worker]);
    } finally {
      h.db.close();
    }
  });

  test('keeps a worker with unpushed commits', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      writeFileSync(join(h.folder(), 'b.txt'), 'b');
      git(h.folder(), 'add', 'b.txt');
      git(h.folder(), 'commit', '-q', '--no-gpg-sign', '-m', 'b');
      await h.refresh();
      expect(h.archived).toEqual([]);
      git(h.folder(), 'push', '-q', 'origin', 'HEAD');
      await h.refresh();
      expect(h.archived).toEqual([worker]);
    } finally {
      h.db.close();
    }
  });

  test('keeps a worker whose detached HEAD has commits no remote branch holds', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      git(h.folder(), 'checkout', '-q', '--detach');
      writeFileSync(join(h.folder(), 'c.txt'), 'c');
      git(h.folder(), 'add', 'c.txt');
      git(h.folder(), 'commit', '-q', '--no-gpg-sign', '-m', 'c');
      await h.refresh();
      expect(h.archived).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('keeps a worker whose folder cannot be found', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      rmSync(h.folder(), { recursive: true, force: true });
      await h.refresh();
      expect(h.archived).toEqual([]);
    } finally {
      h.db.close();
    }
  });
});

describe('neo todo runner refresh follows the session reuse setting', () => {
  const kept = (h: ReturnType<typeof setup>) =>
    h.db
      .prepare("SELECT value_json FROM pack_facts WHERE pack = 'core' AND key = 'release_kept'")
      .all()
      .map((row) => JSON.parse((row as { value_json: string }).value_json));

  test('archives the worker under per_todo', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      await h.refresh();
      expect(h.archived).toEqual([worker]);
      expect(kept(h)).toEqual([]);
      expect(h.compacted).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('keeps the worker under per_ask while its ask is open and releases it once settled', async () => {
    const h = setup();
    try {
      h.reuse('per_ask');
      await h.finishTodo(h.add(started));
      await h.refresh();
      expect(h.archived).toEqual([]);
      expect(h.released()).toEqual([]);
      expect(kept(h)).toEqual([{ kept: 'kept_for_reuse' }]);
      h.store.settleAsk(h.store.getAsk('ask')!, 'done', 'Rows built.', Date.now());
      await h.refresh();
      expect(h.archived).toEqual([worker]);
      expect(h.released()).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test('keeps a warm worker without compacting it before its next todo', async () => {
    const h = setup();
    try {
      h.reuse('long_lived');
      h.setCacheUntil(async () => Date.now() + 60_000);
      await h.finishTodo(h.add(started));
      await h.refresh();
      expect(h.compacted).toEqual([]);
      expect(h.archived).toEqual([]);
      expect(kept(h)).toEqual([{ kept: 'kept_for_reuse' }]);
    } finally {
      h.db.close();
    }
  });

  test('releases a long_lived worker once its ask is settled', async () => {
    const h = setup();
    try {
      h.reuse('long_lived');
      await h.finishTodo(h.add(started));
      h.store.settleAsk(h.store.getAsk('ask')!, 'done', 'Rows built.', Date.now());
      await h.refresh();
      expect(h.archived).toEqual([worker]);
    } finally {
      h.db.close();
    }
  });

  test('compacts the worker of the same ask before sending its next todo', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      const next = h.add({ verb: 'send', ref: worker });
      await h.start(next.id);
      expect(h.events).toEqual([`compact ${worker.id}`, `send ${worker.id}`]);
      expect(h.sessions.readRef(next.id)).toEqual(worker);
    } finally {
      h.db.close();
    }
  });

  test.each([
    [
      'refused',
      async () => ({ ok: false as const, reason: 'busy' as const, detail: 'Synthetic refusal' }),
    ],
    [
      'failing',
      async () => {
        throw new Error('Synthetic failure');
      },
    ],
  ])('starts a fresh worker after a %s compaction', async (_name, compact) => {
    const h = setup();
    try {
      h.setCompact(compact);
      await h.finishTodo(h.add(started));
      recordWorkerStarted(h.db, worker, {
        startedBy: 'neo',
        machine: 'laptop',
        folder: h.folder(),
        harness: worker.adapter,
        provider: 'synthetic-provider',
        model: 'synthetic-model',
        effort: 'high',
      });
      const fresh = { adapter: 'hyperneo', id: 'fresh' };
      let startInput: Record<string, unknown> | undefined;
      h.setOnStart((input) => {
        startInput = input;
        return {
          ok: true,
          value: { ref: fresh, receipt: { executionId: fresh.id, inputId: 'i' } },
        };
      });
      const next = h.add({ verb: 'send', ref: worker });
      await h.start(next.id);
      expect(h.events).toEqual([]);
      expect(h.sessions.readRef(next.id)).toEqual(fresh);
      expect(startInput?.excludeRefs).toContainEqual(worker);
      expect(startInput).toMatchObject({
        provider: 'synthetic-provider',
        model: 'synthetic-model',
        effort: 'high',
      });
    } finally {
      h.db.close();
    }
  });

  test('does not send a todo that was removed while its worker compacted', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      const next = h.add({ verb: 'send', ref: worker });
      h.setCompact(async () => {
        h.store.updateTodo(h.store.getTodo(next.id)!, { state: 'removed' }, Date.now());
        return { ok: true, value: { compacted: true } };
      });
      await h.start(next.id);
      expect(h.events).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('starts other queued todos while a worker compacts and sends to it only once', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      let finish = () => {};
      const gate = new Promise<void>((resolve) => (finish = resolve));
      h.setCompact(async () => {
        h.events.push('compacting');
        await gate;
        return { ok: true, value: { compacted: true } };
      });
      h.setOnStart(() => {
        h.events.push('start other');
        return {
          ok: true,
          value: {
            ref: { adapter: 'hyperneo', id: 'worker-2' },
            receipt: { executionId: 'worker-2', inputId: 'i' },
            lastActivityAt: 1,
          },
        };
      });
      const first = h.add({ verb: 'send', ref: worker }, null, 'ask', 2);
      const other = h.add(started, null, 'ask', 3);
      const second = h.add({ verb: 'send', ref: worker }, null, 'ask', 4);
      await h.fill();
      await h.fill();
      expect(h.events).toEqual(['compacting', 'start other']);
      expect(h.sessions.readRef(other.id)?.id).toBe('worker-2');
      expect(h.store.getTodo(first.id)?.state).toBe('doing');
      expect(h.store.getTodo(second.id)?.state).toBe('todo');
      finish();
      while (!h.sessions.readRef(first.id)) await new Promise((done) => setTimeout(done, 1));
      expect(h.events).toEqual(['compacting', 'start other', `send ${worker.id}`]);
    } finally {
      h.db.close();
    }
  });

  test('leaves a todo removed while its start was refused as removed', async () => {
    const h = setup();
    try {
      const next = h.add(started);
      h.setOnStart(() => {
        h.store.updateTodo(h.store.getTodo(next.id)!, { state: 'removed' }, Date.now());
        return { ok: false, reason: 'todo_required', detail: 'closed', notSent: true };
      });
      expect(await h.start(next.id)).toMatchObject({ ok: true, todo: { state: 'removed' } });
      expect(h.notices).toEqual([]);
      expect(h.store.getTodo(next.id)?.state).toBe('removed');
    } finally {
      h.db.close();
    }
  });

  test('sends to a session the human named without compacting it', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      const named = h.add({ verb: 'send', ref: worker }, { session: worker.id });
      await h.start(named.id);
      h.store.updateTodo(
        h.store.getTodo(named.id)!,
        { state: 'done', finishedAt: Date.now() },
        Date.now()
      );
      expect(h.events).toEqual([`send ${worker.id}`]);
    } finally {
      h.db.close();
    }
  });

  test('starts fresh for a worker from another ask', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      recordWorkerStarted(h.db, worker, {
        startedBy: 'neo',
        machine: 'laptop',
        folder: h.folder(),
        harness: worker.adapter,
      });
      h.store.openAsk({
        id: 'other',
        projectId: null,
        sessionId: 'neo',
        originMessageId: 'm2',
        title: 'Other',
        request: 'Other work',
        createdAt: 2,
      });
      const fresh = { adapter: 'hyperneo', id: 'fresh' };
      h.setOnStart(() => ({
        ok: true,
        value: { ref: fresh, receipt: { executionId: 'fresh', inputId: 'i' } },
      }));
      const other = h.add({ verb: 'send', ref: worker }, null, 'other');
      await h.start(other.id);
      expect(h.events).toEqual([]);
      expect(h.sessions.readRef(other.id)).toEqual(fresh);
    } finally {
      h.db.close();
    }
  });

  test('starts fresh for a released worker', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      recordWorkerStarted(h.db, worker, {
        startedBy: 'neo',
        machine: 'laptop',
        folder: h.folder(),
        harness: worker.adapter,
      });
      h.db
        .prepare('UPDATE work_started_sessions SET released_at = ? WHERE adapter = ? AND id = ?')
        .run(Date.now(), worker.adapter, worker.id);
      const fresh = { adapter: 'hyperneo', id: 'fresh' };
      h.setOnStart(() => ({
        ok: true,
        value: { ref: fresh, receipt: { executionId: 'fresh', inputId: 'i' } },
      }));
      const next = h.add({ verb: 'send', ref: worker });
      await h.start(next.id);
      expect(h.events).toEqual([]);
      expect(h.sessions.readRef(next.id)).toEqual(fresh);
    } finally {
      h.db.close();
    }
  });

  test('clears the old worker wait reason when starting a replacement', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      recordWorkerStarted(h.db, worker, {
        startedBy: 'neo',
        machine: 'laptop',
        folder: h.folder(),
        harness: worker.adapter,
      });
      h.setCompact(undefined);
      const fresh = { adapter: 'hyperneo', id: 'fresh' };
      h.setOnStart(() => ({
        ok: true,
        value: { ref: fresh, receipt: { executionId: 'fresh', inputId: 'i' } },
      }));
      const next = h.add({ verb: 'send', ref: worker });
      h.store.updateTodo(next, { reason: 'Waiting for worker hyperneo:worker-1.' }, Date.now());
      await h.start(next.id);
      expect(h.sessions.readRef(next.id)).toEqual(fresh);
      expect(h.store.getTodo(next.id)).toMatchObject({ state: 'doing', reason: null });
    } finally {
      h.db.close();
    }
  });

  test.each(['doing', 'blocked'] as const)(
    'starts fresh when the worker holds another %s todo',
    async (state) => {
      const h = setup();
      try {
        await h.finishTodo(h.add(started));
        recordWorkerStarted(h.db, worker, {
          startedBy: 'neo',
          machine: 'laptop',
          folder: h.folder(),
          harness: worker.adapter,
        });
        const holding = h.add(started);
        h.sessions.recordRef(holding.id, worker);
        h.store.updateTodo(holding, { state, startedAt: Date.now() }, Date.now());
        const fresh = { adapter: 'hyperneo', id: 'fresh' };
        h.setOnStart(() => ({
          ok: true,
          value: { ref: fresh, receipt: { executionId: 'fresh', inputId: 'i' } },
        }));
        const next = h.add({ verb: 'send', ref: worker });
        await h.start(next.id);
        expect(h.events).toEqual([]);
        expect(h.sessions.readRef(next.id)).toEqual(fresh);
      } finally {
        h.db.close();
      }
    }
  );

  test('blocks instead of starting unsandboxed when a prepared worker cannot be compacted', async () => {
    const h = setup();
    try {
      configureWorkerSandbox(() => 'off');
      await h.finishTodo(h.add(started));
      recordWorkerStarted(h.db, worker, {
        startedBy: 'neo',
        machine: 'laptop',
        folder: h.folder(),
        harness: worker.adapter,
        preparation: { pack: 'coding', sandbox: true, parameters: {} },
      });
      h.setCompact(undefined);
      let starts = 0;
      h.setOnStart(() => {
        starts++;
        return { ok: false, reason: 'not_delivered', detail: 'unexpected' };
      });
      const next = h.add({
        verb: 'send',
        ref: worker,
        preparationParameters: { target: 'dev' },
        sandbox: true,
      } as NeoDriverTarget);
      await h.start(next.id);
      expect(h.events).toEqual([]);
      expect(starts).toBe(0);
      expect(h.store.getTodo(next.id)?.state).toBe('blocked');
      expect(h.store.getTodo(next.id)?.blockedReason).toContain('sandbox');
    } finally {
      configureWorkerSandbox(() => 'off');
      h.db.close();
    }
  });

  test('keeps a replacement sandboxed when the setting permits it', async () => {
    const h = setup();
    try {
      configureWorkerSandbox(() => 'on-demand');
      await h.finishTodo(h.add(started));
      recordWorkerStarted(h.db, worker, {
        startedBy: 'neo',
        machine: 'laptop',
        folder: h.folder(),
        harness: worker.adapter,
        preparation: { pack: 'coding', sandbox: true, parameters: {} },
      });
      h.packs.push({
        id: 'coding',
        describe: 'coding',
        instructions: () => null,
        prepareExecution: async () => ({ ok: false, reason: 'unused' }),
      });
      h.setCompact(undefined);
      let preparation: unknown;
      const fresh = { adapter: 'hyperneo', id: 'fresh' };
      h.setOnStart((input) => {
        preparation = input.preparation;
        return { ok: true, value: { ref: fresh, receipt: { executionId: 'fresh', inputId: 'i' } } };
      });
      const parameters = { target: 'dev' };
      const next = h.add({
        verb: 'send',
        ref: worker,
        preparationParameters: parameters,
      } as NeoDriverTarget);
      h.store.updateTodo(next, { check: { pack: 'coding', kind: 'pr', params: {} } }, Date.now());
      await h.start(next.id);
      expect(h.events).toEqual([]);
      expect(h.sessions.readRef(next.id)).toEqual(fresh);
      expect(preparation).toEqual({ pack: 'coding', parameters, sandbox: true });
    } finally {
      configureWorkerSandbox(() => 'off');
      h.db.close();
    }
  });

  test('blocks a prepared replacement without checkout parameters', async () => {
    const h = setup();
    try {
      configureWorkerSandbox(() => 'on-demand');
      await h.finishTodo(h.add(started));
      recordWorkerStarted(h.db, worker, {
        startedBy: 'neo',
        machine: 'laptop',
        folder: h.folder(),
        harness: worker.adapter,
        preparation: { pack: 'coding', sandbox: true, parameters: {} },
      });
      h.packs.push({
        id: 'coding',
        describe: 'coding',
        instructions: () => null,
        prepareExecution: prepareCodingExecution,
      });
      h.setCompact(undefined);
      let starts = 0;
      h.setOnStart(() => {
        starts++;
        return { ok: false, reason: 'not_delivered', detail: 'unexpected' };
      });
      const next = h.add({ verb: 'send', ref: worker });
      h.store.updateTodo(next, { check: { pack: 'coding', kind: 'pr', params: {} } }, Date.now());
      await h.start(next.id);
      expect(h.events).toEqual([]);
      expect(starts).toBe(0);
      expect(h.store.getTodo(next.id)?.state).toBe('blocked');
    } finally {
      configureWorkerSandbox(() => 'off');
      h.db.close();
    }
  });

  test.each(['pinned', 'moved', 'missing-prerequisite'] as const)(
    'a queued %s review prepares only its pinned checkout',
    async (scenario) => {
      const h = setup();
      let cleanup: (() => Promise<void>) | undefined;
      try {
        configureWorkerSandbox(() => 'on-demand');
        await h.finishTodo(h.add(started));
        recordWorkerStarted(h.db, worker, {
          startedBy: 'neo',
          machine: 'laptop',
          folder: h.folder(),
          harness: worker.adapter,
          preparation: { pack: 'coding', sandbox: true, parameters: {} },
        });
        h.setCompact(undefined);
        const head = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: h.folder(),
          encoding: 'utf8',
        }).trim();
        git(h.folder(), 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
        const parameters = {
          pullRequest: 7,
          head: scenario === 'moved' ? 'f'.repeat(40) : head,
          role: 'review',
          prerequisiteCommits: [scenario === 'missing-prerequisite' ? '0'.repeat(40) : head],
        };
        h.packs.push({
          id: 'coding',
          describe: 'coding',
          instructions: () => null,
          prepareExecution: prepareCodingExecution,
        });
        let opened = false;
        let checkoutHead: string | null = null;
        h.setOnStart(async (input) => {
          const preparation = input.preparation as { parameters: Record<string, unknown> };
          const destination = join(scratch, crypto.randomUUID());
          const result = await prepareCodingExecution(
            { directory: h.folder(), destination, parameters: preparation.parameters },
            {
              run: async (command, cwd) => {
                const child = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8' });
                return {
                  code: child.status ?? 1,
                  stdout: child.stdout ?? '',
                  stderr: child.stderr ?? '',
                };
              },
            }
          );
          if (!result.ok) return { ok: false, reason: 'not_delivered', detail: result.reason };
          cleanup = result.value.release;
          checkoutHead = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: result.value.directory,
            encoding: 'utf8',
          }).trim();
          opened = true;
          return {
            ok: true,
            value: {
              ref: { adapter: 'hyperneo', id: 'fresh' },
              receipt: { executionId: 'fresh', inputId: 'i' },
            },
          };
        });
        const next = h.add({
          verb: 'start',
          adapter: 'hyperneo',
          preparationParameters: parameters,
          sandbox: true,
        });
        h.store.updateTodo(next, { check: { pack: 'coding', kind: 'pr', params: {} } }, Date.now());
        h.queueOn(next.id);
        await h.start(next.id);
        expect(h.events).toEqual([]);
        expect(opened).toBe(scenario === 'pinned');
        if (scenario === 'pinned') expect(String(checkoutHead)).toBe(head);
        else expect(h.store.getTodo(next.id)?.state).toBe('blocked');
      } finally {
        if (cleanup) await cleanup();
        configureWorkerSandbox(() => 'off');
        h.db.close();
      }
    }
  );

  test('releases a kept worker whose prompt cache went cold', async () => {
    const h = setup();
    try {
      h.reuse('long_lived');
      h.setCacheUntil(async () => Date.now() - 60 * 60_000);
      await h.finishTodo(h.add(started));
      await h.refresh();
      expect(h.compacted).toEqual([]);
      expect(h.archived).toEqual([worker]);
      expect(h.released()).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test('keeps a per_ask worker of an open ask after its prompt cache went cold', async () => {
    const h = setup();
    try {
      h.reuse('per_ask');
      h.setCacheUntil(async () => Date.now() - 60 * 60_000);
      await h.finishTodo(h.add(started));
      await h.refresh();
      expect(h.archived).toEqual([]);
      expect(kept(h)).toEqual([{ kept: 'kept_for_reuse' }]);
    } finally {
      h.db.close();
    }
  });

  test('uses a one-hour cache window when the adapter cannot report one', async () => {
    const h = setup();
    try {
      h.reuse('long_lived');
      h.setCacheUntil(async () => null);
      await h.finishTodo(h.add(started));
      await releaseNeoTodoWorkers(
        h.sessions,
        h.invoke,
        () => {},
        Date.now() + 59 * 60_000,
        undefined,
        () => ({
          compact: async () => ({ ok: true, value: { compacted: false } }),
          cacheUntil: async () => null,
        })
      );
      expect(h.archived).toEqual([]);
      await releaseNeoTodoWorkers(
        h.sessions,
        h.invoke,
        () => {},
        Date.now() + 61 * 60_000,
        undefined,
        () => ({
          compact: async () => ({ ok: true, value: { compacted: false } }),
          cacheUntil: async () => null,
        })
      );
      expect(h.archived).toEqual([worker]);
    } finally {
      h.db.close();
    }
  });

  test('releases workers whose adapter cannot compact', async () => {
    const h = setup();
    try {
      h.reuse('long_lived');
      h.setCompact(undefined);
      await h.finishTodo(h.add(started));
      await h.refresh();
      expect(h.archived).toEqual([worker]);
      expect(kept(h)).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('skips a worker claimed during the release sweep', async () => {
    const h = setup();
    try {
      h.reuse('long_lived');
      await h.finishTodo(h.add(started));
      h.setOnStatus(() => {
        h.setOnStatus(() => {});
        h.sessions.recordRef(h.add(started).id, worker);
      });
      await h.refresh();
      expect(h.compacted).toEqual([]);
      expect(h.archived).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('releases a per_ask worker whose target has no place', async () => {
    const h = setup();
    try {
      h.reuse('per_ask');
      await h.finishTodo(h.add({ verb: 'start', adapter: 'hyperneo' }));
      await h.refresh();
      expect(h.archived).toEqual([worker]);
      expect(kept(h)).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('releases a long_lived worker whose target has no place', async () => {
    const h = setup();
    try {
      h.reuse('long_lived');
      await h.finishTodo(h.add({ verb: 'start', adapter: 'hyperneo' }));
      await h.refresh();
      expect(h.archived).toEqual([worker]);
      expect(kept(h)).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('still holds a dirty folder as pending under long_lived', async () => {
    const h = setup();
    try {
      h.reuse('long_lived');
      await h.finishTodo(h.add(started));
      writeFileSync(join(h.folder(), 'draft.txt'), 'draft');
      await h.refresh();
      const pending = h.db
        .prepare(
          "SELECT value_json FROM pack_facts WHERE pack = 'core' AND key = 'release_pending'"
        )
        .get() as { value_json: string };
      expect(JSON.parse(pending.value_json)).toMatchObject({ code: 'dirty' });
      expect(kept(h)).toEqual([]);
      expect(h.archived).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('still keeps a worker the human named under long_lived', async () => {
    const h = setup();
    try {
      h.reuse('long_lived');
      await h.finishTodo(h.add({ ...started, name: 'Jason' }, { session: 'Jason' }));
      await h.refresh();
      const fact = h.db
        .prepare("SELECT value_json FROM pack_facts WHERE pack = 'core' AND key = 'released'")
        .get() as { value_json: string };
      expect(JSON.parse(fact.value_json)).toEqual({ kept: 'named_by_human' });
      expect(kept(h)).toEqual([]);
    } finally {
      h.db.close();
    }
  });
});

describe('releaseNeoTodoWorkers', () => {
  test('continues with other workers when recording one keep fails', async () => {
    const h = setup();
    try {
      const first = h.add({ ...started, name: 'Jason' }, { session: 'Jason' });
      const second = h.add({ ...started, name: 'Jason' }, { session: 'Jason' });
      await h.finishTodo(first);
      await h.finishTodo(second);
      h.db.run(`CREATE TRIGGER fail_one_release BEFORE INSERT ON pack_facts
        WHEN NEW.todo_id = '${first.id}' AND NEW.key = 'released'
        BEGIN SELECT RAISE(FAIL, 'synthetic write failure'); END`);
      const warnings: unknown[] = [];
      await releaseNeoTodoWorkers(h.sessions, h.invoke, (_message, error) => warnings.push(error));
      expect(h.released()).toEqual([{ todo_id: second.id }]);
      expect(warnings).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test('continues with other workers when recording one pending reason fails', async () => {
    const h = setup();
    try {
      const first = h.add(started);
      const second = h.add(started);
      await h.finishTodo(first);
      await h.finishTodo(second);
      writeFileSync(join(h.folder(), 'draft.txt'), 'draft');
      h.db.run(`CREATE TRIGGER fail_one_pending BEFORE INSERT ON pack_facts
        WHEN NEW.todo_id = '${first.id}' AND NEW.key = 'release_pending'
        BEGIN SELECT RAISE(FAIL, 'synthetic write failure'); END`);
      await releaseNeoTodoWorkers(h.sessions, h.invoke, () => {});
      const rows = h.db
        .prepare("SELECT todo_id FROM pack_facts WHERE pack = 'core' AND key = 'release_pending'")
        .all();
      expect(rows).toEqual([{ todo_id: second.id }]);
    } finally {
      h.db.close();
    }
  });

  test('keeps a worker another todo queues onto while the folder is checked', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      const next = h.add(started);
      const db = { getDatabase: () => h.db } as never;
      h.setOnStatus(() => h.queueOn(next.id));
      h.setArchive(
        (caller) =>
          admitSessionArchive(worker, caller, db, startedByUs(h.db)) ?? {
            ok: true,
            value: { archived: true },
          }
      );
      await releaseNeoTodoWorkers(h.sessions, h.invoke, () => {});
      expect(h.archived).toEqual([]);
      expect(h.released()).toHaveLength(0);
    } finally {
      h.db.close();
    }
  });
});

describe('neo todo runner refresh settles shared and local-only work', () => {
  test('releases a reused worker after its live follow-up finishes', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      const followUp = h.add({ verb: 'send', ref: worker });
      h.queueOn(followUp.id);
      await h.refresh();
      expect(h.archived).toEqual([]);
      expect(h.released()).toHaveLength(0);
      await h.finishTodo(followUp);
      await h.refresh();
      expect(h.archived).toContainEqual(worker);
      expect(h.released()).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });

  test('records a second finished todo on a worker the first already released', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      await h.finishTodo(h.add(started));
      h.setArchive(() => {
        rmSync(h.folder(), { recursive: true, force: true });
        return { ok: true, value: { archived: true } };
      });
      await h.refresh();
      await h.refresh();
      expect(h.archived).toEqual([worker]);
      expect(h.released()).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });

  test('keeps a worker a failed todo is still bound to', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add(started));
      const failed = h.add(started);
      h.queueOn(failed.id);
      h.db
        .prepare("UPDATE neo_todos SET state = 'blocked', blocked_by = 'failure' WHERE id = ?")
        .run(failed.id);
      await h.refresh();
      expect(h.archived).toEqual([]);
      const db = { getDatabase: () => h.db } as never;
      expect(
        admitSessionArchive(
          worker,
          { source: 'internal', role: 'neo', principal: NEO_TODO_RELEASE_PRINCIPAL },
          db,
          startedByUs(h.db)
        )
      ).toMatchObject({
        reason: 'live_todo',
      });
    } finally {
      h.db.close();
    }
  });
});

describe('neo todo runner refresh keeps commits only the session branch holds', () => {
  const sessionWorktree = async (main: string) => {
    process.env.TEST_WORKTREE_BASE_DIR = join(scratch, 'worktrees');
    const manager = new WorktreeManager();
    const metadata = await manager.createWorktree({
      sessionId: crypto.randomUUID(),
      repoPath: main,
    });
    return { manager, metadata: metadata! };
  };

  test('keeps a detached worker whose commit lives only on its session branch', async () => {
    const h = setup();
    try {
      const { manager, metadata } = await sessionWorktree(h.folder());
      writeFileSync(join(metadata.worktreePath, 'w.txt'), 'w');
      git(metadata.worktreePath, 'add', 'w.txt');
      git(metadata.worktreePath, 'commit', '-q', '--no-gpg-sign', '-m', 'w');
      git(metadata.worktreePath, 'checkout', '-q', '--detach');
      h.setFolder(metadata.worktreePath);
      h.setArchive(async () => {
        await manager.removeWorktree(metadata, true);
        return { ok: true, value: { archived: true } };
      });
      await h.finishTodo(h.add(started));
      await h.refresh();
      expect(h.archived).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('archives a detached worker whose commit a branch checked out elsewhere holds', async () => {
    const h = setup();
    try {
      writeFileSync(join(h.folder(), 'base.txt'), 'base');
      git(h.folder(), 'add', 'base.txt');
      git(h.folder(), 'commit', '-q', '--no-gpg-sign', '-m', 'local base');
      const { manager, metadata } = await sessionWorktree(h.folder());
      git(metadata.worktreePath, 'checkout', '-q', '--detach');
      h.setFolder(metadata.worktreePath);
      h.setArchive(async () => {
        await manager.removeWorktree(metadata, true);
        return { ok: true, value: { archived: true } };
      });
      await h.finishTodo(h.add(started));
      await h.refresh();
      expect(h.archived).toEqual([worker]);
    } finally {
      h.db.close();
    }
  });
});

describe('admitSessionArchive', () => {
  test('admits the daemon itself releasing a worker', () => {
    const h = setup();
    try {
      const db = { getDatabase: () => h.db } as never;
      recordWorkerStarted(h.db, worker);
      expect(
        admitSessionArchive(
          worker,
          { source: 'internal', role: 'neo', principal: NEO_TODO_RELEASE_PRINCIPAL },
          db,
          startedByUs(h.db)
        )
      ).toBeNull();
      expect(
        admitSessionArchive(worker, { source: 'mcp', role: 'neo' }, db, startedByUs(h.db))
      ).not.toBeNull();
      expect(
        admitSessionArchive(worker, { source: 'internal', role: 'neo' }, db, startedByUs(h.db))
      ).not.toBeNull();
    } finally {
      h.db.close();
    }
  });

  test('refuses the daemon when a queued todo was bound to the worker after the sweep read', () => {
    const h = setup();
    try {
      const db = { getDatabase: () => h.db } as never;
      h.queueOn(h.add(started).id);
      expect(
        admitSessionArchive(
          worker,
          { source: 'internal', role: 'neo', principal: NEO_TODO_RELEASE_PRINCIPAL },
          db,
          startedByUs(h.db)
        )
      ).toMatchObject({
        ok: false,
        reason: 'live_todo',
      });
    } finally {
      h.db.close();
    }
  });
});
