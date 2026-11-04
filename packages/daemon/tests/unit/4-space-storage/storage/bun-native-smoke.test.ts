import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const runner = join(root, 'scripts/bun-native-smoke.sh');
const helpers = [
  'neo-settings-writer',
  'lane-c-provider-rpc-writes',
  'lane-c-credential-store-writes',
];
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

function fixture(platform = 'Linux') {
  const run = mkdtempSync(join(tmpdir(), 'bun-native smoke-'));
  const bin = join(run, 'bin');
  mkdirSync(bin);
  mkdirSync(join(run, 'tmp'));
  const script = (name: string, body: string) =>
    writeFileSync(join(bin, name), '#!/bin/sh\nset -eu\n' + body, { mode: 0o755 });
  script('uname', 'printf "%s\\n" ' + quote(platform) + '\n');
  script('memory_pressure', 'printf "%s\\n" "System-wide memory free percentage: 0%"\n');
  script('deno', 'exit 99\n');
  script(
    'bun',
    'mkdir -p "$HOME/../evidence"\n' +
      'printf "%s\\n" "$HOME" "$TMPDIR" "$HYPERNEO_DATA_DIR" "$PWD" "$@" > "$HOME/../evidence/invocation.txt"\n' +
      'if [ "$(basename "$1")" = lane-c-provider-rpc-writes.ts ] && [ -f ' +
      quote(join(run, 'fail-provider')) +
      ' ]; then exit 17; fi\n'
  );
  const evidence = join(run, 'retained evidence');
  const invoke = (args = [evidence]) =>
    spawnSync('/bin/bash', [runner, ...args], {
      cwd: '/',
      env: {
        PATH: bin + ':' + process.env.PATH,
        TMPDIR: join(run, 'tmp'),
        VERIFY_PROOF_RUNTIME: 'deno',
      },
      encoding: 'utf8',
    });
  return { run, evidence, invoke, cleanup: () => rmSync(run, { recursive: true, force: true }) };
}

describe('Bun native smoke settings registration', () => {
  test('Linux needs no macOS guard tools and forces Bun with preserved modes and fresh data', () => {
    const f = fixture();
    try {
      const result = f.invoke();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('3 legacy helpers');
      const homes = [];
      for (const name of helpers) {
        const dir = join(f.evidence, name);
        expect(JSON.parse(readFileSync(join(dir, 'run-status.json'), 'utf8'))).toEqual({
          exitCode: 0,
        });
        const [home, tmp, data, cwd, helper, ...args] = readFileSync(
          join(dir, 'invocation.txt'),
          'utf8'
        )
          .trimEnd()
          .split('\n');
        homes.push(home);
        expect(helper).toBe(join(root, '.claude/skills/verify', name + '.ts'));
        expect(cwd + '/').toBe(root);
        expect(home).toBe(data.replace(/data$/, 'home'));
        expect(tmp).toBe(data.replace(/data$/, 'tmp'));
        expect(args).toEqual(
          name === helpers[0] ? ['verify', data.slice(0, -5)] : [data.slice(0, -5)]
        );
        expect(existsSync(home)).toBe(false);
        expect(existsSync(tmp)).toBe(false);
        expect(existsSync(data)).toBe(false);
      }
      expect(new Set(homes).size).toBe(3);
    } finally {
      f.cleanup();
    }
  });

  test('retains the failed proof status and never runs the later credential proof', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.run, 'fail-provider'), '');
      const result = f.invoke();
      expect(result.status).toBe(17);
      expect(result.stdout).not.toContain('3 legacy helpers');
      expect(
        JSON.parse(readFileSync(join(f.evidence, helpers[1], 'run-status.json'), 'utf8'))
      ).toEqual({ exitCode: 17 });
      expect(existsSync(join(f.evidence, helpers[2]))).toBe(false);
      const [home] = readFileSync(join(f.evidence, helpers[1], 'invocation.txt'), 'utf8').split(
        '\n'
      );
      expect(existsSync(home)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test('Darwin still refuses a run below the real resource thresholds', () => {
    const f = fixture('Darwin');
    try {
      const result = f.invoke();
      expect(result.status).toBe(78);
      expect(result.stdout).toContain('MEMORY_GUARD: less than 25% free');
      expect(existsSync(join(f.evidence, helpers[0], 'invocation.txt'))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test('refuses missing, relative, extra and existing evidence destinations', () => {
    const f = fixture();
    try {
      for (const args of [[], ['relative'], [f.evidence, 'extra']])
        expect(f.invoke(args).status).not.toBe(0);
      mkdirSync(f.evidence);
      writeFileSync(join(f.evidence, 'keep'), 'untouched');
      expect(f.invoke().status).not.toBe(0);
      expect(readFileSync(join(f.evidence, 'keep'), 'utf8')).toBe('untouched');
      expect(existsSync(join(f.evidence, helpers[0]))).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
