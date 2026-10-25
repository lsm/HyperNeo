import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test.each([
  {
    name: 'low memory',
    pressure: 'System-wide memory free percentage: 24%',
    available: 90000000,
    status: 78,
    message: 'MEMORY_GUARD',
  },
  {
    name: 'unknown memory',
    pressure: 'Unavailable',
    available: 90000000,
    status: 78,
    message: 'MEMORY_GUARD',
  },
  {
    name: 'low disk',
    pressure: 'System-wide memory free percentage: 50%',
    available: 1000000,
    status: 79,
    message: 'DISK_GUARD',
  },
])('proof wrapper refuses $name before creating a daemon run', (input) => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-resource-guard-'));
  try {
    const bin = join(directory, 'bin'),
      evidence = join(directory, 'evidence');
    mkdirSync(bin);
    writeFileSync(join(bin, 'memory_pressure'), `#!/bin/sh\necho '${input.pressure}'\n`, {
      mode: 0o700,
    });
    writeFileSync(
      join(bin, 'df'),
      `#!/bin/sh\necho 'Filesystem Blocks Used Available Capacity Mount'\necho 'synthetic 100000000 10000000 ${input.available} 10% /data'\n`,
      { mode: 0o700 }
    );
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
    const script = fileURLToPath(
      new URL('../../../../../../.claude/skills/verify/proof-run.sh', import.meta.url)
    );
    const result = spawnSync('/bin/bash', [script, evidence, 'unused-proof.ts', 'verify'], {
      env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: directory },
      encoding: 'utf8',
    });
    expect(result.status).toBe(input.status);
    expect(result.stdout).toContain(input.message);
    expect(existsSync(evidence)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
