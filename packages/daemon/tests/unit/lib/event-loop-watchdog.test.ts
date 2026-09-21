import { describe, expect, test, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAndClearEventLoopStallMarker } from '../../../src/lib/event-loop-stall-marker';
import {
  armStallDetectionWhenStartupSettles,
  startEventLoopWatchdog,
  type EventLoopWatchdogHandle,
  type EventLoopWatchdogNotice,
  type StallArmReason,
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

function spawnBunFixture(
  fixtureFileName: string,
  env: Record<string, string> = {}
): SpawnedFixture {
  const fixturePath = fileURLToPath(new URL(`./${fixtureFileName}`, import.meta.url));
  const child = spawn(resolveBunExecutable(), [fixturePath], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...env },
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

  test('defers stall detection through blocking startup until explicitly armed', async () => {
    const notices: EventLoopWatchdogNotice[] = [];
    let resolveNotice: (() => void) | undefined;
    const noticeArrived = new Promise<void>((resolve) => {
      resolveNotice = resolve;
    });
    activeWatchdog = await startEventLoopWatchdog({
      deferStallDetection: true,
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notices).toEqual([]);

    activeWatchdog.armStallDetection();
    blockMainThreadFor(1200);
    await withTimeout(noticeArrived, 5000, 'post-startup stall notice');
    expect(notices[0]?.type).toBe('stall-detected');
  });

  test('reports fuse expiry even before startup arms stall detection', async () => {
    const notices: EventLoopWatchdogNotice[] = [];
    let resolveNotice: (() => void) | undefined;
    const noticeArrived = new Promise<void>((resolve) => {
      resolveNotice = resolve;
    });
    activeWatchdog = await startEventLoopWatchdog({
      deferStallDetection: true,
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

  test('kills a process whose event loop spins forever when sigkill is opted into', async () => {
    const markerPath = join(tmpdir(), `watchdog-marker-${process.pid}-${Date.now()}.json`);
    const { child, closed, stderrText } = spawnBunFixture('event-loop-watchdog-kill-fixture.ts', {
      WATCHDOG_MARKER_PATH: markerPath,
    });
    try {
      const outcome = await withTimeout(closed, 10_000, 'watchdog kill');
      expect(stderrText()).toContain('fixture: spinning forever');
      expect(stderrText()).toContain('[EventLoopWatchdog] killing daemon');
      expect(outcome.signal).toBe('SIGKILL');

      const marker = readAndClearEventLoopStallMarker(markerPath);
      expect(marker).toMatchObject({ action: 'killed', pid: child.pid });
      expect(marker?.reason).toContain('event loop stalled');
      expect(readAndClearEventLoopStallMarker(markerPath)).toBeNull();
    } finally {
      child.kill('SIGKILL');
      rmSync(markerPath, { force: true });
    }
  }, 12_000);

  test('a spinning process is left alive by default and still leaves a marker', async () => {
    const markerPath = join(tmpdir(), `watchdog-observe-${process.pid}-${Date.now()}.json`);
    const { child, stderrText } = spawnBunFixture('event-loop-watchdog-observe-fixture.ts', {
      WATCHDOG_MARKER_PATH: markerPath,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(child.kill(0)).toBe(true);
      expect(stderrText()).toContain('[EventLoopWatchdog] daemon pid=');
      expect(stderrText()).not.toContain('killing daemon');
      expect(readAndClearEventLoopStallMarker(markerPath)).toMatchObject({ action: 'observed' });
    } finally {
      child.kill('SIGKILL');
      rmSync(markerPath, { force: true });
    }
  }, 12_000);

  test('survives whole-process suspension longer than the stall threshold', async () => {
    if (process.platform === 'win32') return;
    const { child } = spawnBunFixture('event-loop-watchdog-suspend-fixture.ts');
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(child.kill(0)).toBe(true);

      child.kill('SIGSTOP');
      await new Promise((resolve) => setTimeout(resolve, 1300));
      child.kill('SIGCONT');
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(child.kill(0)).toBe(true);
    } finally {
      child.kill('SIGCONT');
      child.kill('SIGKILL');
    }
  }, 10_000);
});

describe('armStallDetectionWhenStartupSettles', () => {
  function fakeHandle() {
    const calls: string[] = [];
    const handle = {
      armStallDetection: () => calls.push('arm'),
      armShutdownFuse: () => {},
      stop: () => {},
    } as EventLoopWatchdogHandle;
    return { handle, calls };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('arms once the startup work settles, not when createDaemonApp returns', async () => {
    const { handle, calls } = fakeHandle();
    let finishStartup: (() => void) | undefined;
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const reasons: StallArmReason[] = [];

    armStallDetectionWhenStartupSettles(handle, startup, {
      graceMs: 60_000,
      onArm: (reason) => reasons.push(reason),
    });
    await settle();
    expect(calls).toEqual([]);

    finishStartup?.();
    await settle();

    expect(calls).toEqual(['arm']);
    expect(reasons).toEqual(['startup_settled']);
  });

  test('startup work that fails still arms rather than leaving the daemon unguarded', async () => {
    const { handle, calls } = fakeHandle();

    armStallDetectionWhenStartupSettles(handle, Promise.reject(new Error('provisioning failed')), {
      graceMs: 60_000,
    });
    await settle();

    expect(calls).toEqual(['arm']);
  });

  test('startup work that never settles arms on the grace backstop', async () => {
    const { handle, calls } = fakeHandle();
    const reasons: StallArmReason[] = [];

    armStallDetectionWhenStartupSettles(handle, new Promise<void>(() => {}), {
      graceMs: 10,
      onArm: (reason) => reasons.push(reason),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(calls).toEqual(['arm']);
    expect(reasons).toEqual(['grace_expired']);
  });

  test('a late settle after the backstop does not arm a second time', async () => {
    const { handle, calls } = fakeHandle();
    let finishStartup: (() => void) | undefined;
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const reasons: StallArmReason[] = [];

    armStallDetectionWhenStartupSettles(handle, startup, {
      graceMs: 10,
      onArm: (reason) => reasons.push(reason),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    finishStartup?.();
    await settle();

    expect(calls).toEqual(['arm']);
    expect(reasons).toEqual(['grace_expired']);
  });

  test('a disabled watchdog is a no-op rather than a crash', async () => {
    expect(() =>
      armStallDetectionWhenStartupSettles(null, Promise.resolve(), { graceMs: 10 })
    ).not.toThrow();
    await settle();
  });
});
