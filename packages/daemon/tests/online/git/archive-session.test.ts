/**
 * Archive Session Tests
 *
 * These tests use the REAL Claude Agent SDK with actual API credentials.
 * They verify session.archive RPC with real git worktrees via WebSocket:
 * - Archive without worktree (direct archive)
 * - Archive with worktree (no commits ahead)
 * - Archive with worktree (commits ahead, requires confirmation)
 * - Squash-merge detection
 * - Error handling and idempotency
 *
 * MODES:
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Dev Proxy: Set HYPERNEO_USE_DEV_PROXY=1 for offline testing with mocked responses
 *
 * Run with Dev Proxy:
 *   cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/git/archive-session.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

// Detect mock mode for faster timeouts (Dev Proxy)
const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const SETUP_TIMEOUT = IS_MOCK ? 10000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 90000;

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Archive Session', () => {
  let daemon: DaemonServerContext;

  // Worktree tests need longer hook timeouts on CI (daemon cleanup after worktree ops)
  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (!daemon) return;
    await daemon.waitForExit();
  }, SETUP_TIMEOUT);

  async function createSession(workspacePath: string): Promise<string> {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
    })) as { sessionId: string };
    daemon.trackSession(sessionId);
    return sessionId;
  }

  async function getSession(sessionId: string): Promise<Record<string, unknown>> {
    const { session } = (await daemon.messageHub.request('session.get', {
      sessionId,
    })) as { session: Record<string, unknown> };
    return session;
  }

  async function archiveSession(
    sessionId: string,
    confirmed = false
  ): Promise<Record<string, unknown>> {
    return (await daemon.messageHub.request('session.archive', {
      sessionId,
      confirmed,
    })) as Record<string, unknown>;
  }

  function createGitRepo(): string {
    const repoPath = path.join(
      TMP_DIR,
      `test-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(repoPath, { recursive: true });
    execSync('git init', { cwd: repoPath });
    execSync('git config user.email "test@test.com"', { cwd: repoPath });
    execSync('git config user.name "Test User"', { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test');
    execSync('git add .', { cwd: repoPath });
    execSync('git commit -m "Initial commit"', { cwd: repoPath });
    execSync('git branch -M main', { cwd: repoPath });
    return repoPath;
  }

  async function createSessionWithWorktree(
    repoPath: string
  ): Promise<{ sessionId: string; worktreePath: string; branch: string }> {
    const sessionId = await createSession(repoPath);

    // Choose worktree mode
    await daemon.messageHub.request('session.setWorktreeMode', {
      sessionId,
      mode: 'worktree',
    });

    // Get session to find worktree path (worktree was created synchronously by setWorktreeMode)
    const session = await getSession(sessionId);
    const worktree = session.worktree as { worktreePath: string; branch: string } | undefined;

    expect(worktree).toBeDefined();
    expect(fs.existsSync(worktree!.worktreePath)).toBe(true);

    return {
      sessionId,
      worktreePath: worktree!.worktreePath,
      branch: worktree!.branch,
    };
  }

  describe('Without worktree', () => {
    test('should archive session directly', async () => {
      const tmpPath = `${TMP_DIR}/test-no-worktree-${Date.now()}`;
      const sessionId = await createSession(tmpPath);

      const result = await archiveSession(sessionId);

      expect(result.success).toBe(true);
      expect(result.requiresConfirmation).toBe(false);

      const session = await getSession(sessionId);
      expect(session.status).toBe('archived');
      expect(session.archivedAt).toBeString();

      // Verify archivedAt is a valid ISO timestamp
      const archivedDate = new Date(session.archivedAt as string);
      expect(archivedDate.getTime()).toBeGreaterThan(0);
    });
  });

  describe('With worktree (no commits ahead)', () => {
    test(
      'should archive without confirmation',
      async () => {
        const repoPath = createGitRepo();

        try {
          const { sessionId } = await createSessionWithWorktree(repoPath);

          // Archive without confirmation (no commits ahead)
          const result = await archiveSession(sessionId, false);

          expect(result.success).toBe(true);
          expect(result.requiresConfirmation).toBe(false);

          // Verify session is archived
          const session = await getSession(sessionId);
          expect(session.status).toBe('archived');
          expect(session.archivedAt).toBeString();
          expect(session.worktree).toBeUndefined();
        } finally {
          fs.rmSync(repoPath, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT
    );
  });

  describe('With worktree (commits ahead)', () => {
    test(
      'should require confirmation when commits ahead',
      async () => {
        const repoPath = createGitRepo();

        try {
          const { sessionId, worktreePath } = await createSessionWithWorktree(repoPath);

          // Make a commit in the worktree
          fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'new feature');
          execSync('git add .', { cwd: worktreePath });
          execSync('git commit -m "Add new feature"', { cwd: worktreePath });

          // Try to archive without confirmation
          const result = await archiveSession(sessionId, false);

          expect(result.success).toBe(false);
          expect(result.requiresConfirmation).toBe(true);
          expect(result.commitStatus).toBeDefined();

          const commitStatus = result.commitStatus as {
            hasCommitsAhead: boolean;
            commits: Array<{ message: string; author: string; hash: string; date: string }>;
          };
          expect(commitStatus.hasCommitsAhead).toBe(true);
          expect(commitStatus.commits.length).toBe(1);
          expect(commitStatus.commits[0].message).toBe('Add new feature');
          expect(commitStatus.commits[0].author).toBe('Test User');

          // Session should still be active
          const session = await getSession(sessionId);
          expect(session.status).toBe('active');
        } finally {
          fs.rmSync(repoPath, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT
    );

    test(
      'should archive after confirmation even with commits ahead',
      async () => {
        const repoPath = createGitRepo();

        try {
          const { sessionId, worktreePath } = await createSessionWithWorktree(repoPath);

          // Make multiple commits
          fs.writeFileSync(path.join(worktreePath, 'file1.txt'), 'content 1');
          execSync('git add .', { cwd: worktreePath });
          execSync('git commit -m "First change"', { cwd: worktreePath });

          fs.writeFileSync(path.join(worktreePath, 'file2.txt'), 'content 2');
          execSync('git add .', { cwd: worktreePath });
          execSync('git commit -m "Second change"', { cwd: worktreePath });

          // Archive with confirmation
          const result = await archiveSession(sessionId, true);

          expect(result.success).toBe(true);
          expect(result.requiresConfirmation).toBe(false);
          expect(result.commitsRemoved).toBe(2);

          const session = await getSession(sessionId);
          expect(session.status).toBe('archived');
          expect(session.worktree).toBeUndefined();
        } finally {
          fs.rmSync(repoPath, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT
    );
  });

  describe('Squash-merge detection', () => {
    test(
      'should NOT require confirmation when commits are squash-merged',
      async () => {
        const repoPath = createGitRepo();

        try {
          const { sessionId, worktreePath, branch } = await createSessionWithWorktree(repoPath);

          // Make commits in worktree
          fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'feature code');
          execSync('git add .', { cwd: worktreePath });
          execSync('git commit -m "Add feature"', { cwd: worktreePath });

          fs.writeFileSync(path.join(worktreePath, 'feature2.txt'), 'more code');
          execSync('git add .', { cwd: worktreePath });
          execSync('git commit -m "Add more feature"', { cwd: worktreePath });

          // Simulate squash merge to main
          execSync('git checkout main', { cwd: repoPath });
          execSync(`git merge --squash refs/heads/${branch}`, { cwd: repoPath });
          execSync('git commit -m "feat: add feature (squash merged)"', { cwd: repoPath });

          // Archive should NOT require confirmation
          const result = await archiveSession(sessionId, false);

          expect(result.success).toBe(true);
          expect(result.requiresConfirmation).toBe(false);
        } finally {
          fs.rmSync(repoPath, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT
    );

    test(
      'should require confirmation when new commits exist after squash merge',
      async () => {
        const repoPath = createGitRepo();

        try {
          const { sessionId, worktreePath, branch } = await createSessionWithWorktree(repoPath);

          // Make initial commit
          fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'feature code');
          execSync('git add .', { cwd: worktreePath });
          execSync('git commit -m "Add feature"', { cwd: worktreePath });

          // Squash merge to main
          execSync('git checkout main', { cwd: repoPath });
          execSync(`git merge --squash refs/heads/${branch}`, { cwd: repoPath });
          execSync('git commit -m "feat: add feature (squash merged)"', { cwd: repoPath });

          // Make another commit in worktree (new work not on main)
          fs.writeFileSync(path.join(worktreePath, 'new-work.txt'), 'new work');
          execSync('git add .', { cwd: worktreePath });
          execSync('git commit -m "Add new work"', { cwd: worktreePath });

          // Should require confirmation — new work not on main
          const result = await archiveSession(sessionId, false);

          expect(result.success).toBe(false);
          expect(result.requiresConfirmation).toBe(true);
          const commitStatus = result.commitStatus as {
            hasCommitsAhead: boolean;
            commits: Array<{ message: string }>;
          };
          expect(commitStatus.hasCommitsAhead).toBe(true);
          const hasNewWork = commitStatus.commits.some((c) => c.message === 'Add new work');
          expect(hasNewWork).toBe(true);
        } finally {
          fs.rmSync(repoPath, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT
    );
  });

  describe('Error handling', () => {
    test('should return error for non-existent session', async () => {
      await expect(archiveSession('non-existent-id')).rejects.toThrow('Session not found');
    });

    test('should handle already archived session gracefully', async () => {
      const tmpPath = `${TMP_DIR}/test-already-archived-${Date.now()}`;
      const sessionId = await createSession(tmpPath);

      await archiveSession(sessionId);

      // Archive again — should be idempotent
      const result = await archiveSession(sessionId);
      expect(result.success).toBe(true);
    });
  });

  describe('Archived session behavior', () => {
    test('should be retrievable via session.get', async () => {
      const tmpPath = `${TMP_DIR}/test-get-archived-${Date.now()}`;
      const sessionId = await createSession(tmpPath);

      await archiveSession(sessionId);

      const session = await getSession(sessionId);
      expect(session.id).toBe(sessionId);
      expect(session.status).toBe('archived');
      expect(session.archivedAt).toBeString();
    });

    test('should appear in session.list with status filter', async () => {
      const tmpPath = `${TMP_DIR}/test-list-archived-${Date.now()}`;
      const sessionId = await createSession(tmpPath);

      await archiveSession(sessionId);

      // Default list should NOT include archived sessions
      const defaultResult = (await daemon.messageHub.request('session.list', {})) as {
        sessions: Array<{ id: string }>;
      };
      expect(defaultResult.sessions.find((s) => s.id === sessionId)).toBeUndefined();

      // Filter by status=archived should include it
      const archivedResult = (await daemon.messageHub.request('session.list', {
        status: 'archived',
      })) as { sessions: Array<{ id: string; status: string }> };
      const found = archivedResult.sessions.find((s) => s.id === sessionId);
      expect(found).toBeDefined();
      expect(found!.status).toBe('archived');
    });

    test('should preserve metadata after archiving', async () => {
      const tmpPath = `${TMP_DIR}/test-metadata-${Date.now()}`;
      const sessionId = await createSession(tmpPath);

      // Update metadata before archiving
      await daemon.messageHub.request('session.update', {
        sessionId,
        title: 'Test Session Title',
        metadata: {
          messageCount: 5,
          titleGenerated: true,
        },
      });

      await archiveSession(sessionId);

      const session = await getSession(sessionId);
      expect(session.title).toBe('Test Session Title');
      const metadata = session.metadata as Record<string, unknown>;
      expect(metadata.messageCount).toBe(5);
      expect(metadata.titleGenerated).toBe(true);
    });
  });
});
