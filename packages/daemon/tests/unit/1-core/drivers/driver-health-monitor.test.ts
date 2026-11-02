import { expect, test } from 'bun:test';
import type { DriverHealth } from '@hyperneo/shared/types/settings';
import { createDriverHealthMonitor } from '../../../../src/lib/drivers/driver-health.ts';

function fixture() {
  let now = 1;
  let status: DriverHealth['status'] = 'ok';
  let version = '1.0.0';
  let probes = 0;
  let failNotice = false;
  let available = true;
  const stored: Record<string, DriverHealth> = {};
  const notices = new Map<string, string>();
  const deps = {
    ids: ['codex-desktop'],
    now: () => now,
    read: async () => structuredClone(stored),
    save: async (id: string, result: DriverHealth) => {
      stored[id] = structuredClone(result);
    },
    probe: async () => {
      probes++;
      return {
        status,
        reason: status === 'ok' ? 'Readable.' : 'State database is missing.',
        clientVersions: { desktop: version },
      };
    },
    notify: async (id: string, text: string) => {
      if (!available) return false;
      notices.set(id, text);
      if (failNotice) throw new Error('Reply was lost.');
      return true;
    },
  };
  return {
    deps,
    stored,
    notices,
    probes: () => probes,
    setNow: (n: number) => {
      now = n;
    },
    setStatus: (s: DriverHealth['status']) => {
      status = s;
    },
    setVersion: (v: string) => {
      version = v;
    },
    failNotice: (v: boolean) => {
      failNotice = v;
    },
    setNeoAvailable: (v: boolean) => {
      available = v;
    },
  };
}

test('daily checks persist status and do not repeat unchanged notices across restart', async () => {
  const f = fixture();
  await createDriverHealthMonitor(f.deps).check(true);
  expect(f.stored['codex-desktop']).toMatchObject({
    status: 'ok',
    unverifiedVersion: true,
    clientVersions: { desktop: '1.0.0' },
  });
  await createDriverHealthMonitor(f.deps).check(true);
  expect(f.notices.size).toBe(1);
  await createDriverHealthMonitor(f.deps).check();
  expect(f.probes()).toBe(2);
  f.setNow(86_400_002);
  f.setStatus('unavailable');
  await createDriverHealthMonitor(f.deps).check();
  expect([...f.notices.values()].at(-1)).toContain('State database is missing.');
  expect(f.notices.size).toBe(2);
  f.setStatus('ok');
  await createDriverHealthMonitor(f.deps).check(true);
  expect([...f.notices.values()].at(-1)).toContain('recovered');
  expect(f.notices.size).toBe(3);
});

test('missing Neo does not stop daily probes, and queued transitions are delivered once later', async () => {
  const f = fixture();
  f.setNeoAvailable(false);
  f.setStatus('unavailable');
  const monitor = createDriverHealthMonitor(f.deps);
  await monitor.check(true);
  f.setStatus('ok');
  f.setNow(86_400_002);
  await monitor.check();
  expect(f.stored['codex-desktop'].status).toBe('ok');
  expect(f.notices.size).toBe(0);
  f.setNeoAvailable(true);
  await monitor.check();
  expect(f.notices.size).toBe(2);
  await monitor.check();
  expect(f.notices.size).toBe(2);
});

test('a lost notice acknowledgement reuses its durable identity after restart', async () => {
  const f = fixture();
  f.failNotice(true);
  await expect(createDriverHealthMonitor(f.deps).check(true)).rejects.toThrow('Reply was lost');
  f.failNotice(false);
  await createDriverHealthMonitor(f.deps).check(true);
  expect(f.notices.size).toBe(1);
});

test('Check now probes again when a scheduled check is already reading recent results', async () => {
  const f = fixture();
  const monitor = createDriverHealthMonitor(f.deps);
  await monitor.check(true);
  f.setStatus('unavailable');
  const read = f.deps.read;
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  f.deps.read = async () => {
    if (first) {
      first = false;
      entered();
      await held;
    }
    return read();
  };
  const scheduled = monitor.check();
  await started;
  const requested = [monitor.check(true), monitor.check(true)];
  release();
  await Promise.all([scheduled, ...requested]);
  expect(f.stored['codex-desktop'].status).toBe('unavailable');
  expect(f.probes()).toBe(2);
});

test('verification retires an undelivered version warning before Neo becomes available', async () => {
  const f = fixture();
  f.setNeoAvailable(false);
  const monitor = createDriverHealthMonitor(f.deps);
  await monitor.check(true);
  await monitor.verified('codex-desktop', 'codex-state-discovery', { desktop: '1.0.0' });
  f.setNeoAvailable(true);
  await monitor.check();
  expect(f.notices.size).toBe(0);
});

test('verification preserves queued health transitions without stale verification guidance', async () => {
  const f = fixture();
  f.setNeoAvailable(false);
  f.setStatus('unavailable');
  const monitor = createDriverHealthMonitor(f.deps);
  await monitor.check(true);
  f.setStatus('ok');
  await monitor.check(true);
  await monitor.verified('codex-desktop', 'codex-state-discovery', { desktop: '1.0.0' });
  f.setNeoAvailable(true);
  await monitor.check();
  expect(f.notices.size).toBe(2);
  expect([...f.notices.values()].some((text) => text.includes('recovered'))).toBe(true);
  expect([...f.notices.values()].some((text) => /unverified/i.test(text))).toBe(false);
});

test('verification records the tested version; a later client upgrade remains usable and warns once', async () => {
  const f = fixture();
  const monitor = createDriverHealthMonitor(f.deps);
  await monitor.check(true);
  await monitor.verified('codex-desktop', 'codex-state-discovery', { desktop: '1.0.0' });
  expect(f.stored['codex-desktop']).toMatchObject({
    verifiedVersions: { desktop: '1.0.0' },
    unverifiedVersion: false,
  });
  f.setVersion('2.0.0');
  await monitor.check(true);
  expect(f.stored['codex-desktop']).toMatchObject({
    status: 'ok',
    unverifiedVersion: true,
    clientVersions: { desktop: '2.0.0' },
  });
  expect([...f.notices.values()].at(-1)).toMatch(/unverified/i);
  const count = f.notices.size;
  await monitor.check(true);
  expect(f.notices.size).toBe(count);
});

test('a proof cannot mark a different installed version as verified', async () => {
  const f = fixture();
  const monitor = createDriverHealthMonitor(f.deps);
  await monitor.check(true);
  await expect(
    monitor.verified('codex-desktop', 'codex-state-discovery', { desktop: '0.9.0' })
  ).rejects.toThrow('version');
  expect(f.stored['codex-desktop'].verifiedVersions).toBeUndefined();
});

test('a check just before the daily deadline does not postpone the next check another day', async () => {
  const f = fixture();
  const monitor = createDriverHealthMonitor(f.deps);
  await monitor.check(true);
  f.setNow(86_400_000);
  await monitor.check();
  expect(await monitor.nextCheckAt()).toBe(86_400_001);
});

test('a simultaneous daily check cannot erase a passed version verification', async () => {
  const f = fixture();
  const monitor = createDriverHealthMonitor(f.deps);
  await monitor.check(true);
  const probe = f.deps.probe;
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  f.deps.probe = async () => {
    if (first) {
      first = false;
      entered();
      await held;
    }
    return probe();
  };
  const checking = monitor.check(true);
  await started;
  const verifying = monitor.verified('codex-desktop', 'codex-state-discovery', {
    desktop: '1.0.0',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await Promise.all([checking, verifying]);
  expect(f.stored['codex-desktop']).toMatchObject({
    verifiedVersions: { desktop: '1.0.0' },
    unverifiedVersion: false,
  });
});

test('one failed Neo notice does not prevent the other clients from being checked', async () => {
  const f = fixture();
  f.deps.ids = ['codex-desktop', 'hyperneo'];
  const notify = f.deps.notify;
  f.deps.notify = async (id, text) => {
    if (text.includes('codex-desktop')) throw new Error('Neo admission failed.');
    return notify(id, text);
  };
  await expect(createDriverHealthMonitor(f.deps).check(true)).rejects.toThrow(
    'Neo admission failed'
  );
  expect(f.stored.hyperneo).toMatchObject({ status: 'ok' });
});
