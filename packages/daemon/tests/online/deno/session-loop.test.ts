import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

  beforeEach(async () => {
    daemon = await createDenoDaemonServer();
  }, 180_000);

  afterEach(async () => {
    if (!daemon) return;
    try {
      daemon.kill('SIGTERM');
    } catch {}
    await daemon.waitForExit();
  }, 60_000);

  test('spawns under Deno, creates a worktree session, and delivers an assistant message', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hyperneo-deno-session-'));
    createGitRepo(workspacePath);

    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
      title: 'Deno session loop test',
      worktreeMode: 'worktree',
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    const session = await getSession(daemon, sessionId);
    expect(session.worktree).toBeDefined();
    expect(session.workspacePath).not.toBe(workspacePath);

    await sendMessage(daemon, sessionId, 'Hello from Deno');
    await waitForIdle(daemon, sessionId);

    const result = await waitForSdkMessages(daemon, sessionId, {
      minCount: 2,
      timeout: 15_000,
    });
    expect(result.sdkMessages).toBeDefined();
    expect(Array.isArray(result.sdkMessages)).toBe(true);
    expect(result.sdkMessages.length).toBeGreaterThanOrEqual(2);
    expect(
      result.sdkMessages.some(
        (message) => (message as Record<string, unknown>).type === 'assistant'
      )
    ).toBe(true);
  }, 180_000);
});
