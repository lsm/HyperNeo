import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { cleanupOwnedWorktree } from '../../../../src/lib/drivers/work-placement.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
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
import { recordWorkerStarted } from '../../../../src/storage/work-started-sessions.ts';
import { recordedWorkInvoke } from '../../helpers/recorded-work-invoke.ts';

const worker = { adapter: 'hyperneo', id: 'worker-1' };
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
  const notices: string[] = [];
  let archive: (caller: OperationCaller) => unknown = () => ({
    ok: true,
    value: { archived: true },
  });
  let onStatus = () => {};
  let folder = pushedCheckout();
  let next = worker;
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
    if (name === 'work.start')
      return completed({
        ok: true,
        value: {
          ref: next,
          receipt: { executionId: next.id, inputId: 'i' },
          lastActivityAt: 1,
        },
      });
    if (name === 'work.send')
      return completed({
        ok: true,
        value: { delivered: true, receipt: { executionId: worker.id, inputId: 'i' } },
      });
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
    packs: () => [],
    tell: async (_ask, _todo, note) => {
      notices.push(note);
    },
    attend: async () => {},
    changed: () => {},
  });
  const add = (target: NeoDriverTarget, named: Record<string, unknown> | null = null) => {
    const todo = store.addTodo(
      crypto.randomUUID(),
      'ask',
      {
        approvedAt: 1,
        dependsOn: [],
        title: 'Rows',
        doneWhen: 'PR merged',
        check: null,
        instruction: 'Build the rows.',
        named,
      },
      1
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
    notices,
    setArchive: (next: (caller: OperationCaller) => unknown) => {
      archive = next;
    },
    setFolder: (next: string) => {
      folder = next;
    },
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
          admitSessionArchive(worker, caller, db) ?? { ok: true, value: { archived: true } }
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
          admitSessionArchive(worker, caller, db) ?? { ok: true, value: { archived: true } }
      );
      await h.finishTodo(h.add({ verb: 'send', ref: worker }));
      h.db
        .prepare('DELETE FROM work_started_sessions WHERE adapter = ? AND id = ?')
        .run(worker.adapter, worker.id);
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
          admitSessionArchive(worker, caller, db) ?? { ok: true, value: { archived: true } }
      );
      await h.finishTodo(h.add({ verb: 'send', ref: worker }));
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
      await h.finishTodo(h.add({ verb: 'send', ref: worker }));
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

  test('keeps only the most recently used free worker per folder under long_lived', async () => {
    const h = setup();
    const newer = { adapter: 'hyperneo', id: 'worker-2' };
    try {
      h.reuse('long_lived');
      const first = h.add(started);
      await h.finishTodo(first);
      await h.refresh();
      expect(h.archived).toEqual([]);
      expect(kept(h)).toEqual([{ kept: 'kept_for_reuse' }]);
      h.db
        .prepare('UPDATE neo_todos SET finished_at = ? WHERE id = ?')
        .run(Date.now() - 8 * 24 * 60 * 60 * 1000, first.id);
      h.startNext(newer);
      await h.finishTodo(h.add(started));
      await h.refresh();
      await h.refresh();
      expect(h.archived).toEqual([worker]);
      expect(h.released()).toHaveLength(1);
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
          admitSessionArchive(worker, caller, db) ?? { ok: true, value: { archived: true } }
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
          db
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
          db
        )
      ).toBeNull();
      expect(admitSessionArchive(worker, { source: 'mcp', role: 'neo' }, db)).not.toBeNull();
      expect(admitSessionArchive(worker, { source: 'internal', role: 'neo' }, db)).not.toBeNull();
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
          db
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
