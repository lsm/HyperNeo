import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const runner = join(root, 'scripts/bun-native-smoke.sh');
const proofs = [
  ['bun-daemon-boot-probe'],
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
  ['lane-b-transcript-session-reader', '--defer-body-copy'],
  ['history-snapshot-reader'],
  ['lane-b-session-list-reader'],
  ['lane-b-session-list-live-reader'],
  ['lane-b-health-session-count-reader'],
  ['lane-b-projected-session-reader'],
  ['lane-b-projected-system-broadcast-failure'],
  ['lane-b-transcript-shutdown-order'],
  ['todo-mutation-planning', 'verify'],
  ['lane-b-single-message-reader', '--defer-body-copy'],
  ['todo-mutation-commit', 'verify'],
  ['coding-daemon-merge-build'],
  ['coding-daemon-merge-sweep', 'enterprise'],
  ['coding-daemon-merge-sweep', 'policy-revoke'],
  ['coding-daemon-merge-sweep', 'merge-fails'],
  ['coding-daemon-merge-sweep', 'late-label'],
  ['coding-daemon-merge-sweep', 'per-pr'],
  ['coding-daemon-merge-sweep', 'retry-once'],
  ['coding-daemon-merge-sweep', 'legacy-open'],
  ['coding-daemon-merge-sweep', 'uncertain-error'],
  ['coding-daemon-merge-sweep', 'limit-gone'],
  ['coding-daemon-merge-sweep', 'external-owned'],
  ['coding-daemon-merge-sweep', 'zero-required'],
  ['coding-daemon-merge-sweep', 'no-checks'],
  ['coding-daemon-merge-sweep', 'human-default'],
  ['coding-daemon-merge-sweep', 'human-owner'],
  ['coding-daemon-merge-sweep', 'human-unconfigured'],
  ['coding-daemon-merge-sweep', 'approved-no-checks'],
  ['coding-daemon-merge-sweep', 'human-waiting-ci'],
  ['coding-daemon-merge-sweep', 'human-sibling-ci'],
  ['coding-daemon-merge-sweep', 'owner-ci'],
  ['coding-daemon-merge-sweep', 'human-new-head'],
  ['coding-daemon-merge-sweep', 'ci-startup-queued'],
  ['coding-daemon-merge-sweep', 'ci-startup-running'],
  ['coding-daemon-merge-sweep', 'ci-merge-race'],
  ['coding-daemon-merge-sweep', 'ci-retry-budget'],
  ['coding-daemon-merge-sweep', 'ci-stopped-ready'],
  ['coding-signoff-scope'],
  ['todo-remove-writer', 'verify'],
  ['todo-mutation-activation', 'verify'],
  ['todo-runner-state', 'verify'],
  ['todo-runner-activation', 'verify'],
  ['todo-start-recovery', 'verify'],
  ['todo-start-recovery-activation', 'verify'],
  ['ask-settlement-build', 'verify'],
  ['neo-track-admission-build', 'verify'],
  ['neo-track-admission-activation', 'verify'],
  ['todo-add-build', 'verify'],
  ['todo-stop-context', 'verify'],
  ['ask-settlement-activation', 'verify'],
  ['human-confirmed-todos', 'verify'],
  ['lane-b-message-count-reader'],
  ['lane-b-session-export-reader'],
  ['lane-b-session-schedule-create'],
  ['workflow-node-config-contract', 'verify'],
  ['workflow-existing-run-pin', 'verify'],
  ['workflow-snapshot-writer', 'verify'],
  ['direct-start-requeue-writer', 'verify'],
  ['job-requeue-writer', 'verify'],
  ['task-schedule-delete-writer', 'verify'],
  ['task-schedule-pause-writer', 'verify'],
  ['workflow-options-contract', 'verify'],
  ['lane-c-pairing-approve'],
  ['lane-c-pairing-redeem'],
  ['lane-c-pairing-code-create'],
  ['lane-c-pairing-revoke-command'],
  ['lane-c-connected-device-observer'],
  ['lane-c-pairing-revoke-activation'],
  ['lane-c-human-reset-command'],
  ['lane-c-conversation-reservation-extract'],
  ['lane-c-human-reset-receipts'],
  ['lane-c-human-reset-coordinator'],
  ['lane-c-human-reset-activation'],
  ['lane-c-workspace-remove'],
  ['lane-c-workspace-upsert'],
  ['lane-c-workspace-add'],
  ['lane-c-artifact-identity-extract'],
  ['lane-c-artifact-identity-command'],
  ['retire-local-register', 'verify'],
  ['lane-c-artifact-reference-identity'],
  ['lane-c-artifact-git-identity'],
  ['lane-c-artifact-row-command'],
  ['lane-c-artifact-git-row'],
  ['lane-c-extension-global-sql-extract'],
  ['lane-c-extension-global-read-extract'],
  ['lane-c-extension-space-read-extract'],
  ['lane-c-extension-global-reader-command'],
  ['lane-c-extension-space-reader-command'],
  ['lane-c-extension-global-reader-activation'],
  ['lane-c-extension-global-command'],
  ['lane-c-extension-global-activation'],
  ['lane-c-extension-space-activation'],
  ['lane-c-extension-space-sql-extract'],
  ['lane-c-extension-space-command'],
  ['lane-c-github-space-enabled-extract'],
  ['lane-c-github-space-settings-read'],
  ['lane-c-github-watched-repos-read'],
  ['lane-c-github-watched-projection'],
  ['lane-c-github-space-enabled-command'],
  ['lane-c-github-space-enable-wiring'],
  ['lane-c-github-filter-extract'],
  ['lane-c-github-filter-command'],
  ['lane-c-github-filter-wiring'],
  ['lane-c-github-polling-intent-extract'],
  ['lane-c-github-watched-lookups-extract'],
  ['lane-c-github-cursor-persist-extract'],
  ['lane-c-github-watched-update-extract'],
  ['lane-c-github-watched-insert-extract'],
  ['lane-c-github-watched-upsert-lift'],
  ['lane-c-github-polling-command'],
  ['lane-c-github-polling-read-extract'],
  ['lane-c-github-polling-usage-read'],
  ['lane-c-github-capability-reader'],
  ['lane-c-github-timer-reader'],
  ['lane-c-github-unwatch-timer'],
  ['lane-c-github-watch-timer'],
  ['bun-shared-reader-probe'],
  ['bun-gateway-probe'],
  ['bun-event-job-probe'],
  ['bun-outbox-probe'],
  ['bun-todo-receipt-probe'],
  ['bun-claim-lock-probe'],
  ['bun-todo-incident-probe'],
] as const;
const caseId = (name: string, args: readonly string[]) =>
  name === 'coding-daemon-merge-sweep' ? name + '-' + args[0] : name;
const cases = proofs.map(([name, ...args]) => caseId(name, args));

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
  script(
    'bun',
    'mkdir -p "$HOME/../evidence"\n' +
      'printf "%s\\n" "$HOME" "$TMPDIR" "$HYPERNEO_DATA_DIR" "$PWD" "$@" > "$HOME/../evidence/invocation.txt"\n' +
      'proof=$(basename "$1" .ts)\n' +
      'if [ "$proof" = coding-daemon-merge-sweep ]; then proof="$proof-$2"; fi\n' +
      'printf "%s\\n" "$proof" >> ' +
      quote(join(run, 'sequence')) +
      '\n' +
      'if [ -f ' +
      quote(join(run, 'fail-helper')) +
      ' ]; then\n' +
      '  read -r failed < ' +
      quote(join(run, 'fail-helper')) +
      '\n' +
      '  if [ "$proof" = "$failed" ]; then exit 17; fi\nfi\n'
  );
  const evidence = join(run, 'retained evidence');
  const invoke = (args = [evidence]) =>
    spawnSync('/bin/bash', [runner, ...args], {
      cwd: '/',
      env: {
        PATH: bin + ':' + process.env.PATH,
        TMPDIR: join(run, 'tmp'),
        VERIFY_PROOF_RUNTIME: 'node',
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

describe('Bun native proof matrix registration', () => {
  test('Linux forces Bun with legacy order, preserved modes and fresh data', () => {
    const f = fixture();
    try {
      const result = f.invoke();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('117 legacy helpers');
      expect(result.stdout).toContain('149 proof cases');
      expect(f.sequence()).toEqual(cases);
      const homes = [];
      for (const [name, ...mode] of proofs) {
        const dir = join(f.evidence, caseId(name, mode));
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
        expect(helper).toBe(
          join(
            root,
            [
              'bun-daemon-boot-probe',
              'bun-shared-reader-probe',
              'bun-gateway-probe',
              'bun-event-job-probe',
              'bun-outbox-probe',
              'bun-todo-receipt-probe',
              'bun-claim-lock-probe',
              'bun-todo-incident-probe',
            ].includes(name)
              ? 'scripts'
              : '.claude/skills/verify',
            name + '.ts'
          )
        );
        expect(cwd + '/').toBe(root);
        expect(home).toBe(data.replace(/data$/, 'home'));
        expect(tmp).toBe(data.replace(/data$/, 'tmp'));
        expect(args).toEqual([...mode, data.slice(0, -5)]);
        expect(existsSync(home)).toBe(false);
        expect(existsSync(tmp)).toBe(false);
        expect(existsSync(data)).toBe(false);
      }
      expect(new Set(homes).size).toBe(149);
    } finally {
      f.cleanup();
    }
  });

  test.each([
    'bun-daemon-boot-probe',
    'lane-c-provider-rpc-writes',
    'coding-daemon-merge-sweep-human-new-head',
    'task-schedule-pause-writer',
    'lane-c-artifact-row-command',
    'lane-c-github-unwatch-timer',
    'bun-shared-reader-probe',
    'bun-gateway-probe',
    'bun-event-job-probe',
    'bun-outbox-probe',
    'bun-todo-receipt-probe',
    'bun-claim-lock-probe',
    'bun-todo-incident-probe',
  ])('retains failure at %s and never runs later helpers', (failed) => {
    const f = fixture();
    try {
      writeFileSync(join(f.run, 'fail-helper'), failed + '\n');
      const result = f.invoke();
      expect(result.status).toBe(17);
      expect(result.stdout).not.toContain('117 legacy helpers');
      expect(JSON.parse(readFileSync(join(f.evidence, failed, 'run-status.json'), 'utf8'))).toEqual(
        { exitCode: 17 }
      );
      const index = cases.findIndex((name) => name === failed);
      expect(f.sequence()).toEqual(cases.slice(0, index + 1));
      for (const name of cases.slice(index + 1))
        expect(existsSync(join(f.evidence, name))).toBe(false);
      const [home] = readFileSync(join(f.evidence, failed, 'invocation.txt'), 'utf8').split('\n');
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
      expect(existsSync(join(f.evidence, cases[0], 'invocation.txt'))).toBe(false);
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
      expect(existsSync(join(f.evidence, cases[0]))).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
