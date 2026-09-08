import { describe, expect, test, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startEventLoopWatchdog,
  type EventLoopWatchdogHandle,
  type EventLoopWatchdogNotice,
} from '../../../src/lib/event-loop-watchdog';

function blockMainThreadFor(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {}
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function resolveBunExecutable(): string {
  if (basename(process.execPath).startsWith('bun')) return process.execPath;
  const bunInstall = process.env.BUN_INSTALL ?? join(homedir(), '.bun');
  const candidate = join(bunInstall, 'bin', 'bun');
  if (existsSync(candidate)) return candidate;
  return 'bun';
}

interface SpawnedFixture {
  child: ReturnType<typeof spawn>;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderrText: () => string;
}

function spawnBunFixture(fixtureFileName: string): SpawnedFixture {
  const fixturePath = fileURLToPath(new URL(`./${fixtureFileName}`, import.meta.url));
  const child = spawn(resolveBunExecutable(), [fixturePath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
      child.on('error', reject);
    }
  );
  return { child, closed, stderrText: () => Buffer.concat(stderrChunks).toString('utf-8') };
}

describe('event-loop-watchdog', () => {
  let activeWatchdog: EventLoopWatchdogHandle | null = null;

  afterEach(() => {
    activeWatchdog?.stop();
    activeWatchdog = null;
  });

  test('does not report a stall while heartbeats flow', async () => {
    const notices: EventLoopWatchdogNotice[] = [];
    activeWatchdog = await startEventLoopWatchdog({
      stallMs: 1500,
      heartbeatMs: 25,
      killMode: 'observe',
      onNotice: (notice) => notices.push(notice),
    });
    if (!activeWatchdog) throw new Error('watchdog failed to start');

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(notices).toEqual([]);
  });

  test('reports a stall when the main event loop stops delivering heartbeats', async () => {
    const notices: EventLoopWatchdogNotice[] = [];
    let resolveNotice: (() => void) | undefined;
    const noticeArrived = new Promise<void>((resolve) => {
      resolveNotice = resolve;
    });
    activeWatchdog = await startEventLoopWatchdog({
      stallMs: 400,
      heartbeatMs: 25,
      killMode: 'observe',
      onNotice: (notice) => {
        notices.push(notice);
        resolveNotice?.();
      },
    });
    if (!activeWatchdog) throw new Error('watchdog failed to start');

    blockMainThreadFor(1200);
    await withTimeout(noticeArrived, 5000, 'stall notice');

    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0]?.type).toBe('stall-detected');
    if (notices[0]?.type === 'stall-detected') {
      expect(notices[0].stalledForMs).toBeGreaterThanOrEqual(400);
    }
  });

  test('reports fuse expiry while the event loop stays healthy', async () => {
    const notices: EventLoopWatchdogNotice[] = [];
    let resolveNotice: (() => void) | undefined;
    const noticeArrived = new Promise<void>((resolve) => {
      resolveNotice = resolve;
    });
    activeWatchdog = await startEventLoopWatchdog({
      stallMs: 60_000,
      heartbeatMs: 25,
      shutdownFuseMs: 300,
      killMode: 'observe',
      onNotice: (notice) => {
        notices.push(notice);
        resolveNotice?.();
      },
    });
    if (!activeWatchdog) throw new Error('watchdog failed to start');

    activeWatchdog.armShutdownFuse(300);
    await withTimeout(noticeArrived, 5000, 'fuse notice');

    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0]?.type).toBe('fuse-expired');
    if (notices[0]?.type === 'fuse-expired') {
      expect(notices[0].overdueMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('arming the fuse after stop is inert', async () => {
    const notices: EventLoopWatchdogNotice[] = [];
    activeWatchdog = await startEventLoopWatchdog({
      stallMs: 60_000,
      heartbeatMs: 25,
      shutdownFuseMs: 50,
      killMode: 'observe',
      onNotice: (notice) => notices.push(notice),
    });
    if (!activeWatchdog) throw new Error('watchdog failed to start');

    activeWatchdog.stop();
    activeWatchdog.armShutdownFuse(50);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(notices).toEqual([]);
  });

  test('returns null when disabled via environment', async () => {
    const previous = process.env.HYPERNEO_DISABLE_EVENT_LOOP_WATCHDOG;
    process.env.HYPERNEO_DISABLE_EVENT_LOOP_WATCHDOG = '1';
    try {
      const watchdog = await startEventLoopWatchdog();
      expect(watchdog).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.HYPERNEO_DISABLE_EVENT_LOOP_WATCHDOG;
      } else {
        process.env.HYPERNEO_DISABLE_EVENT_LOOP_WATCHDOG = previous;
      }
    }
  });

  test('kills a process whose event loop spins forever', async () => {
    const { child, closed, stderrText } = spawnBunFixture('event-loop-watchdog-kill-fixture.ts');
    try {
      const outcome = await withTimeout(closed, 10_000, 'watchdog kill');
      expect(stderrText()).toContain('fixture: spinning forever');
      expect(stderrText()).toContain('[EventLoopWatchdog] killing daemon');
      expect(outcome.signal).toBe('SIGKILL');
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('survives whole-process suspension longer than the stall threshold', async () => {
    if (process.platform === 'win32') return;
    const { child } = spawnBunFixture('event-loop-watchdog-suspend-fixture.ts');
    try {
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(child.kill(0)).toBe(true);

      child.kill('SIGSTOP');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      child.kill('SIGCONT');
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(child.kill(0)).toBe(true);
    } finally {
      child.kill('SIGCONT');
      child.kill('SIGKILL');
    }
  });
});
