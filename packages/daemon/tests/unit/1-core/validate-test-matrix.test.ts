import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/validate-test-matrix.sh');
const TIMEOUT = 90_000;

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
      const wf = path.join(REPO_ROOT, '.github/workflows/real-api-tests.yml');
      const original = fs.readFileSync(wf, 'utf-8');
      const anchor = '          - module: cross-provider-2\n';
      expect(original.includes(anchor)).toBe(true);
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
