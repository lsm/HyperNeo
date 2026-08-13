/**
 * Tests for scripts/validate-test-matrix.sh — the universal test-coverage guard.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/validate-test-matrix.sh');
const TIMEOUT = 60_000;

function runGuard(): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync('/bin/bash', [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: TIMEOUT,
  });
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Inject a mutation into file, run the guard, assert it rejects (exit 1 +
// expected substring), and always restore the original. Regression guard for
// the bypass detectors so a silent reintroduction fails CI.
function expectGuardRejects(
  file: string,
  mutate: (original: string) => string,
  expected: string
): void {
  const original = fs.readFileSync(file, 'utf-8');
  const mutated = mutate(original);
  expect(mutated).not.toBe(original);
  fs.writeFileSync(file, mutated);
  try {
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(expected);
  } finally {
    fs.writeFileSync(file, original);
  }
}

describe('validate-test-matrix.sh', () => {
  it(
    'exits 0 on the real repo (the guard is green)',
    () => {
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    },
    TIMEOUT
  );

  it(
    'detects an orphaned unit test file not covered by any shard',
    () => {
      const orphan = path.join(
        REPO_ROOT,
        'packages/daemon/tests/unit/zzz-guard-test-orphan.test.ts'
      );
      fs.writeFileSync(orphan, "import { it } from 'bun:test';\nit('orphan', () => {});\n");
      try {
        const { exitCode, stderr } = runGuard();
        expect(exitCode).toBe(1);
        expect(stderr).toContain('not covered');
      } finally {
        fs.unlinkSync(orphan);
      }
    },
    TIMEOUT
  );

  it(
    'rejects a matrix.exclude in the real-API workflow',
    () => {
      const wf = path.join(REPO_ROOT, '.github/workflows/real-api-tests.yml');
      const original = fs.readFileSync(wf, 'utf-8');
      const anchor = '        include:\n';
      expect(original.includes(anchor)).toBe(true);
      // A flow-form exclude as a sibling of include silently drops the row in CI
      // while the guard still reports its test_path covered.
      fs.writeFileSync(
        wf,
        original.replace(anchor, `        exclude: [{ module: cross-provider-2 }]\n${anchor}`)
      );
      try {
        const { exitCode, stderr } = runGuard();
        expect(exitCode).toBe(1);
        expect(stderr).toContain('matrix.exclude');
      } finally {
        fs.writeFileSync(wf, original);
      }
    },
    TIMEOUT
  );

  it(
    'rejects a dead "&&" prefix on the web runner',
    () => {
      const wf = path.join(REPO_ROOT, '.github/workflows/main.yml');
      const original = fs.readFileSync(wf, 'utf-8');
      const anchor = "bash -lc 'cd packages/web && bunx vitest run";
      expect(original.includes(anchor)).toBe(true);
      // Bash short-circuits `&&` when the left fails, so `false && ... && vitest run`
      // never reaches vitest (the `||` vector is the same code path).
      fs.writeFileSync(
        wf,
        original.replace(anchor, "bash -lc 'false && cd packages/web && bunx vitest run")
      );
      try {
        const { exitCode, stderr } = runGuard();
        expect(exitCode).toBe(1);
        expect(stderr).toContain("places a '||'/'&&' before");
      } finally {
        fs.writeFileSync(wf, original);
      }
    },
    TIMEOUT
  );

  it(
    'rejects continue-on-error on the web runner',
    () => {
      const wf = path.join(REPO_ROOT, '.github/workflows/main.yml');
      const original = fs.readFileSync(wf, 'utf-8');
      const anchor = '  test-web:\n    name: Web Tests';
      expect(original.includes(anchor)).toBe(true);
      fs.writeFileSync(
        wf,
        original.replace(anchor, '  test-web:\n    continue-on-error: true\n    name: Web Tests')
      );
      try {
        const { exitCode, stderr } = runGuard();
        expect(exitCode).toBe(1);
        expect(stderr).toContain('continue-on-error: true');
      } finally {
        fs.writeFileSync(wf, original);
      }
    },
    TIMEOUT
  );

  it(
    'rejects a workflow-scope defaults.run.shell (P1)',
    () => {
      // A top-level defaults.run.shell: bash -n {0} turns every step into a
      // no-op (parse, do not execute) while the guard reports all covered.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) => s.replace('on:\n', 'on:\ndefaults:\n  run:\n    shell: bash -n {0}\n'),
        'non-default shell'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a non-default vitest root',
    () => {
      expectGuardRejects(
        path.join(REPO_ROOT, 'packages/web/vitest.config.ts'),
        (s) =>
          s.replace(
            'export default defineConfig({\n',
            "export default defineConfig({\n  root: 'src',\n"
          ),
        'top-level root'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a compound job-level if: gate',
    () => {
      // Appending `&& github.event_name == 'never'` disables the job in normal CI
      // while the guard stays green (was a substring match).
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) => {
          const i = s.indexOf('  test-daemon-shared-unit:\n');
          const gate = "    if: github.event.inputs.run_e2e_only != 'true'\n";
          const j = s.indexOf(gate, i);
          return (
            s.slice(0, j) +
            "    if: github.event.inputs.run_e2e_only != 'true' && github.event_name == 'never'\n" +
            s.slice(j + gate.length)
          );
        },
        'is not the pinned gate'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a no-exec interpreter prefix',
    () => {
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            './scripts/test-daemon.sh ${{ matrix.shard }} --coverage',
            'bash -n ./scripts/test-daemon.sh ${{ matrix.shard }} --coverage'
          ),
        'no-exec interpreter'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a module value with invalid characters',
    () => {
      // `comp_onents` is a distinct module to GitHub; silent normalization to
      // `components` would mask the split combination.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) => s.replace('  - module: components\n', '  - module: comp_onents\n'),
        'invalid characters'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a "#" comment that blanks out the unit runner (P0)',
    () => {
      // A folded run: >- joins lines; `true # ...` runs `true` (exit 0) and the
      // `#` comments out the test command — zero tests, job stays green.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            'bun run scripts/flaky-test-runner.ts\n          --suite daemon-unit',
            'true # bun run scripts/flaky-test-runner.ts\n          --suite daemon-unit'
          ),
        "has a '#' comment before"
      );
    },
    TIMEOUT
  );

  it(
    'rejects a marker that is quoted/echoed as data, not executed',
    () => {
      // marker_executed: the marker inside a single-quoted echo arg (not a -lc
      // body) is data, so the step runs zero tests while the guard sees the text.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            "bash -lc 'cd packages/web && bunx vitest run",
            "echo 'cd packages/web && bunx vitest run"
          ),
        'does not EXECUTE'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a compound false step gate containing always() (P2)',
    () => {
      // `always() && github.event_name == 'never'` is always false (GitHub skips
      // the step) yet contains the `always` substring — substring-matching would
      // bless a disabled runner while the guard reports it covered. Only an exact
      // always()/success()/true predicate may count as enabled.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            '      - name: Run daemon + shared unit tests (${{ matrix.shard }})\n',
            "      - name: Run daemon + shared unit tests (${{ matrix.shard }})\n        if: always() && github.event_name == 'never'\n"
          ),
        'disabled'
      );
    },
    TIMEOUT
  );

  it(
    'ignores a defaults.run.shell under an UNRELATED job (P2)',
    () => {
      // A job-scoped defaults.run.shell under the unrelated `check` job does not
      // change the guarded runners' effective shell, so the guard must stay green
      // (previously it false-rejected the unit/web/online jobs).
      const wf = path.join(REPO_ROOT, '.github/workflows/main.yml');
      const original = fs.readFileSync(wf, 'utf-8');
      const anchor = '  check:\n';
      expect(original.includes(anchor)).toBe(true);
      fs.writeFileSync(
        wf,
        original.replace(anchor, '  check:\n    defaults:\n      run:\n        shell: bash\n')
      );
      try {
        const { exitCode } = runGuard();
        expect(exitCode).toBe(0);
      } finally {
        fs.writeFileSync(wf, original);
      }
    },
    TIMEOUT
  );
});
