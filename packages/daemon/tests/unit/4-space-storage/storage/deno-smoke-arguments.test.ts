import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

test('Deno smoke passes each inline program as one complete shell argument', () => {
  const script = readFileSync(
    new URL('../../../../../../scripts/deno-smoke.sh', import.meta.url),
    'utf8'
  );
  const commands = [...script.matchAll(/^if ! ([^\n]*\bdeno eval[^\n]*'[\s\S]*?^'); then/gm)];
  expect(commands.length).toBeGreaterThan(0);
  for (const [, command] of commands) {
    const result = spawnSync('/bin/bash', ['-c', `deno() { printf '%s\\0' "$@"; }; ${command}`], {
      env: {},
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const args = result.stdout.split('\0').slice(0, -1);
    expect(args[0]).toBe('eval');
    const program = args.slice(args[1] === '--config' ? 3 : 1);
    expect(program).toHaveLength(1);
  }
});

test.each(['', '/'])(
  'Deno smoke creates normalized proof paths with TMPDIR suffix %s',
  (suffix) => {
    const directory = mkdtempSync(join(tmpdir(), 'deno-smoke-path-'));
    try {
      const script = readFileSync(
        new URL('../../../../../../scripts/deno-smoke.sh', import.meta.url),
        'utf8'
      );
      const setup = script.slice(0, script.indexOf('\nDB_PATH='));
      const result = spawnSync(
        '/bin/bash',
        ['-c', `deno() { :; };\n${setup}\nprintf '%s' "$WORK_DIR"`],
        {
          env: { PATH: '/usr/bin:/bin', TMPDIR: directory + suffix },
          encoding: 'utf8',
        }
      );
      expect(result.status).toBe(0);
      expect(existsSync(result.stdout)).toBe(true);
      expect(dirname(result.stdout)).toBe(resolve(directory));
      expect(result.stdout).toBe(resolve(result.stdout));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
