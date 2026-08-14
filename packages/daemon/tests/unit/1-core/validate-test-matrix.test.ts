/**
 * Tests for scripts/validate-test-matrix.sh — the universal test-coverage guard.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/validate-test-matrix.sh');
// Each test spawns the full guard (~15–20s typically). 90s gives margin so a
// slow/loaded runner does not time out a mutation test and report a false pass.
const TIMEOUT = 90_000;

// Committed workflow/config files these tests mutate in place. Snapshot the
// EXACT working-tree bytes in beforeAll and restore them in afterAll. This must
// NOT use `git checkout HEAD --`: that would irreversibly discard a developer's
// uncommitted edits to these files (data loss). Snapshotting the working tree
// preserves those edits (we restore to the beforeAll state), and each test's
// try/finally still restores on normal exit.
const MUTATED_TARGETS = [
  '.github/workflows/main.yml',
  '.github/workflows/real-api-tests.yml',
  'packages/web/vitest.config.ts',
];
const _snapshots = new Map<string, string>();
beforeAll(() => {
  for (const rel of MUTATED_TARGETS) {
    _snapshots.set(rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
  }
});
afterAll(() => {
  for (const [rel, original] of _snapshots) {
    fs.writeFileSync(path.join(REPO_ROOT, rel), original);
  }
});

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

  it(
    'rejects a double-quoted data wrapper (test -n) over the web marker',
    () => {
      // `test -n "<marker>"` (double-quoted) exits 0 without running Vitest.
      // executed_text now treats a double-quoted arg as DATA unless it is the
      // `bash -lc` command body, so the marker is not executed → caught by
      // marker_executed (a data-command blacklist could not enumerate
      // `test`/`[`/`[[`).
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            "bash -lc 'cd packages/web && bunx vitest run",
            'test -n "cd packages/web && bunx vitest run'
          ),
        'does not EXECUTE'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a bash -lc command whose marker is a $0 positional (P2)',
    () => {
      // `bash -lc "true" "<marker>"` runs only `true`; the marker-bearing string
      // is $0 (not executed), but the old executed_text copied any double-quoted
      // arg. Now the second double-quoted arg is data, so the marker is not
      // executed.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            "bash -lc 'cd packages/daemon && node_modules/.bin/vitest run",
            'bash -lc "true" "cd packages/daemon && node_modules/.bin/vitest run'
          ),
        'does not EXECUTE'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a spread override of include in a vitest config (P2)',
    () => {
      // A `...{ include: [...] }` AFTER the pinned literal wins in JS, so Vitest
      // matches none of the files while test_prop_has still finds the pinned line
      // and the guard reports every file covered.
      expectGuardRejects(
        path.join(REPO_ROOT, 'packages/web/vitest.config.ts'),
        (s) =>
          s.replace(
            "include: ['src/**/*.{test,spec}.{ts,tsx}'],",
            "include: ['src/**/*.{test,spec}.{ts,tsx}'],\n    ...{ include: ['src/__never__/**/*.test.ts'] },"
          ),
        "'...' spread inside test:"
      );
    },
    TIMEOUT
  );

  it(
    'rejects a needs: dependency on a guarded job (P2)',
    () => {
      // A needs: on a conditionally-skipped job (e.g. `discover`) skips this job
      // too, so its tests never run while the guard reports them covered.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            '  test-daemon-shared-unit:\n',
            '  test-daemon-shared-unit:\n    needs: discover\n'
          ),
        'has a needs: dependency'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a data-command first token on the unit runner',
    () => {
      // runner_is_data_cmd (distinct from the post-separator pin, which catches
      // `test -n`): an echo/printf/cat first token makes the marker an argument,
      // so zero tests run. Uses the unit runner, where this detector sits before
      // runner_post_sep_starts_with and is reachable.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            './scripts/test-daemon.sh ${{ matrix.shard }} --coverage',
            'echo ./scripts/test-daemon.sh ${{ matrix.shard }} --coverage'
          ),
        'first command token is a data command'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a block-form matrix.exclude in the unit workflow',
    () => {
      // matrix_excludes parses BOTH flow and block forms; only the flow form
      // (real-api) was tested. A block-form exclude: silently drops a shard.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            '5-space-runtime-a, 5-space-runtime-b]\n',
            '5-space-runtime-a, 5-space-runtime-b]\n        exclude:\n          - shard: shared\n'
          ),
        'matrix.exclude'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a non-allowlisted key in an online include row',
    () => {
      // An include row carrying an extra key (e.g. replica: b) adds a hidden
      // matrix combination GitHub schedules, evading the module/sibling-axis
      // checks (which iterate the axis and top-level matrix keys, not row keys).
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            '          - module: agent-sdk\n',
            '          - module: agent-sdk\n            replica: b\n'
          ),
        'non-allowlisted key'
      );
    },
    TIMEOUT
  );

  it(
    "does not leak a second job's module axis into the online axis set",
    () => {
      // _axis_modules must reset injob at the next job key; otherwise a later
      // job's module: axis leaks into the online axis set and (here) duplicates
      // a real module → false "appears more than once". With the reset the guard
      // stays green.
      const wf = path.join(REPO_ROOT, '.github/workflows/main.yml');
      const original = fs.readFileSync(wf, 'utf-8');
      const anchor = '  test-daemon-shared-unit:\n';
      expect(original.includes(anchor)).toBe(true);
      const leak =
        '  zzz-axis-leak:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        module:\n          - components\n        include:\n          - module: components\n            test_path: x\n    steps:\n      - run: echo hi\n';
      fs.writeFileSync(wf, original.replace(anchor, leak + anchor));
      try {
        const { exitCode } = runGuard();
        expect(exitCode).toBe(0);
      } finally {
        fs.writeFileSync(wf, original);
      }
    },
    TIMEOUT
  );

  it(
    'rejects a module axis item with invalid characters (P2)',
    () => {
      // `- comp_onents` is a distinct value to GitHub (no test_path → unfiltered
      // run) while the include record makes a separate `components` combo; the
      // axis parser must validate the RAW item, not its normalized form.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) => s.replace('          - components\n', '          - comp_onents\n'),
        'module axis item'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a real-API include row without a module (P2)',
    () => {
      // A moduleless include row is still scheduled (empty module name); a
      // duplicate test_path then runs the paid real-API test twice while this
      // guard reports it covered.
      const wf = path.join(REPO_ROOT, '.github/workflows/real-api-tests.yml');
      const original = fs.readFileSync(wf, 'utf-8');
      const anchor = '          - module: cross-provider-2\n';
      expect(original.includes(anchor)).toBe(true);
      // Insert a moduleless row (test_path, no module) right after the anchor row.
      const idx = original.indexOf(anchor) + anchor.length;
      const moduleless =
        '          - test_path: tests/online/cross-provider/cross-provider-model-switch.test.ts\n';
      fs.writeFileSync(wf, original.slice(0, idx) + moduleless + original.slice(idx));
      try {
        const { exitCode, stderr } = runGuard();
        expect(exitCode).toBe(1);
        expect(stderr).toContain('without a non-empty module');
      } finally {
        fs.writeFileSync(wf, original);
      }
    },
    TIMEOUT
  );
});
