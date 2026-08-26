import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorktreeManager } from '../../../../src/lib/space/managers/space-worktree-manager.ts';
import { worktreeSlug } from '../../../../src/lib/space/worktree-slug.ts';
import { getProjectShortKey } from '../../../../src/lib/worktree-path-utils.ts';

const TMP_ROOT = join(tmpdir(), 'test-space-worktree-manager');

async function makeGitRepo(label: string): Promise<string> {
  const dir = join(TMP_ROOT, `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  execSync('git -c init.defaultBranch=main init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });

  writeFileSync(join(dir, 'README.md'), '# test\n');
  execSync('git add .', { cwd: dir });
  execSync('git commit -m "initial commit"', { cwd: dir });

  return realpathSync(dir);
}

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
  testBaseDir = join(TMP_ROOT, `hyperneo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testBaseDir, { recursive: true });
  process.env.TEST_WORKTREE_BASE_DIR = testBaseDir;

  const setup = makeDb(repoDir);
  db = setup.db;
  spaceId = setup.spaceId;
  manager = new SpaceWorktreeManager(db);
}, 60_000);

afterEach(() => {
  db.close();
  delete process.env.TEST_WORKTREE_BASE_DIR;
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(testBaseDir, { recursive: true, force: true });
  } catch {}
}, 60_000);

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
    execSync('git checkout -B base-branch-for-test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "base commit"', { cwd: repoDir });
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
    execSync('git checkout -B base-branch-special', { cwd: repoDir });
    writeFileSync(join(repoDir, 'special.txt'), 'special\n');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "special test commit"', { cwd: repoDir });
    const branches = execSync('git branch', { cwd: repoDir }).toString();
    const initialBranch = branches
      .split('\n')
      .map((b) => b.replace(/^\*/, '').trim())
      .find((b) => b !== '' && b !== 'base-branch-special');
    if (initialBranch) {
      execSync(`git checkout "${initialBranch}"`, { cwd: repoDir });
    }

    const taskId = seedTask(db, spaceId, 'task-injection', 99);
    const result = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Injection Test',
      99,
      'base-branch-special~1'
    );

    expect(existsSync(result.path)).toBe(true);
  });

  test('recovers from stale directory left by a crashed previous run', async () => {
    const taskId = seedTask(db, spaceId, 'task-stale-dir', 99);
    const slug = worktreeSlug('Stale Dir Task', 99);
    const shortKey = getProjectShortKey(join(repoDir, '.git'));
    const expectedPath = join(testBaseDir, shortKey, 'worktrees', slug);

    mkdirSync(expectedPath, { recursive: true });

    const result = await manager.createTaskWorktree(spaceId, taskId, 'Stale Dir Task', 99);
    expect(result.path).toBe(expectedPath);
    expect(existsSync(result.path)).toBe(true);
  });

  test('recovers stale branch via git worktree prune when branch is in a prunable worktree', async () => {
    const shortKey = getProjectShortKey(join(repoDir, '.git'));
    const stalePath = join(testBaseDir, shortKey, 'worktrees', 'prune-test-stale');
    mkdirSync(join(testBaseDir, shortKey, 'worktrees'), { recursive: true });
    execSync(`git worktree add "${stalePath}" -b space/prune-test HEAD`, { cwd: repoDir });
    const branchesBeforeRm = execSync('git branch --list', { cwd: repoDir }).toString();
    expect(branchesBeforeRm).toContain('space/prune-test');

    rmSync(stalePath, { recursive: true, force: true });

    const wtList = execSync('git worktree list', { cwd: repoDir }).toString();
    expect(wtList).toContain('prune-test-stale');

    const slug = 'prune-test';
    const taskId = seedTask(db, spaceId, 'task-prune', 77);
    const result = await manager.createTaskWorktree(spaceId, taskId, 'prune test', 77);
    expect(result.slug).toBe(slug);
    expect(existsSync(result.path)).toBe(true);

    const branchesAfter = execSync('git branch --list', { cwd: repoDir }).toString();
    expect(branchesAfter).toContain('space/prune-test');
  });

  test('throws when space does not exist', async () => {
    await expect(
      manager.createTaskWorktree('nonexistent-space', 'any-task-id', 'Title', 1)
    ).rejects.toThrow('Space not found');
  });
});

describe('createTaskWorktree — explicit repoRoot (WS11)', () => {
  let secondaryDir: string;

  beforeEach(async () => {
    secondaryDir = await makeGitRepo('secondary');
  });

  afterEach(() => {
    try {
      rmSync(secondaryDir, { recursive: true, force: true });
    } catch {}
  });

  test('secondary-repo task lands under that repo project dir; default task unchanged', async () => {
    const defaultTaskId = seedTask(db, spaceId, 'task-ws11-default', 60);
    const secondaryTaskId = seedTask(db, spaceId, 'task-ws11-secondary', 61);

    const defaultResult = await manager.createTaskWorktree(
      spaceId,
      defaultTaskId,
      'Default Repo Task',
      60
    );
    const secondaryResult = await manager.createTaskWorktree(
      spaceId,
      secondaryTaskId,
      'Secondary Repo Task',
      61,
      undefined,
      secondaryDir
    );

    expect(defaultResult.path).toBe(
      join(testBaseDir, getProjectShortKey(join(repoDir, '.git')), 'worktrees', defaultResult.slug)
    );
    expect(secondaryResult.path).toBe(
      join(
        testBaseDir,
        getProjectShortKey(join(secondaryDir, '.git')),
        'worktrees',
        secondaryResult.slug
      )
    );
    expect(existsSync(defaultResult.path)).toBe(true);
    expect(existsSync(secondaryResult.path)).toBe(true);

    const primaryBranches = execSync('git branch --list', { cwd: repoDir }).toString();
    const secondaryBranches = execSync('git branch --list', { cwd: secondaryDir }).toString();

    expect(primaryBranches).toContain(`space/${defaultResult.slug}`);
    expect(primaryBranches).not.toContain(`space/${secondaryResult.slug}`);
    expect(secondaryBranches).toContain(`space/${secondaryResult.slug}`);
    expect(secondaryBranches).not.toContain(`space/${defaultResult.slug}`);
  });

  test('secondary-repo worktree is registered in that repo only, path unchanged for lookups', async () => {
    const taskId = seedTask(db, spaceId, 'task-ws11-list', 62);
    const { path } = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Secondary Only',
      62,
      undefined,
      secondaryDir
    );

    const primaryWorktrees = execSync('git worktree list', { cwd: repoDir }).toString();
    const secondaryWorktrees = execSync('git worktree list', { cwd: secondaryDir }).toString();
    expect(primaryWorktrees).not.toContain(path);
    expect(secondaryWorktrees).toContain(path);

    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBe(path);
  });

  test('stale branch cleanup runs in the repoRoot repo', async () => {
    const taskId = seedTask(db, spaceId, 'task-ws11-stale', 63);
    const slug = worktreeSlug('Stale Branch Task', 63);
    execSync(`git branch "space/${slug}" HEAD`, { cwd: secondaryDir });

    const result = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Stale Branch Task',
      63,
      undefined,
      secondaryDir
    );

    expect(result.slug).toBe(slug);
    expect(existsSync(result.path)).toBe(true);
    const secondaryWorktrees = execSync('git worktree list', { cwd: secondaryDir }).toString();
    expect(secondaryWorktrees).toContain(result.path);
  });

  test('stale directory recovery targets the repoRoot project dir', async () => {
    const taskId = seedTask(db, spaceId, 'task-ws11-stale-dir', 64);
    const slug = worktreeSlug('Stale Dir Secondary', 64);
    const expectedPath = join(
      testBaseDir,
      getProjectShortKey(join(secondaryDir, '.git')),
      'worktrees',
      slug
    );
    mkdirSync(expectedPath, { recursive: true });

    const result = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Stale Dir Secondary',
      64,
      undefined,
      secondaryDir
    );

    expect(result.path).toBe(expectedPath);
    expect(existsSync(result.path)).toBe(true);
  });

  test('removeTaskWorktree cleans up in the owning secondary repo and spares primary branches', async () => {
    const taskId = seedTask(db, spaceId, 'task-ws11-rm', 65);
    const { path, slug } = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Remove Secondary',
      65,
      undefined,
      secondaryDir
    );
    execSync(`git branch "space/${slug}" HEAD`, { cwd: repoDir });

    await manager.removeTaskWorktree(spaceId, taskId);

    expect(existsSync(path)).toBe(false);
    const secondaryBranches = execSync('git branch --list', { cwd: secondaryDir }).toString();
    expect(secondaryBranches).not.toContain(`space/${slug}`);
    const primaryBranches = execSync('git branch --list', { cwd: repoDir }).toString();
    expect(primaryBranches).toContain(`space/${slug}`);
    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBeNull();
  });

  test('cleanupOrphaned deletes the branch in the owning secondary repo when the dir is gone', async () => {
    const taskId = seedTask(db, spaceId, 'task-ws11-orphan', 66);
    const { path, slug } = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Orphan Secondary',
      66,
      undefined,
      secondaryDir
    );

    rmSync(path, { recursive: true, force: true });
    const secondaryWorktreesBefore = execSync('git worktree list', {
      cwd: secondaryDir,
    }).toString();
    expect(secondaryWorktreesBefore).toContain(slug);

    await manager.cleanupOrphaned(spaceId);

    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBeNull();
    const secondaryBranches = execSync('git branch --list', { cwd: secondaryDir }).toString();
    expect(secondaryBranches).not.toContain(`space/${slug}`);
    const secondaryWorktreesAfter = execSync('git worktree list', {
      cwd: secondaryDir,
    }).toString();
    expect(secondaryWorktreesAfter).not.toContain(slug);
  });

  test('removeTaskWorktree still deletes the checkout directory when the owning repo disappeared', async () => {
    const taskId = seedTask(db, spaceId, 'task-ws11-dead-repo', 67);
    const { path } = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Dead Repo Task',
      67,
      undefined,
      secondaryDir
    );

    rmSync(secondaryDir, { recursive: true, force: true });
    expect(existsSync(path)).toBe(true);

    await manager.removeTaskWorktree(spaceId, taskId);

    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test('slug uniqueness spans spaces sharing a repo', async () => {
    const otherSpaceId = `space-ws11-other-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
	       allowed_models, session_ids, slug, status, created_at, updated_at)
	       VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
    ).run(
      otherSpaceId,
      secondaryDir,
      `Space ${otherSpaceId}`,
      otherSpaceId,
      Date.now(),
      Date.now()
    );

    const taskA = seedTask(db, spaceId, 'task-ws11-share-a', 68);
    const taskB = seedTask(db, otherSpaceId, 'task-ws11-share-b', 68);

    const a = await manager.createTaskWorktree(
      spaceId,
      taskA,
      'Shared Title',
      68,
      undefined,
      secondaryDir
    );
    const b = await manager.createTaskWorktree(otherSpaceId, taskB, 'Shared Title', 68);

    expect(a.slug).not.toBe(b.slug);
    expect(a.path).not.toBe(b.path);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
  });

  test('symlinked repo spellings canonicalize to one project dir and dedupe slugs', async () => {
    const aliasDir = join(TMP_ROOT, `alias-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(secondaryDir, aliasDir);

    const taskA = seedTask(db, spaceId, 'task-ws11-alias-a', 69);
    const taskB = seedTask(db, spaceId, 'task-ws11-alias-b', 70);

    const a = await manager.createTaskWorktree(
      spaceId,
      taskA,
      'Alias Title',
      69,
      undefined,
      secondaryDir
    );
    const b = await manager.createTaskWorktree(
      spaceId,
      taskB,
      'Alias Title',
      70,
      undefined,
      aliasDir
    );

    expect(b.slug).not.toBe(a.slug);
    expect(a.path).toContain(getProjectShortKey(join(secondaryDir, '.git')));
    expect(b.path).toContain(getProjectShortKey(join(secondaryDir, '.git')));
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);

    const secondaryBranches = execSync('git branch --list', { cwd: secondaryDir }).toString();
    expect(secondaryBranches).toContain(`space/${a.slug}`);
    expect(secondaryBranches).toContain(`space/${b.slug}`);

    rmSync(aliasDir, { force: true });
  });

  test('same-titled tasks in two repos of one space get distinct slugs', async () => {
    const taskA = seedTask(db, spaceId, 'task-ws11-two-repos-a', 71);
    const taskB = seedTask(db, spaceId, 'task-ws11-two-repos-b', 72);

    const a = await manager.createTaskWorktree(spaceId, taskA, 'Union Title', 71);
    const b = await manager.createTaskWorktree(
      spaceId,
      taskB,
      'Union Title',
      72,
      undefined,
      secondaryDir
    );

    expect(a.slug).not.toBe(b.slug);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
  });

  test('linked-worktree spellings of one repo share one project dir and slug scope', async () => {
    const linkedDir = join(TMP_ROOT, `linked-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    execSync(`git worktree add "${linkedDir}" -b tmp-linked HEAD`, {
      cwd: secondaryDir,
      stdio: 'pipe',
    });

    const otherSpaceId = `space-ws11-linked-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
	       allowed_models, session_ids, slug, status, created_at, updated_at)
	       VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
    ).run(
      otherSpaceId,
      realpathSync(linkedDir),
      `Space ${otherSpaceId}`,
      otherSpaceId,
      Date.now(),
      Date.now()
    );

    const taskA = seedTask(db, spaceId, 'task-ws11-linked-a', 73);
    const taskB = seedTask(db, otherSpaceId, 'task-ws11-linked-b', 74);

    const a = await manager.createTaskWorktree(
      spaceId,
      taskA,
      'Linked Title',
      73,
      undefined,
      secondaryDir
    );
    const b = await manager.createTaskWorktree(otherSpaceId, taskB, 'Linked Title', 74);

    expect(a.path).toContain(getProjectShortKey(join(secondaryDir, '.git')));
    expect(b.path).toContain(getProjectShortKey(join(secondaryDir, '.git')));
    expect(b.slug).not.toBe(a.slug);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);

    const secondaryBranches = execSync('git branch --list', { cwd: secondaryDir }).toString();
    expect(secondaryBranches).toContain(`space/${a.slug}`);
    expect(secondaryBranches).toContain(`space/${b.slug}`);

    rmSync(linkedDir, { recursive: true, force: true });
  });

  test('nested-directory spellings share one project dir and slug scope', async () => {
    const nestedDir = join(secondaryDir, 'nested');
    mkdirSync(nestedDir);

    const taskA = seedTask(db, spaceId, 'task-ws11-nested-a', 75);
    const taskB = seedTask(db, spaceId, 'task-ws11-nested-b', 76);

    const a = await manager.createTaskWorktree(
      spaceId,
      taskA,
      'Nested Title',
      75,
      undefined,
      secondaryDir
    );
    const b = await manager.createTaskWorktree(
      spaceId,
      taskB,
      'Nested Title',
      76,
      undefined,
      nestedDir
    );

    expect(b.path).toContain(getProjectShortKey(join(secondaryDir, '.git')));
    expect(b.slug).not.toBe(a.slug);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
  });

  test('separate-git-dir repositories clean up via the recorded command cwd', async () => {
    const sepRepoDir = join(
      TMP_ROOT,
      `seprepo-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const sepGitDir = join(TMP_ROOT, `sepgit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    execSync(
      `git -c init.defaultBranch=main init --separate-git-dir="${sepGitDir}" "${sepRepoDir}"`,
      {
        stdio: 'pipe',
      }
    );
    execSync('git config user.name "Test User"', { cwd: sepRepoDir });
    execSync('git config user.email "test@example.com"', { cwd: sepRepoDir });
    writeFileSync(join(sepRepoDir, 'README.md'), '# test\n');
    execSync('git add .', { cwd: sepRepoDir });
    execSync('git commit -m "initial commit"', { cwd: sepRepoDir });

    const taskId = seedTask(db, spaceId, 'task-ws11-separate', 77);
    const { slug } = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Separate Git Dir',
      77,
      undefined,
      sepRepoDir
    );

    await manager.removeTaskWorktree(spaceId, taskId);

    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBeNull();
    const branches = execSync('git branch --list', { cwd: sepRepoDir }).toString();
    expect(branches).not.toContain(`space/${slug}`);

    rmSync(sepRepoDir, { recursive: true, force: true });
    rmSync(sepGitDir, { recursive: true, force: true });
  });

  test('cleanup falls back to the common repo when the recorded checkout cwd disappeared', async () => {
    const linkedCwd = join(
      TMP_ROOT,
      `gonecwd-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    execSync(`git worktree add "${linkedCwd}" -b tmp-gone HEAD`, {
      cwd: secondaryDir,
      stdio: 'pipe',
    });

    const taskId = seedTask(db, spaceId, 'task-ws11-gone-cwd', 78);
    const { slug } = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Gone Cwd Task',
      78,
      undefined,
      realpathSync(linkedCwd)
    );

    rmSync(linkedCwd, { recursive: true, force: true });
    execSync('git worktree prune', { cwd: secondaryDir, stdio: 'pipe' });

    await manager.removeTaskWorktree(spaceId, taskId);

    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBeNull();
    const branches = execSync('git branch --list', { cwd: secondaryDir }).toString();
    expect(branches).not.toContain(`space/${slug}`);
  });

  test('cleanup ignores a recorded cwd that now belongs to a different repository', async () => {
    const taskId = seedTask(db, spaceId, 'task-ws11-swapped-cwd', 79);
    const { path, slug } = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Swapped Cwd Task',
      79,
      undefined,
      secondaryDir
    );

    const decoyDir = await makeGitRepo('decoy');
    const projectDir = join(path, '..', '..');
    writeFileSync(join(projectDir, '.hyperneo-repo-cwd'), decoyDir);

    await manager.removeTaskWorktree(spaceId, taskId);

    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBeNull();
    expect(existsSync(path)).toBe(false);
    const secondaryBranches = execSync('git branch --list', { cwd: secondaryDir }).toString();
    expect(secondaryBranches).not.toContain(`space/${slug}`);

    rmSync(decoyDir, { recursive: true, force: true });
  });

  test('removeTaskWorktree respects a git worktree lock and keeps the checkout', async () => {
    const taskId = seedTask(db, spaceId, 'task-ws11-locked', 80);
    const { path } = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Locked Task',
      80,
      undefined,
      secondaryDir
    );

    execSync(`git worktree lock "${path}"`, { cwd: secondaryDir, stdio: 'pipe' });

    await manager.removeTaskWorktree(spaceId, taskId);

    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBeNull();
    expect(existsSync(path)).toBe(true);

    execSync(`git worktree unlock "${path}"`, { cwd: secondaryDir, stdio: 'pipe' });
  });

  test('a second daemon database cannot clobber the first live worktree', async () => {
    const taskA = seedTask(db, spaceId, 'task-ws11-crossdb-a', 81);
    const a = await manager.createTaskWorktree(
      spaceId,
      taskA,
      'Cross Db Title',
      81,
      undefined,
      secondaryDir
    );

    const otherSetup = makeDb(secondaryDir);
    const manager2 = new SpaceWorktreeManager(otherSetup.db);
    const taskB = seedTask(otherSetup.db, otherSetup.spaceId, 'task-ws11-crossdb-b', 81);

    await expect(
      manager2.createTaskWorktree(otherSetup.spaceId, taskB, 'Cross Db Title', 81)
    ).rejects.toThrow('already in use by a live registered worktree');
    expect(existsSync(a.path)).toBe(true);

    otherSetup.db.close();
  });

  test('a crashed creation between git add and the DB insert is adopted on retry', async () => {
    const taskId = seedTask(db, spaceId, 'task-ws11-adopt', 82);
    const first = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Crash Adopt Task',
      82,
      undefined,
      secondaryDir
    );

    db.prepare('DELETE FROM space_worktrees WHERE space_id = ? AND task_id = ?').run(
      spaceId,
      taskId
    );

    const second = await manager.createTaskWorktree(
      spaceId,
      taskId,
      'Crash Adopt Task',
      82,
      undefined,
      secondaryDir
    );

    expect(second.path).toBe(first.path);
    expect(second.slug).toBe(first.slug);
    expect(existsSync(second.path)).toBe(true);
    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBe(second.path);
  });

  test('bare repository spellings canonicalize to one project dir and slug scope', async () => {
    const bareDir = join(TMP_ROOT, `bare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const seedDir = join(TMP_ROOT, `bareseed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    execSync(`git -c init.defaultBranch=main init "${seedDir}"`, { stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: seedDir });
    execSync('git config user.email "test@example.com"', { cwd: seedDir });
    writeFileSync(join(seedDir, 'README.md'), '# test\n');
    execSync('git add .', { cwd: seedDir });
    execSync('git commit -m "initial commit"', { cwd: seedDir });
    execSync(`git -c init.defaultBranch=main init --bare "${bareDir}"`, { stdio: 'pipe' });
    execSync(`git -C "${seedDir}" push "${bareDir}" main:main`, { stdio: 'pipe' });

    const bareAlias = join(
      TMP_ROOT,
      `barealias-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    symlinkSync(bareDir, bareAlias);

    const otherSpaceId = `space-ws11-bare-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
	       allowed_models, session_ids, slug, status, created_at, updated_at)
	       VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
    ).run(otherSpaceId, bareAlias, `Space ${otherSpaceId}`, otherSpaceId, Date.now(), Date.now());

    const taskA = seedTask(db, spaceId, 'task-ws11-bare-a', 83);
    const taskB = seedTask(db, otherSpaceId, 'task-ws11-bare-b', 84);

    const a = await manager.createTaskWorktree(
      spaceId,
      taskA,
      'Bare Title',
      83,
      undefined,
      bareDir
    );
    const b = await manager.createTaskWorktree(otherSpaceId, taskB, 'Bare Title', 84);

    expect(b.slug).not.toBe(a.slug);
    expect(b.path).toContain(getProjectShortKey(realpathSync(bareDir)));
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);

    const bareBranches = execSync('git branch --list', { cwd: bareDir }).toString();
    expect(bareBranches).toContain(`space/${a.slug}`);
    expect(bareBranches).toContain(`space/${b.slug}`);

    rmSync(bareAlias, { force: true });
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  });

  test('legacy worktree directories keep contributing to slug scoping', async () => {
    const legacySpaceId = `space-ws11-legacy-${Math.random().toString(36).slice(2)}`;
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
	       allowed_models, session_ids, slug, status, created_at, updated_at)
	       VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
    ).run(
      legacySpaceId,
      secondaryDir,
      `Space ${legacySpaceId}`,
      legacySpaceId,
      Date.now(),
      Date.now()
    );

    const legacyTitle = 'Legacy Title';
    const legacySlug = worktreeSlug(legacyTitle, 1);
    const legacyDir = join(testBaseDir, getProjectShortKey(secondaryDir), 'worktrees');
    mkdirSync(legacyDir, { recursive: true });
    execSync(`git branch "space/${legacySlug}" HEAD`, { cwd: secondaryDir });
    db.prepare(
      `INSERT INTO space_worktrees (id, space_id, task_id, slug, path, created_at)
	       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      `wt-legacy-${Math.random().toString(36).slice(2)}`,
      legacySpaceId,
      seedTask(db, legacySpaceId, 'task-ws11-legacy-old', 86),
      legacySlug,
      join(legacyDir, legacySlug),
      Date.now()
    );

    const taskNew = seedTask(db, spaceId, 'task-ws11-legacy-new', 85);
    const created = await manager.createTaskWorktree(
      spaceId,
      taskNew,
      legacyTitle,
      85,
      undefined,
      secondaryDir
    );

    expect(created.slug).not.toBe(legacySlug);
    expect(existsSync(created.path)).toBe(true);
  });
});

describe('removeTaskWorktree', () => {
  test('removes the worktree directory, branch, and DB record', async () => {
    const taskId = seedTask(db, spaceId, 'task-rm-01', 10);
    const { path, slug } = await manager.createTaskWorktree(spaceId, taskId, 'Remove me', 10);

    expect(existsSync(path)).toBe(true);

    await manager.removeTaskWorktree(spaceId, taskId);

    expect(existsSync(path)).toBe(false);

    const branchList = execSync('git branch', { cwd: repoDir }).toString();
    expect(branchList).not.toContain(`space/${slug}`);

    const retrieved = await manager.getTaskWorktreePath(spaceId, taskId);
    expect(retrieved).toBeNull();
  });

  test('is a no-op when no record exists for the task', async () => {
    await expect(manager.removeTaskWorktree(spaceId, 'nonexistent-task')).resolves.toBeUndefined();
  });
});

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

  test('getTaskWorktreePathSync mirrors the async variant', async () => {
    const taskId = seedTask(db, spaceId, 'task-path-sync-01', 6);
    const { path } = await manager.createTaskWorktree(spaceId, taskId, 'Sync Task', 6);

    expect(manager.getTaskWorktreePathSync(spaceId, taskId)).toBe(path);
    expect(manager.getTaskWorktreePathSync(spaceId, 'no-such-task')).toBeNull();
  });
});

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

describe('cleanupOrphaned', () => {
  test('removes DB records for missing directories', async () => {
    const taskId = seedTask(db, spaceId, 'task-orphan-01', 20);
    const { path } = await manager.createTaskWorktree(spaceId, taskId, 'Orphan Task', 20);

    rmSync(path, { recursive: true, force: true });
    expect(existsSync(path)).toBe(false);

    expect(await manager.getTaskWorktreePath(spaceId, taskId)).toBe(path);

    await manager.cleanupOrphaned(spaceId);

    expect(await manager.getTaskWorktreePath(spaceId, taskId)).toBeNull();
  });

  test('does not remove records for existing worktrees', async () => {
    const taskId = seedTask(db, spaceId, 'task-live-01', 21);
    const { path } = await manager.createTaskWorktree(spaceId, taskId, 'Live Task', 21);
    expect(existsSync(path)).toBe(true);

    await manager.cleanupOrphaned(spaceId);

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

    rmSync(t1.path, { recursive: true, force: true });
    rmSync(t2.path, { recursive: true, force: true });

    await manager.cleanupOrphaned(spaceId);

    expect(await manager.getTaskWorktreePath(spaceId, t1Id)).toBeNull();
    expect(await manager.getTaskWorktreePath(spaceId, t2Id)).toBeNull();
    expect(await manager.getTaskWorktreePath(spaceId, t3Id)).toBe(t3.path);
  });
});
