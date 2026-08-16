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
  'scripts/test-online.sh',
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
        expect(stderr).toContain("dead prefix ('||'/'&&'/exit/exec)");
      } finally {
        fs.writeFileSync(wf, original);
      }
    },
    TIMEOUT
  );

  it(
    'rejects an `exit` before the marker (P2)',
    () => {
      // `exit 0; <marker>` terminates the shell before the marker — dead_prefix
      // must catch process-terminating commands (exit/exec), not only ||/&&.
      const wf = path.join(REPO_ROOT, '.github/workflows/main.yml');
      const original = fs.readFileSync(wf, 'utf-8');
      const anchor = "bash -lc 'cd packages/web && bunx vitest run";
      expect(original.includes(anchor)).toBe(true);
      fs.writeFileSync(
        wf,
        original.replace(anchor, "bash -lc 'exit 0; cd packages/web && bunx vitest run")
      );
      try {
        const { exitCode, stderr } = runGuard();
        expect(exitCode).toBe(1);
        expect(stderr).toContain('dead prefix');
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
            'bash -lc \'set -o pipefail; cd packages/daemon && paths=$(cd ../.. && scripts/test-online.sh ${{ matrix.module }}) && [ -n "$paths" ] || exit 1; node_modules/.bin/vitest run',
            'bash -lc "true" "set -o pipefail; cd packages/daemon && paths=$(cd ../.. && scripts/test-online.sh ${{ matrix.module }}) && [ -n \\"$paths\\" ] || exit 1; node_modules/.bin/vitest run'
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
    'rejects a post-construction mutation of the effective config (P2)',
    () => {
      // `const c = defineConfig({...}); c.test!.include = ['one/file']; export
      // default c;` leaves the source literal intact (so text checks pass) while
      // Vitest resolves the mutated include. The guard loads the config via bun
      // and compares the EFFECTIVE include/exclude to the pinned literals.
      expectGuardRejects(
        path.join(REPO_ROOT, 'packages/web/vitest.config.ts'),
        (s) => {
          const reassigned = s.replace(
            'export default defineConfig({',
            'const config = defineConfig({',
            1
          );
          return (
            reassigned.trimEnd() +
            "\nconfig.test!.include = ['src/lib/task-status.test.ts'];\nexport default config;\n"
          );
        },
        'effective test config does not match'
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
            '5-space-runtime-b, 5-space-runtime-c]\n',
            '5-space-runtime-b, 5-space-runtime-c]\n        exclude:\n          - shard: shared\n'
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
    'rejects a hand-listed test_path reintroduced in an online include row',
    () => {
      // test-daemon-online include rows must carry module/mock_sdk/timeout
      // only — a test_path row silently bypasses the runner's test-online.sh
      // resolution while the resolution-driven ownership walk keeps reporting
      // the same file covered by its module (duplicate runs).
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            '          - module: agent-sdk\n            mock_sdk: true\n',
            '          - module: agent-sdk\n            test_path: tests/online/agent/agent-session-sdk.test.ts\n            mock_sdk: true\n'
          ),
        'non-allowlisted key'
      );
    },
    TIMEOUT
  );

  it(
    'rejects an online runner that bypasses test-online.sh resolution',
    () => {
      // The mocked-online runner must resolve ${{ matrix.module }} through
      // scripts/test-online.sh; a fixed positional (here: one rpc file) runs
      // that one file in EVERY matrix job while the guard's resolution-driven
      // ownership walk reports every module's files covered.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            'paths=$(cd ../.. && scripts/test-online.sh ${{ matrix.module }}) && [ -n "$paths" ] || exit 1; node_modules/.bin/vitest run --config vitest.online.config.ts $paths',
            'paths=tests/online/rpc/rpc-config-handlers.test.ts; node_modules/.bin/vitest run --config vitest.online.config.ts $paths'
          ),
        'does not resolve its module'
      );
    },
    TIMEOUT
  );

  it(
    'rejects an online matrix module dropped from scripts/test-online.sh',
    () => {
      // A matrix module the resolver cannot resolve expands to zero vitest
      // positionals → an unfiltered run of the ENTIRE online suite while this
      // guard would otherwise report every file covered by its module.
      // Simulate by renaming the websocket axis entry to a module with no
      // configuration row.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) => s.replace('          - websocket\n', '          - websocket-x\n'),
        'resolves to 0 files'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a mocked module glob that reaches a real-API-only directory',
    () => {
      // cross-provider files are owned by paid real-API rows; a mocked module
      // whose glob reaches into the directory duplicates every run through
      // Dev Proxy. The ownership walk must catch the cross-workspace owner.
      expectGuardRejects(
        path.join(REPO_ROOT, 'scripts/test-online.sh'),
        (s) => s.replace('"mcp|mcp/*.test.ts"', '"mcp|mcp/*.test.ts;cross-provider/*.test.ts"'),
        'real-API-only'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a mocked module glob that reaches an exempt directory',
    () => {
      // Exempt dirs (e.g. glm) are intentionally disabled; a module glob that
      // resolves their files re-enables them. The exempt check compares the
      // daemon-package-relative map paths, so the pattern must carry the
      // tests/online/ prefix (previously it never matched — dead check).
      expectGuardRejects(
        path.join(REPO_ROOT, 'scripts/test-online.sh'),
        (s) => s.replace('"mcp|mcp/*.test.ts"', '"mcp|mcp/*.test.ts;glm/*.test.ts"'),
        're-enable an intentionally disabled module'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a runner that discards the module resolution before vitest run',
    () => {
      // The resolution must FEED vitest: resolving into a variable that is
      // then redirected to /dev/null leaves vitest with zero positionals →
      // the entire online suite runs unfiltered while every textual detector
      // (marker present, marker executed, no dead prefix) still passes.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            'node_modules/.bin/vitest run --config vitest.online.config.ts $paths',
            'node_modules/.bin/vitest run --config vitest.online.config.ts'
          ),
        'no positional'
      );
    },
    TIMEOUT
  );

  it(
    'rejects a selection flag hidden before a second command substitution',
    () => {
      // The resolver-substitution allowlist must be bounded to ONE
      // substitution: a greedy match spanning first-$(-to-last-) blanks a
      // --testNamePattern sandwiched before a trailing second substitution.
      expectGuardRejects(
        path.join(REPO_ROOT, '.github/workflows/main.yml'),
        (s) =>
          s.replace(
            'node_modules/.bin/vitest run --config vitest.online.config.ts $paths',
            'node_modules/.bin/vitest run --config vitest.online.config.ts $paths --testNamePattern=never $(cd ../.. && echo x)'
          ),
        'selection flag or extra arg'
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

  it(
    'rejects a duplicate enabled runner step (P2)',
    () => {
      // enabled_run_cmd returns the first matching step; a second enabled runner
      // step re-runs the suite. count_enabled_run_cmds requires exactly one.
      const wf = path.join(REPO_ROOT, '.github/workflows/main.yml');
      const original = fs.readFileSync(wf, 'utf-8');
      const anchor = '      - name: Run web tests\n';
      expect(original.includes(anchor)).toBe(true);
      fs.writeFileSync(
        wf,
        original.replace(
          anchor,
          `      - name: dup\n        run: cd packages/web && bunx vitest run --reporter dot\n${anchor}`
        )
      );
      try {
        const { exitCode, stderr } = runGuard();
        expect(exitCode).toBe(1);
        expect(stderr).toContain('more than one');
      } finally {
        fs.writeFileSync(wf, original);
      }
    },
    TIMEOUT
  );

  it(
    'prunes dist/ from the shared disk scan (P2)',
    () => {
      // A *.test.ts under dist is excluded by the pinned config; the disk scan
      // must prune it or bun run check false-positives. Only removes dist if this
      // test created it.
      const fake = path.join(REPO_ROOT, 'packages/shared/dist/guard-prune-test.test.ts');
      const dir = path.dirname(fake);
      const dirExisted = fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fake, "import { it } from 'bun:test';\nit('x', () => {});\n");
      try {
        const { exitCode } = runGuard();
        expect(exitCode).toBe(0);
      } finally {
        fs.unlinkSync(fake);
        if (!dirExisted) fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TIMEOUT
  );

  it(
    'rejects a daemon .test.tsx the include does not cover (P2)',
    () => {
      // The daemon/shared include is *.test.ts/*_test.ts (no .tsx); a .test.tsx
      // would neither run nor be flagged. Surface it explicitly.
      const fake = path.join(REPO_ROOT, 'packages/daemon/tests/unit/z-guard-tsx.test.tsx');
      fs.writeFileSync(fake, "import { it } from 'bun:test';\nit('x', () => {});\n");
      try {
        const { exitCode, stderr } = runGuard();
        expect(exitCode).toBe(1);
        expect(stderr).toContain('.tsx suffix');
      } finally {
        fs.unlinkSync(fake);
      }
    },
    TIMEOUT
  );

  it(
    'rejects a non-allowlisted plugin with a config hook (P2)',
    () => {
      // A plugin config hook can narrow test selection at resolution time
      // (invisible to a static import). Vitest resolveConfig isn't importable
      // here, so reject config/configResolved hooks on non-framework plugins.
      expectGuardRejects(
        path.join(REPO_ROOT, 'packages/web/vitest.config.ts'),
        (s) =>
          s.replace(
            '  plugins: [',
            "  plugins: [\n    { name: 'evil-narrower', config: () => ({ test: { include: ['src/one.test.ts'] } }) },\n"
          ),
        'effective test config does not match'
      );
    },
    TIMEOUT
  );
});

it(
  'rejects a marker nested in an echo inside a bash -lc body (P2)',
  () => {
    // bash -lc 'echo "<marker>"' — the marker is echo's data arg inside the
    // -lc body, not executed. strip_quotes on the -lc body catches it.
    const wf = path.join(REPO_ROOT, '.github/workflows/main.yml');
    const original = fs.readFileSync(wf, 'utf-8');
    const anchor =
      'bash -lc \'set -o pipefail; cd packages/daemon && paths=$(cd ../.. && scripts/test-online.sh ${{ matrix.module }}) && [ -n "$paths" ] || exit 1; node_modules/.bin/vitest run';
    expect(original.includes(anchor)).toBe(true);
    fs.writeFileSync(
      wf,
      original.replace(
        anchor,
        'bash -lc \'echo "set -o pipefail; cd packages/daemon && paths=$(cd ../.. && scripts/test-online.sh ${{ matrix.module }}) && [ -n \\"$paths\\"] || exit 1; node_modules/.bin/vitest run'
      )
    );
    try {
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain('does not EXECUTE');
    } finally {
      fs.writeFileSync(wf, original);
    }
  },
  TIMEOUT
);

it(
  'rejects a non-allowlisted plugin named with a framework prefix (P2)',
  () => {
    // A plugin named "vite-narrow-tests" starts with "vite" but is NOT in the
    // exact allowlist; its config hook must be rejected.
    expectGuardRejects(
      path.join(REPO_ROOT, 'packages/web/vitest.config.ts'),
      (s) =>
        s.replace(
          '  plugins: [',
          "  plugins: [\n    { name: 'vite-narrow-tests', config: () => ({ test: { include: ['x'] } }) },\n"
        ),
      'effective test config does not match'
    );
  },
  TIMEOUT
);
