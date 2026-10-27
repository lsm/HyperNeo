import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launch = fileURLToPath(
  new URL('../../../../../../.claude/skills/verify/launch.sh', import.meta.url)
);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-launch-port-'));
  mkdirSync(join(root, 'bin'));
  for (const name of ['bun', 'lsof', 'curl']) {
    writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each(['not-a-port', '8399', '19537', '0', '65536'])(
  'refuses mock port %s before launching either server',
  (mockPort) => {
    const run = join(root, 'run');
    const result = spawnSync('bash', [launch, '19537', run], {
      env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, VERIFY_MOCK_PORT: mockPort },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('invalid mock port');
    expect(existsSync(join(run, 'daemon.pid'))).toBe(false);
    expect(existsSync(join(run, 'mock-api.pid'))).toBe(false);
  }
);
