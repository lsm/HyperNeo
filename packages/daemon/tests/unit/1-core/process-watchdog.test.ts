import { describe, expect, test, mock, afterEach } from 'bun:test';
import {
  cleanupSuspiciousProcesses,
  collectDescendantPids,
  parseProcessList,
  parsePsElapsedDuration,
  ProcessWatchdog,
} from '../../../src/lib/process-watchdog';

describe('process-watchdog', () => {
  let watchdog: ProcessWatchdog | null = null;

  afterEach(() => {
    watchdog?.stop();
    watchdog = null;
  });
  test('kills suspicious bun test processes older than threshold', async () => {
    const killProcess = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 100,
          ppid: 1,
          elapsedSeconds: 20 * 60,
          command: 'claude-code-sdk',
        },
        {
          pid: 123,
          ppid: 100,
          elapsedSeconds: 16 * 60,
          command: 'bun test tests/unit/leaky.test.ts',
        },
      ],
      killProcess,
      getRootPids: () => ({ live: [100], exited: [] }),
    });

    expect(killed).toBe(1);
    expect(killProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  test('sends SIGTERM to the process group before killing the suspicious process', async () => {
    const killProcess = mock(() => {});
    const killProcessGroup = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 123,
          ppid: 1,
          pgid: 200,
          elapsedSeconds: 16 * 60,
          command: 'bun test tests/unit/leaky.test.ts',
        },
      ],
      killProcess,
      killProcessGroup,
      getRootPids: () => ({ live: [], exited: [200] }),
    });

    expect(killed).toBe(1);
    expect(killProcessGroup).toHaveBeenCalledWith(200, 'SIGTERM');
    expect(killProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  test('skips group kill when pgid is undefined or zero', async () => {
    const killProcess = mock(() => {});
    const killProcessGroup = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 100,
          ppid: 1,
          pgid: 0,
          elapsedSeconds: 20 * 60,
          command: 'claude-code-sdk',
        },
        {
          pid: 123,
          ppid: 100,
          elapsedSeconds: 16 * 60,
          command: 'bun test tests/unit/leaky.test.ts',
        },
      ],
      killProcess,
      killProcessGroup,
      getRootPids: () => ({ live: [100], exited: [] }),
    });

    expect(killed).toBe(1);
    expect(killProcessGroup).not.toHaveBeenCalled();
    expect(killProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  test('still kills individual PID when killProcessGroup throws', async () => {
    const killProcess = mock(() => {});
    const killProcessGroup = mock(() => {
      throw new Error('group kill failed');
    });

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 123,
          ppid: 1,
          pgid: 200,
          elapsedSeconds: 16 * 60,
          command: 'bun test tests/unit/leaky.test.ts',
        },
      ],
      killProcess,
      killProcessGroup,
      getRootPids: () => ({ live: [], exited: [200] }),
    });

    expect(killed).toBe(1);
    expect(killProcessGroup).toHaveBeenCalledWith(200, 'SIGTERM');
    expect(killProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  test('counts kill as success when group kill terminates the PID (ESRCH)', async () => {
    const killProcess = mock(() => {
      const err = new Error('ESRCH') as Error & { code: string };
      err.code = 'ESRCH';
      throw err;
    });
    const killProcessGroup = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 123,
          ppid: 1,
          pgid: 200,
          elapsedSeconds: 16 * 60,
          command: 'bun test tests/unit/leaky.test.ts',
        },
      ],
      killProcess,
      killProcessGroup,
      getRootPids: () => ({ live: [], exited: [200] }),
    });

    expect(killed).toBe(1);
    expect(killProcessGroup).toHaveBeenCalledWith(200, 'SIGTERM');
    expect(killProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  test('rejects PGID 1 before issuing group SIGTERM', async () => {
    const killProcess = mock(() => {});
    const killProcessGroup = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          elapsedSeconds: 20 * 60,
          command: 'claude-code-sdk',
        },
        {
          pid: 123,
          ppid: 100,
          pgid: 1,
          elapsedSeconds: 16 * 60,
          command: 'bun test tests/unit/leaky.test.ts',
        },
      ],
      killProcess,
      killProcessGroup,
      getRootPids: () => ({ live: [100], exited: [] }),
    });

    expect(killed).toBe(1);
    expect(killProcessGroup).not.toHaveBeenCalled();
    expect(killProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  test('skips group kill when PGID leader is not daemon-owned', async () => {
    const killProcess = mock(() => {});
    const killProcessGroup = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          elapsedSeconds: 20 * 60,
          command: 'claude-code-sdk',
        },
        {
          pid: 123,
          ppid: 100,
          pgid: 500,
          elapsedSeconds: 16 * 60,
          command: 'bun test tests/unit/leaky.test.ts',
        },
      ],
      killProcess,
      killProcessGroup,
      getRootPids: () => ({ live: [100], exited: [] }),
    });

    expect(killed).toBe(1);
    expect(killProcessGroup).not.toHaveBeenCalled();
    expect(killProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  test('skips group kill when exited root PGID is reused by an unrelated process', async () => {
    const killProcess = mock(() => {});
    const killProcessGroup = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          elapsedSeconds: 20 * 60,
          command: 'claude-code-sdk',
        },
        {
          pid: 123,
          ppid: 100,
          pgid: 300,
          elapsedSeconds: 16 * 60,
          command: 'bun test tests/unit/leaky.test.ts',
        },
        {
          pid: 300,
          ppid: 1,
          pgid: 300,
          elapsedSeconds: 30,
          command: 'unrelated-browser',
        },
      ],
      killProcess,
      killProcessGroup,
      getRootPids: () => ({ live: [100], exited: [300] }),
    });

    expect(killed).toBe(1);
    expect(killProcessGroup).not.toHaveBeenCalled();
    expect(killProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  test('skips group kill when PGID is a live daemon root (protects active session)', async () => {
    const killProcess = mock(() => {});
    const killProcessGroup = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          elapsedSeconds: 20 * 60,
          command: 'claude-code-sdk',
        },
        {
          pid: 123,
          ppid: 100,
          pgid: 100,
          elapsedSeconds: 16 * 60,
          command: 'bun test tests/unit/leaky.test.ts',
        },
      ],
      killProcess,
      killProcessGroup,
      getRootPids: () => ({ live: [100], exited: [] }),
    });

    expect(killed).toBe(1);
    expect(killProcessGroup).not.toHaveBeenCalled();
    expect(killProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  test('does not kill short-lived bun test processes', async () => {
    const killProcess = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 456,
          ppid: 100,
          elapsedSeconds: 5 * 60,
          command: 'bun test tests/unit/normal.test.ts',
        },
      ],
      killProcess,
      getRootPids: () => ({ live: [100], exited: [] }),
    });

    expect(killed).toBe(0);
    expect(killProcess).not.toHaveBeenCalled();
  });

  test('allows long-running make dev processes below the dev-server threshold', async () => {
    const killProcess = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 789,
          ppid: 100,
          elapsedSeconds: 2 * 60 * 60,
          command: 'make dev PORT=8484',
        },
      ],
      killProcess,
      getRootPids: () => ({ live: [100], exited: [] }),
    });

    expect(killed).toBe(0);
    expect(killProcess).not.toHaveBeenCalled();
  });

  test('does not kill matching processes outside daemon-owned descendant tree', async () => {
    const killProcess = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 100,
          ppid: 1,
          elapsedSeconds: 20 * 60,
          command: 'claude-code-sdk',
        },
        {
          pid: 999,
          ppid: 1,
          elapsedSeconds: 16 * 60,
          command: 'bun test other-project.test.ts',
        },
      ],
      killProcess,
      getRootPids: () => ({ live: [100], exited: [] }),
    });

    expect(killed).toBe(0);
    expect(killProcess).not.toHaveBeenCalled();
  });

  test('does not kill anything when no daemon roots are registered', async () => {
    const killProcess = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 999,
          ppid: 1,
          elapsedSeconds: 16 * 60,
          command: 'bun test other-project.test.ts',
        },
      ],
      killProcess,
      getRootPids: () => ({ live: [], exited: [] }),
    });

    expect(killed).toBe(0);
    expect(killProcess).not.toHaveBeenCalled();
  });

  test('collects descendants recursively from daemon root pids', () => {
    const descendants = collectDescendantPids(
      [
        { pid: 100, ppid: 1, pgid: 100, elapsedSeconds: 1, command: 'root' },
        { pid: 101, ppid: 100, pgid: 100, elapsedSeconds: 1, command: 'child' },
        { pid: 102, ppid: 101, pgid: 100, elapsedSeconds: 1, command: 'grandchild' },
        { pid: 200, ppid: 1, pgid: 200, elapsedSeconds: 1, command: 'other' },
      ],
      new Set([100]),
      new Set()
    );

    expect(descendants).toEqual(new Set([100, 101, 102]));
  });

  test('retains ownership for orphaned processes in a recently exited root process group', async () => {
    const killProcess = mock(() => {});

    const killed = await cleanupSuspiciousProcesses({
      listProcesses: async () => [
        {
          pid: 321,
          ppid: 1,
          pgid: 100,
          elapsedSeconds: 16 * 60,
          command: 'bun test tests/unit/orphaned.test.ts',
        },
        {
          pid: 999,
          ppid: 1,
          pgid: 999,
          elapsedSeconds: 16 * 60,
          command: 'bun test unrelated.test.ts',
        },
      ],
      killProcess,
      getRootPids: () => ({ live: [], exited: [100] }),
    });

    expect(killed).toBe(1);
    expect(killProcess).toHaveBeenCalledWith(321, 'SIGTERM');
  });

  test('parses BSD ps elapsed durations', () => {
    expect(parsePsElapsedDuration('03:04')).toBe(184);
    expect(parsePsElapsedDuration('02:03:04')).toBe(7384);
    expect(parsePsElapsedDuration('1-02:03:04')).toBe(93784);
  });

  test('parses process list output with BSD duration elapsed field', () => {
    const processes = parseProcessList(
      '  123     1   123 01:02:03 bun test foo.test.ts\n  456   123   123 2-03:04:05 make dev\n',
      'duration'
    );

    expect(processes).toEqual([
      { pid: 123, ppid: 1, pgid: 123, elapsedSeconds: 3723, command: 'bun test foo.test.ts' },
      { pid: 456, ppid: 123, pgid: 123, elapsedSeconds: 183845, command: 'make dev' },
    ]);
  });

  test('skips reused exited root PIDs in descendant collection', () => {
    const descendants = collectDescendantPids(
      [
        { pid: 100, ppid: 1, pgid: 999, elapsedSeconds: 1, command: 'other' },
        { pid: 200, ppid: 1, pgid: 999, elapsedSeconds: 1, command: 'child' },
      ],
      new Set(),
      new Set([100])
    );

    expect(descendants).toEqual(new Set());
  });

  test('finds orphaned children via exited root PGID when root is not reused', () => {
    const descendants = collectDescendantPids(
      [{ pid: 200, ppid: 1, pgid: 100, elapsedSeconds: 1, command: 'orphaned-child' }],
      new Set(),
      new Set([100])
    );

    expect(descendants).toEqual(new Set([200]));
  });

  test('starts only one interval and stops it', async () => {
    let cleanupCalls = 0;
    watchdog = new ProcessWatchdog(5, async () => {
      cleanupCalls++;
      return 0;
    });

    watchdog.start();
    watchdog.start();
    await new Promise((resolve) => setTimeout(resolve, 18));
    watchdog.stop();
    const callsAfterStop = cleanupCalls;
    await new Promise((resolve) => setTimeout(resolve, 12));

    expect(cleanupCalls).toBeGreaterThan(0);
    expect(cleanupCalls).toBe(callsAfterStop);
  });
});
