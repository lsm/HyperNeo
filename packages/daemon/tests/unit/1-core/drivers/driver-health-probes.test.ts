import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'bun:test';
import { testDirectories } from '../../../helpers/temporary-directory.ts';
import { createDriverHealthProbe } from '../../../../src/lib/drivers/driver-health-probes.ts';

const directories = testDirectories();

test('a Copilot CLI outside the supported pin is degraded before running discovery', async () => {
  const probe = createDriverHealthProbe({ home: directories(join(tmpdir(), 'driver-health-')), adapters: () => [], versions: async () => ({ cli: '9.0.0', sdk: '1.0.28' }) });
  expect(await probe('copilot-cli')).toMatchObject({ status: 'degraded', reason: expect.stringContaining('1.0.105') });
});

test('a missing Codex database reports its reason without running a discovery scan', async () => {
  const home = directories(join(tmpdir(), 'driver-health-'));
  let calls = 0;
  const probe = createDriverHealthProbe({
    home,
    adapters: () =>
      [
        {
          id: 'codex-desktop',
          find: () => {
            calls++;
            return [];
          },
        },
      ] as never,
    versions: async () => ({ desktop: '2.0.0' }),
  });
  expect(await probe('codex-desktop')).toMatchObject({
    status: 'unavailable',
    reason: expect.stringContaining('state database'),
    clientVersions: { desktop: '2.0.0' },
  });
  expect(calls).toBe(0);
});

test('unreadable transcript contents produce a degraded health result', async () => {
  const home = directories(join(tmpdir(), 'driver-health-'));
  const project = join(home, '.claude', 'projects', 'synthetic');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'worker.jsonl'), '{invalid}\n');
  const probe = createDriverHealthProbe({
    home,
    adapters: () => [{ id: 'claude-code', find: () => [] }] as never,
    versions: async () => ({ cli: '1.0.0' }),
  });
  expect(await probe('claude-code')).toMatchObject({
    status: 'degraded',
    reason: expect.stringContaining('transcript'),
  });
});
