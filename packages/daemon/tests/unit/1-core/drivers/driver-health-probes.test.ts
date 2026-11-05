import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'bun:test';
import { vi } from 'vitest';
import { testDirectories } from '../../../helpers/temporary-directory.ts';
import { createDriverHealthProbe } from '../../../../src/lib/drivers/driver-health-probes.ts';

const directories = testDirectories();

test('CLI health works without Bun using the same executable lookup as its adapter', async () => {
  const home = directories(join(tmpdir(), 'driver-health-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho 2.1.0\n', { mode: 0o700 });
  vi.stubGlobal('Bun', undefined);
  vi.stubEnv('PATH', bin);
  try {
    const probe = createDriverHealthProbe({
      home,
      adapters: () => [{ id: 'claude-code', find: () => [] }] as never,
    });
    expect(await probe('claude-code')).toMatchObject({
      status: 'ok',
      clientVersions: { cli: '2.1.0' },
    });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
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

for (const standalone of [false, true]) {
  test(`Codex health reads the ${standalone ? 'standalone before bundled' : 'ChatGPT-bundled'} desktop version`, async () => {
    const home = directories(join(tmpdir(), 'driver-health-'));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'state_6.sqlite'), 'synthetic discovery fixture');
    for (const [app, version] of [
      ['ChatGPT', '26.1027.51404'],
      ...(standalone ? [['Codex', '1.2.3']] : []),
    ]) {
      const contents = join(home, 'Applications', `${app}.app`, 'Contents');
      mkdirSync(contents, { recursive: true });
      writeFileSync(
        join(contents, 'Info.plist'),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
      );
    }
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'plutil'),
      `#!${process.execPath}
const { readFileSync } = require('node:fs');
const plist = readFileSync(process.argv.at(-1), 'utf8');
const version = plist.match(/<key>CFBundleShortVersionString<\\/key><string>([^<]+)<\\/string>/)?.[1];
if (!version) process.exit(1);
process.stdout.write(version);
`,
      { mode: 0o700 }
    );
    vi.stubEnv('PATH', bin);
    try {
      const probe = createDriverHealthProbe({
        home,
        adapters: () => [{ id: 'codex-desktop', find: () => [] }] as never,
      });
      expect(await probe('codex-desktop')).toMatchObject({
        status: 'ok',
        clientVersions: { desktop: standalone ? '1.2.3' : '26.1027.51404' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
}
