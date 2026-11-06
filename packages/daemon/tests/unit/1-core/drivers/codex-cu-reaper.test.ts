import { describe, expect, spyOn, test } from 'bun:test';
import {
  decideCuReap,
  createCuChecker,
  startCuChecker,
} from '../../../../src/lib/drivers/codex-cu-reaper';
import {
  configureLogger,
  getLoggerConfig,
  LogLevel,
  subscribeToStructuredLogs,
} from '../../../../src/lib/logger';

const now = Date.parse('2026-11-03T18:00:00Z');
const path =
  '/synthetic/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService';
const name = 'Codex Computer Use interaction';
const assertion = (age = '11:00:00', pid = 123, owner = 'SkyComputerUseService') =>
  `   pid ${pid}(${owner}): [0x0000000500000001] ${age} PreventUserIdleDisplaySleep named: "${name}"`;
const created = (at = '2026-11-03 12:00:00 -0500', pid = 123) =>
  `${at} Assertions PID ${pid}(SkyComputerUseService) Created PreventUserIdleDisplaySleep "${name}" 00:00:00 id:0x0x500000001`;
const observation = () => ({
  now,
  path,
  uid: 501,
  assertions: `Listed by owning process:\n${assertion()}\nKernel Assertions: 0`,
  log: created(),
  processes: `123 501 Mon Nov  2 08:00:00 2026 ${path}`,
});

describe('decideCuReap', () => {
  test('accepts an old leak with no recent creation and exact same-user service identity', () => {
    expect(decideCuReap(observation())).toEqual([{ pid: 123, birth: 'Mon Nov  2 08:00:00 2026' }]);
  });

  test('accepts the five-minute boundary and 20-hour leaks', () => {
    for (const age of ['00:05:00', '20:00:00'])
      expect(
        decideCuReap({
          ...observation(),
          assertions: `Listed by owning process:\n${assertion(age)}`,
        })
      ).toHaveLength(1);
  });

  test('never treats normal short interactions or any young assertion as leaked', () => {
    for (const age of ['00:00:00', '00:00:20', '00:01:00', '00:04:59'])
      expect(
        decideCuReap({
          ...observation(),
          assertions: `${observation().assertions}\n${assertion(age)}`,
        })
      ).toEqual([]);
  });

  test('a recent Created still blocks after its assertion has already Released', () => {
    const log = `${created()}\n${created('2026-11-03 12:59:59 -0500')}\n2026-11-03 13:00:00 -0500 Assertions PID 123(SkyComputerUseService) Released PreventUserIdleDisplaySleep "${name}" 00:00:01`;
    expect(decideCuReap({ ...observation(), log })).toEqual([]);
  });

  test('fails closed on missing or malformed power records', () => {
    for (const change of [
      { assertions: '' },
      { assertions: assertion('11:00:00') },
      { assertions: `Listed by owning process:\n${assertion('broken')}` },
      { log: '' },
      { log: created('bad-date') },
      { processes: '' },
    ])
      expect(decideCuReap({ ...observation(), ...change })).toEqual([]);
  });

  test('rejects other owners, another user, a path lookalike and stale PID history', () => {
    for (const change of [
      { assertions: `Listed by owning process:\n${assertion('11:00:00', 123, 'Codex')}` },
      { processes: `123 502 Mon Nov  2 08:00:00 2026 ${path}` },
      { processes: `123 501 Mon Nov  2 08:00:00 2026 ${path}-other` },
      { log: created('2026-11-01 12:00:00 -0500') },
    ])
      expect(decideCuReap({ ...observation(), ...change })).toEqual([]);
  });
});

describe('startCuChecker', () => {
  test('test-mode driver setup never arms the host checker on macOS', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const interval = spyOn(globalThis, 'setInterval');
    const close = startCuChecker(() => true);
    try {
      expect(interval).not.toHaveBeenCalled();
    } finally {
      await close();
      interval.mockRestore();
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('createCuChecker', () => {
  test('close returns while an observation is pending and suppresses its later effects', async () => {
    let release!: (facts: ReturnType<typeof observation>) => void;
    const pending = new Promise<ReturnType<typeof observation>>((resolve) => {
      release = resolve;
    });
    const actions: string[] = [];
    const checker = createCuChecker({
      read: () => pending,
      auto: () => true,
      notify: async () => void actions.push('notify'),
      signal: () => void actions.push('signal'),
    });
    const checking = checker.check();
    let closed = false;
    const closing = checker.close().then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(closed).toBe(true);
    } finally {
      release(observation());
      await checking;
      await closing;
    }
    expect(actions).toEqual([]);
  });

  test('closing from an action log suppresses the subsequent notification or signal', async () => {
    const previousConfig = getLoggerConfig();
    configureLogger({ level: LogLevel.WARN });
    try {
      for (const auto of [false, true]) {
        const actions: string[] = [];
        const checker = createCuChecker({
          read: async () => observation(),
          auto: () => auto,
          notify: async () => void actions.push('notify'),
          signal: () => void actions.push('signal'),
        });
        const unsubscribe = subscribeToStructuredLogs((event) => {
          if (event.module.includes('codex-cu')) void checker.close();
        });
        try {
          await checker.check();
          expect(actions).toEqual([]);
        } finally {
          unsubscribe();
          await checker.close();
        }
      }
    } finally {
      configureLogger(previousConfig);
    }
  });

  test('starts, checks and closes with a numeric timer handle', async () => {
    const timer = 42 as unknown as ReturnType<typeof setInterval>;
    const interval = spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    let checker: ReturnType<typeof createCuChecker> | undefined;
    const notices: string[] = [];
    try {
      checker = createCuChecker({
        read: async () => observation(),
        auto: () => false,
        notify: async (text) => void notices.push(text),
        signal: () => {},
      });
      await checker.check();
      expect(notices).toHaveLength(1);
      await checker.close();
      expect(clear).toHaveBeenCalledWith(timer);
    } finally {
      await checker?.close();
      interval.mockRestore();
      clear.mockRestore();
    }
  });

  test('a cancelled automatic action does not log a kill attempt', async () => {
    const previousConfig = getLoggerConfig();
    configureLogger({ level: LogLevel.WARN });
    const events: string[] = [];
    const unsubscribe = subscribeToStructuredLogs((event) => {
      if (event.module.includes('codex-cu')) events.push(JSON.stringify(event));
    });
    let reads = 0;
    let confirmed = false;
    const signals: number[] = [];
    const checker = createCuChecker({
      read: async () =>
        ++reads === 1 || confirmed
          ? observation()
          : { ...observation(), assertions: `Listed by owning process:\n${assertion('00:00:01')}` },
      auto: () => true,
      notify: async () => {},
      signal: (pid) => void signals.push(pid),
    });
    try {
      await checker.check();
      expect(reads).toBe(2);
      expect(signals).toEqual([]);
      expect(events.filter((event) => event.includes('action: kill -TERM'))).toEqual([]);
      confirmed = true;
      await checker.check();
      expect(signals).toEqual([123]);
      expect(events.filter((event) => event.includes('action: kill -TERM'))).toHaveLength(1);
    } finally {
      await checker.close();
      unsubscribe();
      configureLogger(previousConfig);
    }
  });

  test('a failed alert is attempted once for each service process birth', async () => {
    let attempts = 0;
    let facts = observation();
    const checker = createCuChecker({
      read: async () => facts,
      auto: () => false,
      notify: async () => {
        attempts++;
        throw new Error('notification denied');
      },
      signal: () => {
        throw new Error('alert mode must not signal');
      },
    });
    try {
      await checker.check();
      await checker.check();
      expect(attempts).toBe(1);
      facts = { ...facts, processes: `123 501 Tue Nov  3 08:00:00 2026 ${path}` };
      await checker.check();
      await checker.check();
      expect(attempts).toBe(2);
    } finally {
      await checker.close();
    }
  });

  test('explicit alert mode offers the exact single-PID action without sending a signal', async () => {
    const notices: string[] = [],
      signals: number[] = [];
    const checker = createCuChecker({
      read: async () => observation(),
      auto: () => false,
      notify: async (text) => void notices.push(text),
      signal: (pid) => void signals.push(pid),
    });
    try {
      await checker.check();
      await checker.check();
      expect(signals).toEqual([]);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('kill -TERM 123');
    } finally {
      await checker.close();
    }
  });

  test('automatic mode signals once, never retries a failed signal, and rereads before acting', async () => {
    let reads = 0;
    const signals: number[] = [];
    const checker = createCuChecker({
      read: async () => {
        reads++;
        return observation();
      },
      auto: () => true,
      notify: async () => {},
      signal: (pid) => {
        signals.push(pid);
        throw new Error('denied');
      },
    });
    try {
      await checker.check();
      await checker.check();
      expect(signals).toEqual([123]);
      expect(reads).toBeGreaterThanOrEqual(2);
    } finally {
      await checker.close();
    }
  });

  test('a young assertion or PID replacement at the final read cancels the signal', async () => {
    for (const replacement of [
      { ...observation(), assertions: `Listed by owning process:\n${assertion('00:00:01')}` },
      { ...observation(), processes: `123 501 Tue Nov  3 12:00:00 2026 ${path}` },
    ]) {
      let reads = 0;
      const signals: number[] = [];
      const checker = createCuChecker({
        read: async () => (++reads === 1 ? observation() : replacement),
        auto: () => true,
        notify: async () => {},
        signal: (pid) => void signals.push(pid),
      });
      try {
        await checker.check();
        expect(signals).toEqual([]);
      } finally {
        await checker.close();
      }
    }
  });
});
