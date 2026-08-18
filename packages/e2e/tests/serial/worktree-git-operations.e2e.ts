import { test, expect } from '../../fixtures';
import { createSessionViaUI, waitForWebSocketConnected } from '../helpers/wait-helpers';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execAsync = promisify(exec);

test.use({
  storageState: undefined,
});

test.describe
  .serial('Git Worktree Integration', () => {
    const testRepoPath = join(tmpdir(), 'hyperneo-e2e-test-worktree-repo');

    async function createTestGitRepo() {
      if (existsSync(testRepoPath)) {
        rmSync(testRepoPath, { recursive: true, force: true });
      }

      mkdirSync(testRepoPath, { recursive: true });

      await execAsync('git init', { cwd: testRepoPath });
      await execAsync('git config user.name "Test User"', { cwd: testRepoPath });
      await execAsync('git config user.email "test@example.com"', {
        cwd: testRepoPath,
      });

      await execAsync('echo "# Test Repo" > README.md', { cwd: testRepoPath });
      await execAsync('git add .', { cwd: testRepoPath });
      await execAsync('git commit -m "Initial commit"', { cwd: testRepoPath });
    }

    function cleanupTestRepo() {
      if (existsSync(testRepoPath)) {
        rmSync(testRepoPath, { recursive: true, force: true });
      }
    }

    test.beforeAll(async () => {
      await createTestGitRepo();
    });

    test.afterAll(() => {
      cleanupTestRepo();
    });

    test('should gracefully handle non-git workspace', async ({ page }) => {
      await page.goto('/');
      await waitForWebSocketConnected(page);

      const sessionId = await createSessionViaUI(page);
      expect(sessionId).toBeTruthy();

      await page.getByRole('button', { name: 'Chats' }).click();
      await page.waitForTimeout(500);

      const worktreeBadge = page.locator('span[title*="Worktree:"]');
      await expect(worktreeBadge).not.toBeVisible();
    });
  });

test.describe
  .serial('Worktree Manual Cleanup', () => {
    const testRepoPath = join(tmpdir(), 'hyperneo-e2e-test-cleanup-repo');

    async function createTestGitRepo() {
      if (existsSync(testRepoPath)) {
        rmSync(testRepoPath, { recursive: true, force: true });
      }

      mkdirSync(testRepoPath, { recursive: true });

      await execAsync('git init', { cwd: testRepoPath });
      await execAsync('git config user.name "Test User"', { cwd: testRepoPath });
      await execAsync('git config user.email "test@example.com"', {
        cwd: testRepoPath,
      });
      await execAsync('echo "# Test Repo" > README.md', { cwd: testRepoPath });
      await execAsync('git add .', { cwd: testRepoPath });
      await execAsync('git commit -m "Initial commit"', { cwd: testRepoPath });
    }

    function cleanupTestRepo() {
      if (existsSync(testRepoPath)) {
        rmSync(testRepoPath, { recursive: true, force: true });
      }
    }

    test.beforeAll(async () => {
      await createTestGitRepo();
    });

    test.afterAll(() => {
      cleanupTestRepo();
    });

    test('should cleanup orphaned worktrees via RPC call', async ({ page }) => {
      const orphanedId = 'orphaned-test-session';
      const worktreePath = join(testRepoPath, '.worktrees', orphanedId);

      await execAsync(`git worktree add "${worktreePath}" -b session/${orphanedId} HEAD`, {
        cwd: testRepoPath,
      });

      expect(existsSync(worktreePath)).toBe(true);

      await page.goto('/');
      await page.getByRole('heading', { name: 'Neo Lobby' }).first().waitFor({ state: 'visible' });

      await page.waitForTimeout(1000);

      const { stdout } = await execAsync('git worktree list --porcelain', {
        cwd: testRepoPath,
      });
      expect(stdout).toContain('.worktrees/orphaned-test-session');

      await execAsync(`git worktree remove "${worktreePath}"`, {
        cwd: testRepoPath,
      });
      await execAsync(`git branch -D session/${orphanedId}`, {
        cwd: testRepoPath,
      });
    });
  });
