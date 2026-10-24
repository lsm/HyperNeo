import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeWorkerUrl } from '../../../src/lib/runtime-worker-url.ts';

test.each([
  [
    'file:///repo/packages/daemon/src/lib/main.ts',
    'file:///repo/packages/daemon/src/lib/worker.ts',
  ],
  ['file:///$bunfs/root/hyperneo', 'file:///$bunfs/root/daemon/src/lib/worker.ts'],
  ['file:///C:/repo/main.ts', 'file:///C:/repo/worker.ts'],
])('resolves a worker for source or compiled runtime %s', (moduleUrl, expected) => {
  expect(String(runtimeWorkerUrl('./worker.ts', './daemon/src/lib/worker.ts', moduleUrl))).toBe(
    expected
  );
});

test.each([
  String.raw`B:\~BUN\root\hyperneo.exe`,
  'B:/~BUN/root/hyperneo.exe',
  'file:///B:/~BUN/root/hyperneo.exe',
  'file:///B:/%7EBUN/root/hyperneo.exe',
])('Windows compiled workers use an embedded absolute path for %s', (moduleUrl) => {
  expect(runtimeWorkerUrl('./worker.ts', './daemon/src/lib/worker.ts', moduleUrl)).toBe(
    String.raw`B:\~BUN\root\daemon\src\lib\worker.ts`
  );
});

test('source and compiled node workers execute TypeScript entrypoints as JavaScript', () => {
  const root = resolve(import.meta.dirname, '../../../../..');
  const run = mkdtempSync(join(tmpdir(), 'hyperneo-compiled-worker-'));
  const bun = process.versions.bun
    ? process.execPath
    : process.env.BUN_INSTALL
      ? join(process.env.BUN_INSTALL, 'bin/bun')
      : join(homedir(), '.bun/bin/bun');
  const entry = 'packages/daemon/tests/unit/lib/compiled-worker-main-fixture.ts';
  const worker = 'packages/daemon/tests/unit/lib/compiled-worker-thread-fixture.ts';
  const binary = join(
    run,
    process.platform === 'win32' ? 'compiled-worker.exe' : 'compiled-worker'
  );
  try {
    expect(execFileSync(bun, [entry], { cwd: root, encoding: 'utf8', timeout: 10000 }).trim()).toBe(
      'compiled-worker-ready'
    );
    execFileSync(
      bun,
      ['build', '--compile', '--root=packages', entry, worker, `--outfile=${binary}`],
      { cwd: root, timeout: 30000, stdio: 'pipe' }
    );
    expect(execFileSync(binary, [], { cwd: run, encoding: 'utf8', timeout: 10000 }).trim()).toBe(
      'compiled-worker-ready'
    );
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
