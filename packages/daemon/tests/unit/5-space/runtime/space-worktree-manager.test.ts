/**
 * SpaceWorktreeManager unit tests
 *
 * Tests use a real temporary git repository to exercise actual git worktree
 * operations.  Each test suite creates its own isolated git repo and SQLite
 * database so that tests are fully independent.
 *
 * TEST_WORKTREE_BASE_DIR is set so worktrees are created under the temp
 * directory instead of ~/.hyperneo.
 *
 * Covered scenarios:
 * - createTaskWorktree: creates filesystem worktree + DB record
 * - createTaskWorktree: idempotent (returns existing record on second call)
 * - createTaskWorktree: stale branch cleanup before recreation
 * - createTaskWorktree: recovers from stale directory left by crashed run
 * - removeTaskWorktree: removes worktree dir, branch, and DB record
 * - removeTaskWorktree: no-op when no record exists
 * - getTaskWorktreePath: returns path for existing task, null for missing
 * - listWorktrees: returns all tracked worktrees for a space
 * - cleanupOrphaned: removes DB records whose directories are missing
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorktreeManager } from '../../../../src/lib/space/managers/space-worktree-manager.ts';
import { worktreeSlug } from '../../../../src/lib/space/worktree-slug.ts';
import { getProjectShortKey } from '../../../../src/lib/worktree-path-utils.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = join(process.cwd(), 'tmp', 'test-space-worktree-manager');

/**
 * Create a fresh temporary directory, initialise a git repo with an initial
 * commit, and return its path.
 */
async function makeGitRepo(label: string): Promise<string> {
  const dir = join(TMP_ROOT, `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  execSync('git -c init.defaultBranch=main init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });

  // Create an initial commit so HEAD exists and worktrees can be based on it
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execSync('git add .', { cwd: dir });
  execSync('git commit -m "initial commit"', { cwd: dir });

  return dir;
}

/**
 * Create an in-memory SQLite database with all migrations applied, seed a
 * space row pointing at the given workspace path, and return the db + spaceId.
 */
function makeDb(workspacePath: string): { db: BunDatabase; spaceId: string } {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});

  const spaceId = `space-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
	     allowed_models, session_ids, slug, status, created_at, updated_at)
	     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());

  return { db, spaceId };
}

/**
 * Seed a space_tasks row so FK constraints on space_worktrees.task_id are satisfied.
 * Returns the inserted task ID.
 */
function seedTask(db: BunDatabase, spaceId: string, taskId: string, taskNumber: number): string {
  db.prepare(
    `INSERT INTO space_tasks
	       (id, space_id, task_number, title, description, status, priority, depends_on, created_at, updated_at)
	     VALUES (?, ?, ?, ?, '', 'open', 'normal', '[]', ?, ?)`
  ).run(taskId, spaceId, taskNumber, `Task ${taskNumber}`, Date.now(), Date.now());
  return taskId;
}

let repoDir: string;
let testBaseDir: string;
let db: BunDatabase;
let spaceId: string;
let manager: SpaceWorktreeManager;

beforeEach(async () => {
  repoDir = await makeGitRepo('repo');
  // Set TEST_WORKTREE_BASE_DIR so worktrees go to a controlled temp location
  testBaseDir = join(TMP_ROOT, `hyperneo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testBaseDir, { recursive: true });
  process.env.TEST_WORKTREE_BASE_DIR = testBaseDir;

  const setup = makeDb(repoDir);
  db = setup.db;
  spaceId = setup.spaceId;
  manager = new SpaceWorktreeManager(db);
});

afterEach(() => {
  db.close();
  delete process.env.TEST_WORKTREE_BASE_DIR;
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures in CI
  }
  try {
    rmSync(testBaseDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures in CI
  }
});

// ---------------------------------------------------------------------------
// createTaskWorktree
// ---------------------------------------------------------------------------

describe('createTaskWorktree', () => {
  test('creates a worktree directory and returns slug + path', async () => {
    const taskId = seedTask(db, spaceId, 'task-001', 1);
    const result = await manager.createTaskWorktree(spaceId, taskId, 'Add feature', 1);

    expect(result.slug).toBe(worktreeSlug('Add feature', 1));
    expect(result.path).toContain(result.slug);
    expect(result.path).toContain('worktrees');
    expect(existsSync(result.path)).toBe(true);
  });

  test('creates worktree under TEST_WORKTREE_BASE_DIR, not inside source repo', async () => {
    const taskId = seedTask(db, spaceId, 'task-001b', 1);
    const result = await manager.createTaskWorktree(spaceId, taskId, 'Feature B', 1);

    // Path should be under testBaseDir, not under repoDir
    expect(result.path).toContain(testBaseDir);
    expect(result.path).not.toContain(repoDir);
    expect(existsSync(result.path)).toBe(true);
  });

  test('creates the correct branch name space/{slug}', async () => {
    const taskId = seedTask(db, spaceId, 'task-002', 2);
    const { slug } = await manager.createTaskWorktree(spaceId, taskId, 'Fix parser bug', 2);

    const branches = execSync('git branch --list', { cwd: repoDir }).toString();
    expect(branches).toContain(`space/${slug}`);
  });

  test('is idempotent — second call returns same path without error', async () => {
    const taskId = seedTask(db, spaceId, 'task-003', 3);
    const first = await manager.createTaskWorktree(spaceId, taskId, 'Refactor auth', 3);
    const second = await manager.createTaskWorktree(spaceId, taskId, 'Refactor auth', 3);

    expect(second.path).toBe(first.path);
    expect(second.slug).toBe(first.slug);
  });

  test('avoids slug collision across tasks in the same space', async () => {
    const tidA = seedTask(db, spaceId, 'task-col-a', 10);
    const tidB = seedTask(db, spaceId, 'task-col-b', 11);
    const result1 = await manager.createTaskWorktree(spaceId, tidA, 'Add feature', 10);
    const result2 = await manager.createTaskWorktree(spaceId, tidB, 'Add feature', 11);

    expect(result1.slug).toBe(worktreeSlug('Add feature', 10));
    expect(result2.slug).toBe(worktreeSlug('Add feature', 11, [result1.slug]));
    expect(result1.path).not.toBe(result2.path);
  });

  test('falls back to task-N slug when title has no alphanumeric characters', async () => {
    const taskId = seedTask(db, spaceId, 'task-x', 42);
    const result = await manager.createTaskWorktree(spaceId, taskId, '!!! ###', 42);
    expect(result.slug).toBe(worktreeSlug('!!! ###', 42));
  });

  test('uses custom baseBranch when provided', async () => {
    // Create a feature branch to base the worktree on; use -B to force-create
    // so the test is not sensitive to the repo's default branch name.
    execSync('git checkout -B base-branch-for-test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "base commit"', { cwd: repoDir });
    // Go back to the initial branch (main/master/dev — whatever init defaulted to)
    const branches = execSync('git branch', { cwd: repoDir }).toString();
    const initialBranch = branches
      .split('\n')
      .map((b) => b.replace(/^\*/, '').trim())
      .find((b) => b !== '' && b !== 'base-branch-for-test');
    if (initialBranch) {
      execSync(`git checkout ${initialBranch}`, { cwd: repoDir });
    }

    const taskId = seedTask(db, spaceId, 'task-004', 4);
    const result = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'From Base',
      4,
      'base-branch-for-test'
    );
    expect(existsSync(result.path)).toBe(true);
  });

  test('is safe with shell-special characters in baseBranch', async () => {
    // Create a feature branch with characters that are valid for git refs but have
    // special meaning in shells (e.g., ~ and ^ are valid in git rev-parse but
    // have special shell meaning). This verifies execFileSync passes them literally.
    execSync('git checkout -B base-branch-special', { cwd: repoDir });
    writeFileSync(join(repoDir, 'special.txt'), 'special\n');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "special test commit"', { cwd: repoDir });
    // Go back to the initial branch
    const branches = execSync('git branch', { cwd: repoDir }).toString();
    const initialBranch = branches
      .split('\n')
      .map((b) => b.replace(/^\*/, '').trim())
      .find((b) => b !== '' && b !== 'base-branch-special');
    if (initialBranch) {
      execSync(`git checkout "${initialBranch}"`, { cwd: repoDir });
    }

    const taskId = seedTask(db, spaceId, 'task-injection', 99);
    // Use baseBranch with characters that would be interpreted by a shell
    // but are passed literally via execFileSync array args
    const result = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Injection Test',
      99,
      'base-branch-special~1'
    );

    // Worktree should be created successfully
    // The ~1 suffix is valid for git (means "1 commit before base-branch-special")
    // but would be interpreted by a shell if passed through execSync template string
    expect(existsSync(result.path)).toBe(true);
  });

  test('recovers from stale directory left by a crashed previous run', async () => {
    const taskId = seedTask(db, spaceId, 'task-stale-dir', 99);
    const slug = worktreeSlug('Stale Dir Task', 99);
    const shortKey = getProjectShortKey(repoDir);
    const expectedPath = join(testBaseDir, shortKey, 'worktrees', slug);

    // Simulate a partial previous run: directory exists but no DB record
    mkdirSync(expectedPath, { recursive: true });

    // Should succeed without throwing
    const result = await manager.createTaskWorktree(spaceId, taskId, 'Stale Dir Task', 99);
    expect(result.path).toBe(expectedPath);
    expect(existsSync(result.path)).toBe(true);
  });

  test('recovers stale branch via git worktree prune when branch is in a prunable worktree', async () => {
    const shortKey = getProjectShortKey(repoDir);
    const stalePath = join(testBaseDir, shortKey, 'worktrees', 'prune-test-stale');
    mkdirSync(join(testBaseDir, shortKey, 'worktrees'), { recursive: true });
    execSync(`git worktree add "${stalePath}" -b space/prune-test HEAD`, { cwd: repoDir });
    // Verify the branch exists
    const branchesBeforeRm = execSync('git branch --list', { cwd: repoDir }).toString();
    expect(branchesBeforeRm).toContain('space/prune-test');

    // Simulate crash: remove the directory but leave the git worktree reference
    rmSync(stalePath, { recursive: true, force: true });

    // git worktree list should still show the stale entry (path gone, ref alive)
    const wtList = execSync('git worktree list', { cwd: repoDir }).toString();
    expect(wtList).toContain('prune-test-stale');

    // Now call createTaskWorktree for a task that resolves to the same slug.
    // The manager should:
    //   1. Detect the stale branch via git branch --list
    //   2. Fail on the first git branch -D (worktree path deleted but ref alive)
    //   3. Run git worktree prune to clear the stale ref
    //   4. Succeed on the second git branch -D
    //   5. Create the new worktree successfully
    const slug = 'prune-test';
    const taskId = seedTask(db, spaceId, 'task-prune', 77);
    // Use a title that slugifies to 'prune-test' so it maps to the same branch
    const result = await manager.createTaskWorktree(spaceId, taskId, 'prune test', 77);
    expect(result.slug).toBe(slug);
    expect(existsSync(result.path)).toBe(true);

    // Branch should be recreated
    const branchesAfter = execSync('git branch --list', { cwd: repoDir }).toString();
    expect(branchesAfter).toContain('space/prune-test');
  });

  test('throws when space does not exist', async () => {
    await expect(
      manager.createTaskWorktree('nonexistent-space', 'any-task-id', 'Title', 1)
    ).rejects.toThrow('Space not found');
  });
});

// ---------------------------------------------------------------------------
// removeTaskWorktree
// ---------------------------------------------------------------------------

describe('removeTaskWorktree', () => {
  test('removes the worktree directory, branch, and DB record', async () => {
    const taskId = seedTask(db, spaceId, 'task-rm-01', 10);
    const { path, slug } = await manager.createTaskWorktree(spaceId, taskId, 'Remove me', 10);

    expect(existsSync(path)).toBe(true);

    await manager.removeTaskWorktree(spaceId, taskId);

    expect(existsSync(path)).toBe(false);

    // Branch should be gone
    const branchList = execSync('git branch', { cwd: repoDir }).toString();
    expect(branchList).not.toContain(`space/${slug}`);

    // DB record should be gone
    const retrieved = await manager.getTaskWorktreePath(spaceId, taskId);
    expect(retrieved).toBeNull();
  });

  test('is a no-op when no record exists for the task', async () => {
    // Should not throw
    await expect(manager.removeTaskWorktree(spaceId, 'nonexistent-task')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getTaskWorktreePath
// ---------------------------------------------------------------------------

describe('getTaskWorktreePath', () => {
  test('returns the path for an existing task worktree', async () => {
    const taskId = seedTask(db, spaceId, 'task-path-01', 5);
    const { path } = await manager.createTaskWorktree(spaceId, taskId, 'My Task', 5);

    const retrieved = await manager.getTaskWorktreePath(spaceId, taskId);
    expect(retrieved).toBe(path);
  });

  test('returns null when no worktree exists for the task', async () => {
    const result = await manager.getTaskWorktreePath(spaceId, 'does-not-exist');
    expect(result).toBeNull();
  });

  // Sync variant was introduced so sync call sites (e.g. TaskAgentManager's
  // public getter used by tool handlers and RPCs) can read the persisted
  // path without bouncing through a Promise. The two variants must agree.
  test('getTaskWorktreePathSync mirrors the async variant', async () => {
    const taskId = seedTask(db, spaceId, 'task-path-sync-01', 6);
    const { path } = await manager.createTaskWorktree(spaceId, taskId, 'Sync Task', 6);

    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBe(path);
    expect(manager.getTaskWorktreePathSync(spaceId, 'no-such-task')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listWorktrees
// ---------------------------------------------------------------------------

describe('listWorktrees', () => {
  test('returns an empty array when no worktrees exist', async () => {
    const list = await manager.listWorktrees(spaceId);
    expect(list).toEqual([]);
  });

  test('lists all created worktrees for a space', async () => {
    const tidA = seedTask(db, spaceId, 'task-list-a', 1);
    const tidB = seedTask(db, spaceId, 'task-list-b', 2);
    await manager.createTaskWorktree(spaceId, tidA, 'Task A', 1);
    await manager.createTaskWorktree(spaceId, tidB, 'Task B', 2);

    const list = await manager.listWorktrees(spaceId);
    expect(list).toHaveLength(2);

    // Derive expected slugs from worktreeSlug() to stay in sync with slugification rules
    const expectedSlugA = worktreeSlug('Task A', 1);
    const expectedSlugB = worktreeSlug('Task B', 2);
    const slugs = list.map((w) => w.slug).sort();
    expect(slugs).toEqual([expectedSlugA, expectedSlugB].sort());

    for (const entry of list) {
      expect(entry.taskId).toBeDefined();
      expect(entry.path).toBeDefined();
      expect(entry.slug).toBeDefined();
    }
  });

  test('does not return worktrees for a different space', async () => {
    const taskId = seedTask(db, spaceId, 'task-x', 1);
    await manager.createTaskWorktree(spaceId, taskId, 'Task X', 1);

    // Create a second space pointing at a different workspace
    const otherSpaceId = `space-other-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
	       allowed_models, session_ids, slug, status, created_at, updated_at)
	       VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
    ).run(
      otherSpaceId,
      `/tmp/other-workspace-${Math.random()}`,
      'Other Space',
      otherSpaceId,
      Date.now(),
      Date.now()
    );

    const list = await manager.listWorktrees(otherSpaceId);
    expect(list).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupOrphaned
// ---------------------------------------------------------------------------

describe('cleanupOrphaned', () => {
  test('removes DB records for missing directories', async () => {
    const taskId = seedTask(db, spaceId, 'task-orphan-01', 20);
    const { path } = await manager.createTaskWorktree(spaceId, taskId, 'Orphan Task', 20);

    // Simulate the worktree directory disappearing without going through removeTaskWorktree
    // (e.g. manual deletion or OS cleanup)
    rmSync(path, { recursive: true, force: true });
    expect(existsSync(path)).toBe(false);

    // DB record still there
    expect(await manager.getTaskWorktreePath(spaceId, taskId)).toBe(path);

    await manager.cleanupOrphaned(spaceId);

    // DB record should now be gone
    expect(await manager.getTaskWorktreePath(spaceId, taskId)).toBeNull();
  });

  test('does not remove records for existing worktrees', async () => {
    const taskId = seedTask(db, spaceId, 'task-live-01', 21);
    const { path } = await manager.createTaskWorktree(spaceId, taskId, 'Live Task', 21);
    expect(existsSync(path)).toBe(true);

    await manager.cleanupOrphaned(spaceId);

    // Record should still be there
    expect(await manager.getTaskWorktreePath(spaceId, taskId)).toBe(path);
  });

  test('is a no-op when there are no worktrees', async () => {
    await expect(manager.cleanupOrphaned(spaceId)).resolves.toBeUndefined();
  });

  test('handles multiple orphaned records in one pass', async () => {
    const t1Id = seedTask(db, spaceId, 'task-o1', 30);
    const t2Id = seedTask(db, spaceId, 'task-o2', 31);
    const t3Id = seedTask(db, spaceId, 'task-o3', 32);
    const t1 = await manager.createTaskWorktree(spaceId, t1Id, 'Orphan 1', 30);
    const t2 = await manager.createTaskWorktree(spaceId, t2Id, 'Orphan 2', 31);
    const t3 = await manager.createTaskWorktree(spaceId, t3Id, 'Live', 32);

    // Remove two of the three directories
    rmSync(t1.path, { recursive: true, force: true });
    rmSync(t2.path, { recursive: true, force: true });

    await manager.cleanupOrphaned(spaceId);

    expect(await manager.getTaskWorktreePath(spaceId, t1Id)).toBeNull();
    expect(await manager.getTaskWorktreePath(spaceId, t2Id)).toBeNull();
    expect(await manager.getTaskWorktreePath(spaceId, t3Id)).toBe(t3.path);
  });
});
