import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const runner = join(root, 'scripts/bun-native-smoke.sh');
const proofs = [
  ['neo-settings-writer', 'verify'],
  ['lane-b-cleanup-enqueue'],
  ['workflow-identity-contract', 'verify'],
  ['lane-b-mailbox-admission'],
  ['lane-b-event-submission'],
  ['lane-b-delivery-parking'],
  ['agent-reminder-delete-writer', 'verify'],
  ['workflow-delete-writer', 'verify'],
  ['lane-b-rate-limit-cancel'],
  ['lane-b-owned-input-withdrawal'],
  ['lane-b-rate-limit-retry'],
  ['lane-c-provider-rpc-writes'],
  ['lane-c-credential-store-writes'],
  ['lane-b-session-delivery-enqueue'],
  ['lane-b-stale-reclaim-writer'],
  ['direct-outcome-parking-writer', 'verify'],
  ['lane-b-mailbox-expiry-writer'],
  ['lane-b-github-poll-successor-writer'],
  ['lane-b-native-feed-enqueue-writer'],
  ['lane-b-session-title-enqueue-writer'],
  ['lane-c-skill-validation-enqueue-writer'],
  ['lane-c-github-poll-refresh-writer'],
  ['lane-c-github-poll-refresh-retry'],
  ['lane-c-github-poll-startup-degraded'],
  ['lane-c-github-poll-capability-failure'],
  ['lane-b-session-schedule-create'],
  ['workflow-node-config-contract', 'verify'],
  ['workflow-existing-run-pin', 'verify'],
  ['workflow-snapshot-writer', 'verify'],
  ['direct-start-requeue-writer', 'verify'],
  ['job-requeue-writer', 'verify'],
  ['task-schedule-delete-writer', 'verify'],
  ['task-schedule-pause-writer', 'verify'],
  ['workflow-options-contract', 'verify'],
] as const;
const helpers = proofs.map(([name]) => name);

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
      'basename "$1" >> ' +
      quote(join(run, 'sequence')) +
      '\n' +
      'if [ -f ' +
      quote(join(run, 'fail-helper')) +
      ' ]; then\n' +
      '  read -r failed < ' +
      quote(join(run, 'fail-helper')) +
      '\n' +
      '  if [ "$(basename "$1")" = "$failed" ]; then exit 17; fi\nfi\n'
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
  const sequence = () => readFileSync(join(run, 'sequence'), 'utf8').trimEnd().split('\n');
  return {
    run,
    evidence,
    invoke,
    sequence,
    cleanup: () => rmSync(run, { recursive: true, force: true }),
  };
}

describe('Bun native smoke settings and workflow/job registration', () => {
  test('Linux forces Bun with legacy order, preserved modes and fresh data', () => {
    const f = fixture();
    try {
      const result = f.invoke();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('34 legacy helpers');
      expect(f.sequence()).toEqual(helpers.map((name) => name + '.ts'));
      const homes = [];
      for (const [name, ...mode] of proofs) {
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
        expect(args).toEqual([...mode, data.slice(0, -5)]);
        expect(existsSync(home)).toBe(false);
        expect(existsSync(tmp)).toBe(false);
        expect(existsSync(data)).toBe(false);
      }
      expect(new Set(homes).size).toBe(34);
    } finally {
      f.cleanup();
    }
  });

  test.each(['lane-c-provider-rpc-writes', 'task-schedule-pause-writer'])(
    'retains failure at %s and never runs later helpers',
    (failed) => {
      const f = fixture();
      try {
        writeFileSync(join(f.run, 'fail-helper'), failed + '.ts\n');
        const result = f.invoke();
        expect(result.status).toBe(17);
        expect(result.stdout).not.toContain('34 legacy helpers');
        expect(
          JSON.parse(readFileSync(join(f.evidence, failed, 'run-status.json'), 'utf8'))
        ).toEqual({ exitCode: 17 });
        const index = helpers.findIndex((name) => name === failed);
        expect(f.sequence()).toEqual(helpers.slice(0, index + 1).map((name) => name + '.ts'));
        for (const name of helpers.slice(index + 1))
          expect(existsSync(join(f.evidence, name))).toBe(false);
        const [home] = readFileSync(join(f.evidence, failed, 'invocation.txt'), 'utf8').split('\n');
        expect(existsSync(home)).toBe(false);
      } finally {
        f.cleanup();
      }
    }
  );

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
