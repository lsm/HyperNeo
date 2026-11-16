import { expect, test } from 'bun:test';
import type { DriverHealth } from '@hyperneo/shared/types/settings';
import {
  createDriverHealthMonitor,
  driverHealthEvents,
} from '../../../../src/lib/drivers/driver-health.ts';

function fixture() {
  let now = 1;
  let status: DriverHealth['status'] = 'ok';
  let version = '1.0.0';
  let probes = 0;
  const stored: Record<string, DriverHealth> = {};
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
  };
  return {
    deps,
    stored,
    events: () => driverHealthEvents(stored),
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
  };
}

test('daily checks persist status and keep the incident start across unchanged checks and restart', async () => {
  const f = fixture();
  await createDriverHealthMonitor(f.deps).check(true);
  expect(f.stored['codex-desktop']).toMatchObject({
    status: 'ok',
    unverifiedVersion: true,
    clientVersions: { desktop: '1.0.0' },
    since: 1,
  });
  f.setNow(5);
  await createDriverHealthMonitor(f.deps).check(true);
  expect(f.stored['codex-desktop'].since).toBe(1);
  await createDriverHealthMonitor(f.deps).check();
  expect(f.probes()).toBe(2);
  f.setNow(86_400_006);
  f.setStatus('unavailable');
  await createDriverHealthMonitor(f.deps).check();
  expect(f.probes()).toBe(3);
  f.setNow(86_400_010);
  await createDriverHealthMonitor(f.deps).check(true);
  expect(f.events()).toEqual([
    {
      kind: 'driver.health',
      subject: { type: 'driver', id: 'codex-desktop' },
      since: 86_400_006,
      facts: {
        text: expect.stringContaining('codex-desktop unavailable. State database is missing.'),
      },
    },
  ]);
});

test('a healthy, verified driver raises no event, and an unverified one says so', async () => {
  const healthy = { status: 'ok' as const, reason: 'Readable.', clientVersions: {}, checkedAt: 1 };
  expect(
    driverHealthEvents({
      fine: { ...healthy, unverifiedVersion: false, since: 1 },
      newer: { ...healthy, unverifiedVersion: true, since: 7 },
    })
  ).toEqual([
    {
      kind: 'driver.health',
      subject: { type: 'driver', id: 'newer' },
      since: 7,
      facts: { text: expect.stringMatching(/newer ok\. Readable\..*Unverified client version/) },
    },
  ]);
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

test('verification ends the unverified-version incident', async () => {
  const f = fixture();
  const monitor = createDriverHealthMonitor(f.deps);
  await monitor.check(true);
  expect(f.events()).toHaveLength(1);
  await monitor.verified('codex-desktop', 'codex-state-discovery', { desktop: '1.0.0' });
  expect(f.events()).toEqual([]);
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
  const [warning] = f.events();
  expect(warning.facts.text).toMatch(/2\.0\.0.*Unverified/);
  await monitor.check(true);
  expect(f.events()).toEqual([warning]);
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
