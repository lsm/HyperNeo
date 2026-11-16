import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { releaseNeoTodoWorkers } from '../../../../src/lib/neo/todo-release.ts';
import { admitSessionArchive } from '../../../../src/lib/neo/session-archive-operation.ts';
import { WorktreeManager } from '../../../../src/lib/worktree-manager.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { recordedWorkInvoke } from '../../helpers/recorded-work-invoke.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

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
  let archive: (caller: OperationCaller) => unknown = () => ({
    ok: true,
    value: { archived: true },
  });
  let onStatus = () => {};
  let folder = pushedCheckout();
  const invoke = recordedWorkInvoke(sessions.inputs, async (caller, name, input) => {
    if (name === 'work.start')
      return completed({
        ok: true,
        value: {
          ref: worker,
          receipt: { executionId: worker.id, inputId: 'i' },
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
      return completed(archive(caller));
    }
    if (name === 'work.status') onStatus();
    if (name === 'work.status')
      return completed({
        ok: true,
        value: { ref: worker, execution: { directory: folder, machine: 'laptop' } },
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
    tell: async () => {},
    attend: async () => {},
    changed: () => {},
  });
  const add = (target: NeoDriverTarget) => {
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
        named: null,
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
  const refresh = () => runner.refresh(() => {});
  return {
    db,
    add,
    finishTodo,
    refresh,
    archived,
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

  test('keeps a worker the human named', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add({ ...started, name: 'Jason' }));
      await h.refresh();
      expect(h.archived).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  test('keeps a worker the todo only sent work to', async () => {
    const h = setup();
    try {
      await h.finishTodo(h.add({ verb: 'send', ref: worker }));
      await h.refresh();
      expect(h.archived).toEqual([]);
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

describe('neo todo runner refresh keeps workers with unsaved work', () => {
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

describe('releaseNeoTodoWorkers', () => {
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
      expect(h.released()).toEqual([]);
    } finally {
      h.db.close();
    }
  });
});

describe('neo todo runner refresh settles shared and local-only work', () => {
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
      h.db.prepare("UPDATE neo_todos SET state = 'failed' WHERE id = ?").run(failed.id);
      await h.refresh();
      expect(h.archived).toEqual([]);
      const db = { getDatabase: () => h.db } as never;
      expect(admitSessionArchive(worker, { source: 'internal', role: 'neo' }, db)).toMatchObject({
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
      expect(admitSessionArchive(worker, { source: 'internal', role: 'neo' }, db)).toBeNull();
      expect(admitSessionArchive(worker, { source: 'mcp', role: 'neo' }, db)).not.toBeNull();
    } finally {
      h.db.close();
    }
  });

  test('refuses the daemon when a queued todo was bound to the worker after the sweep read', () => {
    const h = setup();
    try {
      const db = { getDatabase: () => h.db } as never;
      h.queueOn(h.add(started).id);
      expect(admitSessionArchive(worker, { source: 'internal', role: 'neo' }, db)).toMatchObject({
        ok: false,
        reason: 'live_todo',
      });
    } finally {
      h.db.close();
    }
  });
});
