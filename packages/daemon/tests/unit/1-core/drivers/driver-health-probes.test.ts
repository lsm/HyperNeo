import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { testDirectories } from '../../../helpers/temporary-directory.ts';
import { createDriverHealthProbe } from '../../../../src/lib/drivers/driver-health-probes.ts';

const directories = testDirectories();

test('a missing Codex database reports its reason without running a discovery scan', async () => {
  const home = directories.make('driver-health-');
  let calls = 0;
  const probe = createDriverHealthProbe({
    home,
    adapters: () => [{ id: 'codex-desktop', find: () => { calls++; return []; } }] as never,
    versions: async () => ({ desktop: '2.0.0' }),
  });
  expect(await probe('codex-desktop')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('state database'), clientVersions: { desktop: '2.0.0' } });
  expect(calls).toBe(0);
});

test('unreadable transcript contents produce a degraded health result', async () => {
  const home = directories.make('driver-health-');
  const project = join(home, '.claude', 'projects', 'synthetic');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'worker.jsonl'), '{invalid}\n');
  const probe = createDriverHealthProbe({ home, adapters: () => [{ id: 'claude-code', find: () => [] }] as never, versions: async () => ({ cli: '1.0.0' }) });
  expect(await probe('claude-code')).toMatchObject({ status: 'degraded', reason: expect.stringContaining('transcript') });
});
