import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
