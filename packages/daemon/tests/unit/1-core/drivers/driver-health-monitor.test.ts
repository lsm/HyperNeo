import { expect, test } from 'bun:test';
import { createDriverHealthMonitor } from '../../../../src/lib/drivers/driver-health.ts';

function fixture() {
  let now = 1;
  let status = 'ok';
  let version = '1.0.0';
  let probes = 0;
  let failNotice = false;
  const stored: Record<string, any> = {};
  const notices = new Map<string, string>();
  const deps = {
    ids: ['codex-desktop'],
    now: () => now,
    read: async () => structuredClone(stored),
    save: async (id: string, result: unknown) => { stored[id] = structuredClone(result); },
    probe: async () => {
      probes++;
      return { status, reason: status === 'ok' ? 'Readable.' : 'State database is missing.', clientVersions: { desktop: version } };
    },
    notify: async (id: string, text: string) => {
      notices.set(id, text);
      if (failNotice) throw new Error('Reply was lost.');
      return true;
    },
  };
  return { deps, stored, notices, probes: () => probes, setNow: (n: number) => { now = n; }, setStatus: (s: string) => { status = s; }, setVersion: (v: string) => { version = v; }, failNotice: (v: boolean) => { failNotice = v; } };
}

test('daily checks persist status and do not repeat unchanged notices across restart', async () => {
  const f = fixture();
  await createDriverHealthMonitor(f.deps).check(true);
  expect(f.stored['codex-desktop']).toMatchObject({ status: 'ok', unverifiedVersion: true, clientVersions: { desktop: '1.0.0' } });
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

test('a lost notice acknowledgement reuses its durable identity after restart', async () => {
  const f = fixture();
  f.failNotice(true);
  await expect(createDriverHealthMonitor(f.deps).check(true)).rejects.toThrow('Reply was lost');
  f.failNotice(false);
  await createDriverHealthMonitor(f.deps).check(true);
  expect(f.notices.size).toBe(1);
});

test('verification records the tested version; a later client upgrade remains usable and warns once', async () => {
  const f = fixture();
  const monitor = createDriverHealthMonitor(f.deps);
  await monitor.check(true);
  await monitor.verified('codex-desktop', 'codex-state-discovery');
  expect(f.stored['codex-desktop']).toMatchObject({ verifiedVersions: { desktop: '1.0.0' }, unverifiedVersion: false });
  f.setVersion('2.0.0');
  await monitor.check(true);
  expect(f.stored['codex-desktop']).toMatchObject({ status: 'ok', unverifiedVersion: true, clientVersions: { desktop: '2.0.0' } });
  expect([...f.notices.values()].at(-1)).toContain('unverified');
  const count = f.notices.size;
  await monitor.check(true);
  expect(f.notices.size).toBe(count);
});
