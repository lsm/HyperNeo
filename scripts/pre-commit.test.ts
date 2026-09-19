import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function hookFixture() {
  const root = mkdtempSync(join(tmpdir(), 'hyperneo-hook-test-'));
  fixtures.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const stub = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub(
    'bun',
    `if [ "$2" = typecheck ]; then
    sleep 0.1
    if [ "\${HOOK_TEST_FAIL:-0}" = 1 ]; then
      echo 'packages/daemon/src/example.ts(1,1): error TS2322: mismatch'
      exit 1
    fi
  fi`
  );
  stub(
    'tee',
    `echo "$1" >> "$HOOK_TEST_ROOT/paths"
    case "$1" in
      "$HOOK_TEST_ROOT"/*) exec /usr/bin/tee "$@" ;;
      *) exec /usr/bin/tee /dev/null ;;
    esac`
  );
  stub(
    'rm',
    `case "$*" in
    *"$HOOK_TEST_ROOT"*) exec /bin/rm "$@" ;;
    *) exit 0 ;;
  esac`
  );
  return {
    root,
    run: async (fail = false) => {
      const child = Bun.spawn(['bash', resolve('scripts/git-hooks/pre-commit')], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: root,
          HOOK_TEST_ROOT: root,
          HOOK_TEST_FAIL: fail ? '1' : '0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, output, error };
    },
  };
}

test('concurrent hooks use separate temporary files and clean both on success', async () => {
  const fixture = hookFixture();
  const results = await Promise.all([fixture.run(), fixture.run()]);
  expect(results.map((result) => result.code)).toEqual([0, 0]);
  const paths = readFileSync(join(fixture.root, 'paths'), 'utf8').trim().split('\n');
  expect(paths).toHaveLength(2);
  expect(new Set(paths).size).toBe(2);
  for (const path of paths) {
    expect(path.startsWith(fixture.root)).toBe(true);
    expect(existsSync(path)).toBe(false);
  }
});

test('failed typecheck reports its own package errors and cleans its temporary file', async () => {
  const fixture = hookFixture();
  const result = await fixture.run(true);
  expect(result.code).toBe(1);
  expect(result.output).toMatch(/Daemon src:\s+1 error/);
  const path = readFileSync(join(fixture.root, 'paths'), 'utf8').trim();
  expect(path.startsWith(fixture.root)).toBe(true);
  expect(existsSync(path)).toBe(false);
});
