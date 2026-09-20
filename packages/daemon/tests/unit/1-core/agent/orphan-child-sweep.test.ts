import { expect, mock, test } from 'bun:test';
import type { ProcessSnapshot } from '../../../../src/lib/process-watchdog';
import {
  decideOrphanChildKill,
  ORPHAN_START_TIME_TOLERANCE_MS,
  planOrphanChildSweep,
  killProcessGroupThenPid,
  sweepOrphanedAgentChildren,
  type PersistedAgentChild,
} from '../../../../src/lib/agent/orphan-child-sweep';
import { canListProcesses, listProcesses } from '../../../../src/lib/process-watchdog';
import { AgentChildProcessRepository } from '../../../../src/storage/repositories/agent-child-process-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runMigration264 } from '../../../../src/storage/schema/m264-agent-child-processes';

const NOW = 1_700_000_000_000;
const DAEMON = 999;

function child(overrides: Partial<PersistedAgentChild> = {}): PersistedAgentChild {
  return {
    pid: 4242,
    sessionId: 'sess-1',
    command: '/usr/local/bin/claude',
    startedAt: NOW - 60_000,
    daemonPid: 111,
    ...overrides,
  };
}

function snap(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    pid: 4242,
    ppid: 1,
    elapsedSeconds: 60,
    command: '/usr/local/bin/claude --model sonnet',
    ...overrides,
  };
}

function repoWithRows(rows: PersistedAgentChild[]) {
  const db = new Database(':memory:');
  runMigration264(db);
  const repo = new AgentChildProcessRepository(db);
  for (const row of rows) repo.record(row);
  return { db, repo };
}

test('a surviving child with a matching start time and command is killed', () => {
  expect(
    decideOrphanChildKill({
      child: child(),
      observed: snap(),
      now: NOW,
      toleranceMs: ORPHAN_START_TIME_TOLERANCE_MS,
      currentDaemonPid: DAEMON,
    })
  ).toEqual({ value: 4242 });
});

test('a pid that is no longer running is left alone', () => {
  expect(
    decideOrphanChildKill({
      child: child(),
      observed: undefined,
      now: NOW,
      toleranceMs: ORPHAN_START_TIME_TOLERANCE_MS,
      currentDaemonPid: DAEMON,
    })
  ).toEqual({ reason: 'not_running' });
});

test('a reused pid is left alone because its start time does not match', () => {
  expect(
    decideOrphanChildKill({
      child: child(),
      observed: snap({ elapsedSeconds: 5 }),
      now: NOW,
      toleranceMs: ORPHAN_START_TIME_TOLERANCE_MS,
      currentDaemonPid: DAEMON,
    })
  ).toEqual({ reason: 'start_time_mismatch' });
});

test('a pid running something else is left alone even when the clock agrees', () => {
  expect(
    decideOrphanChildKill({
      child: child(),
      observed: snap({ command: '/usr/bin/ssh tts' }),
      now: NOW,
      toleranceMs: ORPHAN_START_TIME_TOLERANCE_MS,
      currentDaemonPid: DAEMON,
    })
  ).toEqual({ reason: 'command_mismatch' });
});

test('an empty recorded command never matches', () => {
  expect(
    decideOrphanChildKill({
      child: child({ command: '' }),
      observed: snap(),
      now: NOW,
      toleranceMs: ORPHAN_START_TIME_TOLERANCE_MS,
      currentDaemonPid: DAEMON,
    })
  ).toEqual({ reason: 'command_mismatch' });
});

test('second-granularity clock skew inside the tolerance still matches', () => {
  for (const elapsedSeconds of [55, 60, 65]) {
    expect(
      decideOrphanChildKill({
        child: child(),
        observed: snap({ elapsedSeconds }),
        now: NOW,
        toleranceMs: ORPHAN_START_TIME_TOLERANCE_MS,
        currentDaemonPid: DAEMON,
      })
    ).toEqual({ value: 4242 });
  }
});

test('the plan partitions survivors from every skip reason', () => {
  const plan = planOrphanChildSweep(
    [
      child({ pid: 1 }),
      child({ pid: 2 }),
      child({ pid: 3 }),
      child({ pid: 4, command: '/usr/local/bin/claude' }),
    ],
    [snap({ pid: 1 }), snap({ pid: 3, elapsedSeconds: 5 }), snap({ pid: 4, command: '/bin/zsh' })],
    NOW,
    DAEMON
  );
  expect(plan).toEqual({
    kill: [1],
    skipped: [
      { pid: 2, reason: 'not_running' },
      { pid: 3, reason: 'start_time_mismatch' },
      { pid: 4, reason: 'command_mismatch' },
    ],
  });
});

test('the sweep kills survivors and clears the record so it runs once', async () => {
  const { db, repo } = repoWithRows([child({ pid: 1 }), child({ pid: 2 })]);
  const kill = mock(() => {});

  await sweepOrphanedAgentChildren(
    repo,
    () => {},
    () => {},
    {
      list: async () => [snap({ pid: 1 })],
      kill,
      now: () => NOW,
    }
  );

  expect(kill).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledWith(1);
  expect(repo.list()).toEqual([]);
  db.close();
});

test('the record is kept when the process list cannot be read', async () => {
  const { db, repo } = repoWithRows([child({ pid: 1 })]);
  const kill = mock(() => {});
  const logError = mock(() => {});

  await sweepOrphanedAgentChildren(repo, () => {}, logError, {
    list: async () => {
      throw new Error('ps unavailable');
    },
    kill,
    now: () => NOW,
  });

  expect(kill).not.toHaveBeenCalled();
  expect(logError).toHaveBeenCalled();
  expect(repo.list()).toHaveLength(1);
  db.close();
});

test('a kill that throws does not abandon the rest of the sweep', async () => {
  const { db, repo } = repoWithRows([child({ pid: 1 }), child({ pid: 2 })]);
  const killed: number[] = [];

  await sweepOrphanedAgentChildren(
    repo,
    () => {},
    () => {},
    {
      list: async () => [snap({ pid: 1 }), snap({ pid: 2 })],
      kill: (pid) => {
        if (pid === 1) throw new Error('ESRCH');
        killed.push(pid);
      },
      now: () => NOW,
    }
  );

  expect(killed).toEqual([2]);
  expect(repo.list()).toEqual([]);
  db.close();
});

test('nothing recorded means no process listing at all', async () => {
  const { db, repo } = repoWithRows([]);
  const list = mock(async () => []);

  await sweepOrphanedAgentChildren(
    repo,
    () => {},
    () => {},
    { list, now: () => NOW }
  );

  expect(list).not.toHaveBeenCalled();
  db.close();
});

test('the repository round-trips a child and forgets it on exit', () => {
  const { db, repo } = repoWithRows([]);
  repo.record(child({ pid: 7 }));
  expect(repo.list()).toEqual([child({ pid: 7 })]);

  repo.record(child({ pid: 7, sessionId: 'sess-2', startedAt: NOW }));
  expect(repo.list()).toEqual([child({ pid: 7, sessionId: 'sess-2', startedAt: NOW })]);

  repo.forget(7);
  expect(repo.list()).toEqual([]);
  db.close();
});

test('an orphan is killed by process group, falling back to the bare pid', () => {
  const calls: Array<[number, string]> = [];
  const original = process.kill;
  try {
    (process as { kill: unknown }).kill = (pid: number, signal: string) => {
      calls.push([pid, signal]);
      if (pid < 0 && calls.length === 1) throw new Error('ESRCH');
      return true;
    };
    killProcessGroupThenPid(4242);
    expect(calls).toEqual([
      [-4242, 'SIGKILL'],
      [4242, 'SIGKILL'],
    ]);

    calls.length = 0;
    (process as { kill: unknown }).kill = (pid: number, signal: string) => {
      calls.push([pid, signal]);
      return true;
    };
    killProcessGroupThenPid(777);
    expect(calls).toEqual([[-777, 'SIGKILL']]);
  } finally {
    (process as { kill: unknown }).kill = original;
  }
});

test('a child recorded while ps is running survives the sweep (#4904 review)', async () => {
  const { db, repo } = repoWithRows([child({ pid: 1 }), child({ pid: 2 })]);
  const killed: number[] = [];

  await sweepOrphanedAgentChildren(
    repo,
    () => {},
    () => {},
    {
      list: async () => {
        repo.record(child({ pid: 3, sessionId: 'spawned-during-ps' }));
        return [snap({ pid: 1 }), snap({ pid: 3 })];
      },
      kill: (pid) => killed.push(pid),
      now: () => NOW,
    }
  );

  expect(killed).toEqual([1]);
  expect(repo.list()).toEqual([child({ pid: 3, sessionId: 'spawned-during-ps' })]);
  db.close();
});

test('forgetMany removes only the pids it is given', () => {
  const { db, repo } = repoWithRows([child({ pid: 1 }), child({ pid: 2 }), child({ pid: 3 })]);

  repo.forgetMany([]);
  expect(repo.list()).toHaveLength(3);

  repo.forgetMany([1, 3]);
  expect(repo.list().map((row) => row.pid)).toEqual([2]);
  db.close();
});

test('a failed record delete keeps the rows and does not abort boot (#4904 review)', async () => {
  const { db, repo } = repoWithRows([child({ pid: 1 })]);
  const logError = mock(() => {});
  repo.forgetMany = () => {
    throw new Error('SQLITE_BUSY');
  };

  await sweepOrphanedAgentChildren(repo, () => {}, logError, {
    list: async () => [snap({ pid: 1 })],
    kill: () => {},
    now: () => NOW,
  });

  expect(logError).toHaveBeenCalled();
  expect(new AgentChildProcessRepository(db).list()).toHaveLength(1);
  db.close();
});

test('the sweep swallows any failure, not only the ones it names', async () => {
  const { db, repo } = repoWithRows([child({ pid: 1 })]);
  const logError = mock(() => {});

  await expect(
    sweepOrphanedAgentChildren(repo, () => {}, logError, {
      list: async () => [snap({ pid: 1 })],
      now: () => {
        throw new Error('clock exploded');
      },
    })
  ).resolves.toBeUndefined();

  expect(logError).toHaveBeenCalled();
  expect(new AgentChildProcessRepository(db).list()).toHaveLength(1);
  db.close();
});

test('a row this daemon wrote is never a sweep candidate (#4904 review)', () => {
  expect(
    decideOrphanChildKill({
      child: child({ daemonPid: DAEMON }),
      observed: snap(),
      now: NOW,
      toleranceMs: ORPHAN_START_TIME_TOLERANCE_MS,
      currentDaemonPid: DAEMON,
    })
  ).toEqual({ reason: 'own_record' });
});

test('a process that is currently our own child is never killed (#4904 review)', () => {
  expect(
    decideOrphanChildKill({
      child: child(),
      observed: snap({ ppid: DAEMON }),
      now: NOW,
      toleranceMs: ORPHAN_START_TIME_TOLERANCE_MS,
      currentDaemonPid: DAEMON,
    })
  ).toEqual({ reason: 'own_child' });
});

test('a reused pid respawned by this daemon survives a crash-loop restart (#4904 review)', async () => {
  const { db, repo } = repoWithRows([child({ pid: 4242, daemonPid: 111 })]);
  const killed: number[] = [];

  await sweepOrphanedAgentChildren(
    repo,
    () => {},
    () => {},
    {
      list: async () => [snap({ pid: 4242, ppid: process.pid, elapsedSeconds: 60 })],
      kill: (pid) => killed.push(pid),
      now: () => NOW,
    }
  );

  expect(killed).toEqual([]);
  db.close();
});

test('the sweep leaves rows written by the running daemon in place', async () => {
  const { db, repo } = repoWithRows([child({ pid: 1, daemonPid: 111 })]);
  repo.record(child({ pid: 2, daemonPid: process.pid, sessionId: 'spawned-now' }));

  await sweepOrphanedAgentChildren(
    repo,
    () => {},
    () => {},
    {
      list: async () => [snap({ pid: 1 }), snap({ pid: 2 })],
      kill: () => {},
      now: () => NOW,
    }
  );

  expect(repo.list().map((row) => row.pid)).toEqual([2]);
  db.close();
});

test('a platform that cannot enumerate processes keeps its records (#4904 review)', async () => {
  const { db, repo } = repoWithRows([child({ pid: 1 }), child({ pid: 2 })]);
  const list = mock(async () => []);
  const kill = mock(() => {});

  await sweepOrphanedAgentChildren(
    repo,
    () => {},
    () => {},
    {
      canList: () => false,
      list,
      kill,
      now: () => NOW,
    }
  );

  expect(list).not.toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
  expect(repo.list()).toHaveLength(2);
  db.close();
});

test('canListProcesses tracks the platforms listProcesses can actually read', async () => {
  expect(canListProcesses()).toBe(process.platform !== 'win32');
  if (!canListProcesses()) expect(await listProcesses()).toEqual([]);
});
