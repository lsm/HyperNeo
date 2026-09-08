import { describe, expect, test, afterEach } from 'bun:test';
import { join } from 'node:path';
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
    const fixturePath = join(import.meta.dir, 'event-loop-watchdog-kill-fixture.ts');
    const proc = Bun.spawn([process.execPath, 'run', fixturePath], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    try {
      const [exitCode, stderrText] = await withTimeout(
        Promise.all([proc.exited, new Response(proc.stderr).text()]),
        10_000,
        'watchdog kill'
      );
      expect(stderrText).toContain('fixture: spinning forever');
      expect(stderrText).toContain('[EventLoopWatchdog] killing daemon');
      expect(exitCode).not.toBe(0);
      expect(exitCode).not.toBe(3);
    } finally {
      proc.kill();
    }
  });
});
