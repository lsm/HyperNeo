import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getSession,
  sendMessage,
  waitForIdle,
  waitForSdkMessages,
} from '../../helpers/daemon-actions';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDenoDaemonServer } from '../../helpers/deno-daemon-server';

function isDeno2Point9(): boolean {
  try {
    const result = spawnSync('deno', ['--version'], { encoding: 'utf-8' });
    if (result.status !== 0 || !result.stdout) {
      return false;
    }
    const firstLine = result.stdout.split('\n')[0] ?? '';
    return firstLine.startsWith('deno 2.9');
  } catch {
    return false;
  }
}

function createGitRepo(path: string): void {
  const initResult = spawnSync('git', ['init'], { cwd: path });
  if (initResult.status !== 0) {
    throw new Error(`git init failed: ${initResult.stderr?.toString() ?? ''}`);
  }
  const commitResult = spawnSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    ],
    { cwd: path }
  );
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr?.toString() ?? ''}`);
  }
}

const hasDeno = isDeno2Point9();

(hasDeno ? describe : describe.skip)('Deno daemon session loop', () => {
  let daemon: DaemonServerContext;
  let testWorkspacePath = '';

  beforeEach(async () => {
    daemon = await createDenoDaemonServer();
  }, 180_000);

  afterEach(async () => {
    try {
      if (daemon) {
        try {
          daemon.kill('SIGTERM');
        } catch {}
        await daemon.waitForExit();
      }
    } finally {
      if (testWorkspacePath) {
        rmSync(testWorkspacePath, { recursive: true, force: true });
        testWorkspacePath = '';
      }
    }
  }, 60_000);

  test('spawns under Deno, creates a worktree session, and delivers an assistant message', async () => {
    testWorkspacePath = mkdtempSync(join(tmpdir(), 'hyperneo-deno-session-'));
    createGitRepo(testWorkspacePath);

    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath: testWorkspacePath,
      title: 'Deno session loop test',
      worktreeMode: 'worktree',
      config: {
        model: 'sonnet',
        provider: 'anthropic',
        permissionMode: 'acceptEdits',
      },
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    const session = await getSession(daemon, sessionId);
    const worktree = session.worktree as Record<string, unknown> | undefined;
    expect(worktree).toBeDefined();
    expect(worktree?.isWorktree).toBe(true);
    expect(typeof worktree?.worktreePath).toBe('string');
    expect(worktree?.worktreePath).not.toBe(testWorkspacePath);
    expect(session.workspacePath).toBe(worktree?.worktreePath);

    await sendMessage(daemon, sessionId, 'Hello from Deno');
    await waitForIdle(daemon, sessionId);

    const result = await waitForSdkMessages(daemon, sessionId, {
      minCount: 2,
      timeout: 15_000,
    });
    expect(result.sdkMessages).toBeDefined();
    expect(Array.isArray(result.sdkMessages)).toBe(true);
    expect(result.sdkMessages.length).toBeGreaterThanOrEqual(2);

    const assistant = result.sdkMessages.find(
      (message) => (message as Record<string, unknown>).type === 'assistant'
    ) as Record<string, unknown> | undefined;
    expect(assistant).toBeDefined();

    const messageBody = assistant?.message as Record<string, unknown> | undefined;
    const content = messageBody?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const textBlock = content.find(
        (block) => (block as Record<string, unknown>).type === 'text'
      ) as Record<string, unknown> | undefined;
      text = (textBlock?.text as string) ?? '';
    }
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  }, 180_000);
});
