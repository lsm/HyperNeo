import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));
const withRun = join(repoRoot, '.claude/skills/verify/with-run.sh');

function stub(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o700 });
  return path;
}

function runDirLeftovers(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith('hyperneo-verify-'));
}

test('with-run.sh prefixes, exports and removes the run dir on success', () => {
  const sandbox = join(tmpdir(), `hygiene-probe-${process.pid}`);
  rmSync(sandbox, { recursive: true, force: true });
  const child = stub(sandbox, 'child.sh', '#!/bin/sh\necho "$RUN" > "$RUN/touched"\n');
  const result = spawnSync('/bin/bash', [withRun, child], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: sandbox },
    encoding: 'utf8',
  });
  try {
    expect(result.status).toBe(0);
    expect(runDirLeftovers(sandbox)).toEqual([]);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('with-run.sh removes the run dir when the command fails and forwards its exit code', () => {
  const sandbox = join(tmpdir(), `hygiene-probe-${process.pid}`);
  rmSync(sandbox, { recursive: true, force: true });
  const child = stub(sandbox, 'child.sh', '#!/bin/sh\nexit 4\n');
  const result = spawnSync('/bin/bash', [withRun, child], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: sandbox },
    encoding: 'utf8',
  });
  try {
    expect(result.status).toBe(4);
    expect(runDirLeftovers(sandbox)).toEqual([]);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('with-run.sh removes the run dir on SIGTERM', async () => {
  const sandbox = join(tmpdir(), `hygiene-probe-${process.pid}`);
  rmSync(sandbox, { recursive: true, force: true });
  const child = stub(sandbox, 'child.sh', '#!/bin/sh\nsleep 30\n');
  const script = spawn('/bin/bash', [withRun, child], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: sandbox },
  });
  try {
    await waitFor(() => runDirLeftovers(sandbox).length > 0, 'run dir to appear');
    script.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => script.once('exit', (c) => resolve(c)));
    expect(code).not.toBe(0);
    expect(runDirLeftovers(sandbox)).toEqual([]);
  } finally {
    script.kill('SIGKILL');
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 30000);

test('with-run.sh keeps the run dir when VERIFY_KEEP_RUN=1', () => {
  const sandbox = join(tmpdir(), `hygiene-probe-${process.pid}`);
  rmSync(sandbox, { recursive: true, force: true });
  const child = stub(sandbox, 'child.sh', '#!/bin/sh\nexit 0\n');
  const result = spawnSync('/bin/bash', [withRun, child], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: sandbox, VERIFY_KEEP_RUN: '1' },
    encoding: 'utf8',
  });
  try {
    expect(result.status).toBe(0);
    expect(runDirLeftovers(sandbox).length).toBe(1);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test.each([
  ['reactive-database.test.ts', 'reactive-db-test'],
  ['live-query-integration.test.ts', 'live-query-int'],
  ['task-id-resolution-cache.test.ts', 'task-id-cache'],
])('daemon storage test %s leaves nothing in the temp dir', (file, prefix) => {
  const suite = join(repoRoot, 'packages/daemon/tests/unit/4-space-storage/storage', file);
  expectLeakedNothing(suite, [prefix, 'backups']);
}, 120000);

test('daemon glm display-name test leaves nothing in the temp dir', () => {
  const suite = join(repoRoot, 'packages/daemon/tests/unit/1-core/core/refresh-glm-display-name.test.ts');
  expectLeakedNothing(suite, ['test-glm', 'backups']);
}, 120000);

function expectLeakedNothing(suite: string, prefixes: string[]) {
  const sandbox = join(tmpdir(), `hygiene-suite-${process.pid}-${prefixes[0]}`);
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
  const result = spawnSync(process.execPath, ['test', suite], {
    cwd: join(repoRoot, 'packages/daemon'),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: sandbox },
  });
  try {
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    const leaked = readdirSync(sandbox).filter((name) =>
      prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`))
    );
    expect(leaked).toEqual([]);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error(`timed out waiting for ${what}`));
      else setTimeout(tick, 50);
    };
    tick();
  });
}
