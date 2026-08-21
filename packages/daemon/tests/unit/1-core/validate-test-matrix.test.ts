import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const GUARD = 'scripts/validate-test-matrix.sh';
const TIMEOUT = 180_000;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperneo-vmx-'));
const FX = path.join(WORK_DIR, 'fixture');

const BUILDER = `
set -euo pipefail
SRC="$1"
FX="$2"
mk() { mkdir -p "$(dirname "$1")"; printf 'it("x", () => {});\\n' > "$1"; }
for rel in .github/workflows/main.yml .github/workflows/real-api-tests.yml \\
  scripts/validate-test-matrix.sh scripts/test-daemon.sh scripts/test-online.sh \\
  scripts/lib/shard-split.sh packages/daemon/vitest.config.ts \\
  packages/daemon/vitest.online.config.ts packages/shared/vitest.config.ts \\
  packages/web/vitest.config.ts; do
  mkdir -p "$FX/$(dirname "$rel")"
  cp "$SRC/$rel" "$FX/$rel"
done
mkdir -p "$FX/node_modules/vitest" "$FX/node_modules/vite" "$FX/node_modules/@preact/preset-vite"
printf '{"name":"vitest","version":"0.0.0","type":"module","exports":{"./config":"./config.mjs"}}\\n' \\
  > "$FX/node_modules/vitest/package.json"
printf 'export function defineConfig(c) { return c; }\\n' > "$FX/node_modules/vitest/config.mjs"
printf '{"name":"vite","version":"0.0.0","type":"module","main":"index.mjs"}\\n' \\
  > "$FX/node_modules/vite/package.json"
printf 'export function defineConfig(c) { return c; }\\n' > "$FX/node_modules/vite/index.mjs"
printf '{"name":"@preact/preset-vite","version":"0.0.0","type":"module","main":"index.mjs"}\\n' \\
  > "$FX/node_modules/@preact/preset-vite/package.json"
printf 'export default () => [{ name: "preact:config" }];\\n' \\
  > "$FX/node_modules/@preact/preset-vite/index.mjs"
U="$FX/packages/daemon/tests/unit"
for f in 1-core/c.test.ts helpers/h.test.ts lib/acp/l.test.ts \\
  2-handlers/github/h.test.ts 2-handlers/db-query/d.test.ts \\
  2-handlers/job-handlers/j.test.ts 2-handlers/mcp/m.test.ts \\
  2-handlers/routes/ro.test.ts 2-handlers/rpc/p.test.ts \\
  2-handlers/rpc-handlers/rh.test.ts 2-handlers/short-id/si.test.ts \\
  5-space/workflow/w.test.ts 4-space-storage/s.test.ts 4-space-storage/app/a.test.ts \\
  4-space-storage/storage/st.test.ts 4-space-storage/storage/migrations/m1.test.ts \\
  4-space-storage/storage/migrations/m2.test.ts 5-space/s.test.ts 5-space/agent/a.test.ts \\
  5-space/other/o.test.ts 5-space/tools/t.test.ts \\
  5-space/runtime/r1.test.ts 5-space/runtime/connectors/c1.test.ts; do
  mk "$U/$f"
done
mk "$FX/packages/shared/tests/s.test.ts"
source "$FX/scripts/test-online.sh"
O="$FX/packages/daemon/tests/online"
set -f
for entry in \${ONLINE_MODULES[@]}; do
  name=$(printf '%s' "$entry" | cut -d'|' -f1)
  dir=$(dirname "$(printf '%s' "$entry" | cut -d'|' -f2 | cut -d';' -f1)")
  mk "$O/$dir/$name.test.ts"
done
for spec in \${ONLINE_HASH_SPLIT_SPECS[@]}; do
  IFS='|' read -r prefix count globs <<<"$spec"
  dir=$(dirname "$(printf '%s' "$globs" | cut -d';' -f1)")
  have=""
  i=0
  while [ "$(printf '%s' "$have" | wc -w | tr -d ' ')" -lt "$count" ] && [ "$i" -lt 500 ]; do
    name="$prefix$i.test.ts"
    relp="packages/daemon/tests/online/$dir/$name"
    h=$(printf '%s' "$relp" | cksum | awk '{print $1}')
    b=$((h % count))
    case " $have " in *" $b "*) ;; *) have="$have $b" ;; esac
    mk "$O/$dir/$name"
    i=$((i + 1))
  done
  if [ "$(printf '%s' "$have" | wc -w | tr -d ' ')" -lt "$count" ]; then
    echo "could not cover all $count buckets for $prefix" >&2
    exit 1
  fi
done
set +f
while IFS= read -r tp; do
  [ -n "$tp" ] || continue
  mk "$FX/packages/daemon/$tp"
done < <(grep -E '^[[:space:]]+test_path: ' "$FX/.github/workflows/real-api-tests.yml" | awk '{print $2}')
for d in benchmark glm providers sandbox; do
  mk "$O/$d/x.test.ts"
done
mk "$FX/packages/web/src/app.test.tsx"
mk "$FX/packages/web/src/lib.test.ts"
`;

interface GuardResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  prepareError: boolean;
}

interface Scenario {
  name: string;
  realRepo?: boolean;
  mutate?: (root: string) => void;
  expectExit: 0 | 1;
  expectInStderr?: string;
}

function edit(root: string, rel: string, mutate: (original: string) => string): void {
  const file = path.join(root, rel);
  const original = fs.readFileSync(file, 'utf-8');
  const mutated = mutate(original);
  expect(mutated).not.toBe(original);
  fs.writeFileSync(file, mutated);
}

const MAIN = '.github/workflows/main.yml';
const REAL_API = '.github/workflows/real-api-tests.yml';
const WEB_CFG = 'packages/web/vitest.config.ts';

const SCENARIOS: Scenario[] = [
  {
    name: 'exits 0 on the real repo (the guard is green)',
    realRepo: true,
    expectExit: 0,
  },
  {
    name: 'exits 0 on the pristine fixture repo',
    expectExit: 0,
  },
  {
    name: 'detects an orphaned unit test file not covered by any shard',
    expectExit: 1,
    expectInStderr: 'not covered',
    mutate: (root) => {
      fs.writeFileSync(
        path.join(root, 'packages/daemon/tests/unit/zzz-guard-test-orphan.test.ts'),
        "import { it } from 'bun:test';\nit('orphan', () => {});\n"
      );
    },
  },
  {
    name: 'rejects a matrix.exclude in the real-API workflow',
    expectExit: 1,
    expectInStderr: 'matrix.exclude',
    mutate: (root) => {
      edit(root, REAL_API, (s) => {
        const anchor = '        include:\n';
        expect(s.includes(anchor)).toBe(true);
        return s.replace(anchor, `        exclude: [{ module: cross-provider-2 }]\n${anchor}`);
      });
    },
  },
  {
    name: 'rejects a dead "&&" prefix on the web runner',
    expectExit: 1,
    expectInStderr: "dead prefix ('||'/'&&'/exit/exec)",
    mutate: (root) => {
      edit(root, MAIN, (s) => {
        const anchor = "bash -lc 'cd packages/web && bunx vitest run";
        expect(s.includes(anchor)).toBe(true);
        return s.replace(anchor, "bash -lc 'false && cd packages/web && bunx vitest run");
      });
    },
  },
  {
    name: 'rejects an `exit` before the marker (P2)',
    expectExit: 1,
    expectInStderr: 'dead prefix',
    mutate: (root) => {
      edit(root, MAIN, (s) => {
        const anchor = "bash -lc 'cd packages/web && bunx vitest run";
        expect(s.includes(anchor)).toBe(true);
        return s.replace(anchor, "bash -lc 'exit 0; cd packages/web && bunx vitest run");
      });
    },
  },
  {
    name: 'rejects continue-on-error on the web runner',
    expectExit: 1,
    expectInStderr: 'continue-on-error: true',
    mutate: (root) => {
      edit(root, MAIN, (s) => {
        const anchor = '  test-web:\n    name: Web Tests';
        expect(s.includes(anchor)).toBe(true);
        return s.replace(anchor, '  test-web:\n    continue-on-error: true\n    name: Web Tests');
      });
    },
  },
  {
    name: 'rejects a workflow-scope defaults.run.shell (P1)',
    expectExit: 1,
    expectInStderr: 'non-default shell',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace('on:\n', 'on:\ndefaults:\n  run:\n    shell: bash -n {0}\n')
      );
    },
  },
  {
    name: 'rejects a non-default vitest root',
    expectExit: 1,
    expectInStderr: 'top-level root',
    mutate: (root) => {
      edit(root, WEB_CFG, (s) =>
        s.replace(
          'export default defineConfig({\n',
          "export default defineConfig({\n  root: 'src',\n"
        )
      );
    },
  },
  {
    name: 'rejects a compound job-level if: gate',
    expectExit: 1,
    expectInStderr: 'is not the pinned gate',
    mutate: (root) => {
      edit(root, MAIN, (s) => {
        const i = s.indexOf('  test-daemon-shared-unit:\n');
        const gate = "    if: github.event.inputs.run_e2e_only != 'true'\n";
        const j = s.indexOf(gate, i);
        return (
          s.slice(0, j) +
          "    if: github.event.inputs.run_e2e_only != 'true' && github.event_name == 'never'\n" +
          s.slice(j + gate.length)
        );
      });
    },
  },
  {
    name: 'rejects a no-exec interpreter prefix',
    expectExit: 1,
    expectInStderr: 'no-exec interpreter',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          './scripts/test-daemon.sh ${{ matrix.shard }} --coverage',
          'bash -n ./scripts/test-daemon.sh ${{ matrix.shard }} --coverage'
        )
      );
    },
  },
  {
    name: 'rejects a module value with invalid characters',
    expectExit: 1,
    expectInStderr: 'invalid characters',
    mutate: (root) => {
      edit(root, MAIN, (s) => s.replace('  - module: components\n', '  - module: comp_onents\n'));
    },
  },
  {
    name: 'rejects a "#" comment that blanks out the unit runner (P0)',
    expectExit: 1,
    expectInStderr: "has a '#' comment before",
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          'bun run scripts/flaky-test-runner.ts\n          --suite daemon-unit',
          'true # bun run scripts/flaky-test-runner.ts\n          --suite daemon-unit'
        )
      );
    },
  },
  {
    name: 'rejects a marker that is quoted/echoed as data, not executed',
    expectExit: 1,
    expectInStderr: 'does not EXECUTE',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          "bash -lc 'cd packages/web && bunx vitest run",
          "echo 'cd packages/web && bunx vitest run"
        )
      );
    },
  },
  {
    name: 'rejects a compound false step gate containing always() (P2)',
    expectExit: 1,
    expectInStderr: 'disabled',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          '      - name: Run daemon + shared unit tests (${{ matrix.shard }})\n',
          "      - name: Run daemon + shared unit tests (${{ matrix.shard }})\n        if: always() && github.event_name == 'never'\n"
        )
      );
    },
  },
  {
    name: 'ignores a defaults.run.shell under an UNRELATED job (P2)',
    expectExit: 0,
    mutate: (root) => {
      edit(root, MAIN, (s) => {
        const anchor = '  check:\n';
        expect(s.includes(anchor)).toBe(true);
        return s.replace(anchor, '  check:\n    defaults:\n      run:\n        shell: bash\n');
      });
    },
  },
  {
    name: 'rejects a double-quoted data wrapper (test -n) over the web marker',
    expectExit: 1,
    expectInStderr: 'does not EXECUTE',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          "bash -lc 'cd packages/web && bunx vitest run",
          'test -n "cd packages/web && bunx vitest run'
        )
      );
    },
  },
  {
    name: 'rejects a bash -lc command whose marker is a $0 positional (P2)',
    expectExit: 1,
    expectInStderr: 'does not EXECUTE',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          'bash -lc \'set -o pipefail; cd packages/daemon && paths=$(cd ../.. && scripts/test-online.sh ${{ matrix.module }}) && [ -n "$paths" ] || exit 1; node_modules/.bin/vitest run',
          'bash -lc "true" "set -o pipefail; cd packages/daemon && paths=$(cd ../.. && scripts/test-online.sh ${{ matrix.module }}) && [ -n \\"$paths\\" ] || exit 1; node_modules/.bin/vitest run'
        )
      );
    },
  },
  {
    name: 'rejects a spread override of include in a vitest config (P2)',
    expectExit: 1,
    expectInStderr: "'...' spread inside test:",
    mutate: (root) => {
      edit(root, WEB_CFG, (s) =>
        s.replace(
          "include: ['src/**/*.{test,spec}.{ts,tsx}'],",
          "include: ['src/**/*.{test,spec}.{ts,tsx}'],\n    ...{ include: ['src/__never__/**/*.test.ts'] },"
        )
      );
    },
  },
  {
    name: 'rejects a post-construction mutation of the effective config (P2)',
    expectExit: 1,
    expectInStderr: 'effective test config does not match',
    mutate: (root) => {
      edit(root, WEB_CFG, (s) => {
        const reassigned = s.replace(
          'export default defineConfig({',
          'const config = defineConfig({',
          1
        );
        return (
          reassigned.trimEnd() +
          "\nconfig.test!.include = ['src/lib/task-status.test.ts'];\nexport default config;\n"
        );
      });
    },
  },
  {
    name: 'rejects a needs: dependency on a guarded job (P2)',
    expectExit: 1,
    expectInStderr: 'has a needs: dependency',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          '  test-daemon-shared-unit:\n',
          '  test-daemon-shared-unit:\n    needs: discover\n'
        )
      );
    },
  },
  {
    name: 'rejects a data-command first token on the unit runner',
    expectExit: 1,
    expectInStderr: 'first command token is a data command',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          './scripts/test-daemon.sh ${{ matrix.shard }} --coverage',
          'echo ./scripts/test-daemon.sh ${{ matrix.shard }} --coverage'
        )
      );
    },
  },
  {
    name: 'rejects a block-form matrix.exclude in the unit workflow',
    expectExit: 1,
    expectInStderr: 'matrix.exclude',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          '5-space-runtime-g]\n',
          '5-space-runtime-g]\n        exclude:\n          - shard: shared\n'
        )
      );
    },
  },
  {
    name: 'rejects a non-allowlisted key in an online include row',
    expectExit: 1,
    expectInStderr: 'non-allowlisted key',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          '          - module: agent-sdk\n',
          '          - module: agent-sdk\n            replica: b\n'
        )
      );
    },
  },
  {
    name: 'rejects a hand-listed test_path reintroduced in an online include row',
    expectExit: 1,
    expectInStderr: 'non-allowlisted key',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          '          - module: agent-sdk\n            mock_sdk: true\n',
          '          - module: agent-sdk\n            test_path: tests/online/agent/agent-session-sdk.test.ts\n            mock_sdk: true\n'
        )
      );
    },
  },
  {
    name: 'rejects an online runner that bypasses test-online.sh resolution',
    expectExit: 1,
    expectInStderr: 'does not resolve its module',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          'paths=$(cd ../.. && scripts/test-online.sh ${{ matrix.module }}) && [ -n "$paths" ] || exit 1; node_modules/.bin/vitest run --config vitest.online.config.ts $paths',
          'paths=tests/online/rpc/rpc-config-handlers.test.ts; node_modules/.bin/vitest run --config vitest.online.config.ts $paths'
        )
      );
    },
  },
  {
    name: 'rejects an online matrix module dropped from scripts/test-online.sh',
    expectExit: 1,
    expectInStderr: 'resolves to 0 files',
    mutate: (root) => {
      edit(root, MAIN, (s) => s.replace('          - websocket\n', '          - websocket-x\n'));
    },
  },
  {
    name: 'rejects a mocked module glob that reaches a real-API-only directory',
    expectExit: 1,
    expectInStderr: 'real-API-only',
    mutate: (root) => {
      edit(root, 'scripts/test-online.sh', (s) =>
        s.replace('"mcp|mcp/*.test.ts"', '"mcp|mcp/*.test.ts;cross-provider/*.test.ts"')
      );
    },
  },
  {
    name: 'rejects a mocked module glob that reaches an exempt directory',
    expectExit: 1,
    expectInStderr: 're-enable an intentionally disabled module',
    mutate: (root) => {
      edit(root, 'scripts/test-online.sh', (s) =>
        s.replace('"mcp|mcp/*.test.ts"', '"mcp|mcp/*.test.ts;glm/*.test.ts"')
      );
    },
  },
  {
    name: 'rejects a runner that discards the module resolution before vitest run',
    expectExit: 1,
    expectInStderr: 'no positional',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          'node_modules/.bin/vitest run --config vitest.online.config.ts $paths',
          'node_modules/.bin/vitest run --config vitest.online.config.ts'
        )
      );
    },
  },
  {
    name: 'rejects a selection flag hidden before a second command substitution',
    expectExit: 1,
    expectInStderr: 'selection flag or extra arg',
    mutate: (root) => {
      edit(root, MAIN, (s) =>
        s.replace(
          'node_modules/.bin/vitest run --config vitest.online.config.ts $paths',
          'node_modules/.bin/vitest run --config vitest.online.config.ts $paths --testNamePattern=never $(cd ../.. && echo x)'
        )
      );
    },
  },
  {
    name: "does not leak a second job's module axis into the online axis set",
    expectExit: 0,
    mutate: (root) => {
      edit(root, MAIN, (s) => {
        const anchor = '  test-daemon-shared-unit:\n';
        expect(s.includes(anchor)).toBe(true);
        const leak =
          '  zzz-axis-leak:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        module:\n          - components\n        include:\n          - module: components\n            test_path: x\n    steps:\n      - run: echo hi\n';
        return s.replace(anchor, leak + anchor);
      });
    },
  },
  {
    name: 'rejects a module axis item with invalid characters (P2)',
    expectExit: 1,
    expectInStderr: 'module axis item',
    mutate: (root) => {
      edit(root, MAIN, (s) => s.replace('          - components\n', '          - comp_onents\n'));
    },
  },
  {
    name: 'rejects a real-API include row without a module (P2)',
    expectExit: 1,
    expectInStderr: 'without a non-empty module',
    mutate: (root) => {
      edit(root, REAL_API, (s) => {
        const anchor = '          - module: cross-provider-2\n';
        expect(s.includes(anchor)).toBe(true);
        const idx = s.indexOf(anchor) + anchor.length;
        const moduleless =
          '          - test_path: tests/online/cross-provider/cross-provider-model-switch.test.ts\n';
        return s.slice(0, idx) + moduleless + s.slice(idx);
      });
    },
  },
  {
    name: 'rejects a duplicate enabled runner step (P2)',
    expectExit: 1,
    expectInStderr: 'more than one',
    mutate: (root) => {
      edit(root, MAIN, (s) => {
        const anchor = '      - name: Run web tests\n';
        expect(s.includes(anchor)).toBe(true);
        return s.replace(
          anchor,
          `      - name: dup\n        run: cd packages/web && bunx vitest run --reporter dot\n${anchor}`
        );
      });
    },
  },
  {
    name: 'prunes dist/ from the shared disk scan (P2)',
    expectExit: 0,
    mutate: (root) => {
      const file = path.join(root, 'packages/shared/dist/guard-prune-test.test.ts');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "import { it } from 'bun:test';\nit('x', () => {});\n");
    },
  },
  {
    name: 'rejects a daemon .test.tsx the include does not cover (P2)',
    expectExit: 1,
    expectInStderr: '.tsx suffix',
    mutate: (root) => {
      fs.writeFileSync(
        path.join(root, 'packages/daemon/tests/unit/z-guard-tsx.test.tsx'),
        "import { it } from 'bun:test';\nit('x', () => {});\n"
      );
    },
  },
  {
    name: 'rejects a non-allowlisted plugin with a config hook (P2)',
    expectExit: 1,
    expectInStderr: 'effective test config does not match',
    mutate: (root) => {
      edit(root, WEB_CFG, (s) =>
        s.replace(
          '  plugins: [',
          "  plugins: [\n    { name: 'evil-narrower', config: () => ({ test: { include: ['src/one.test.ts'] } }) },\n"
        )
      );
    },
  },
  {
    name: 'rejects a marker nested in an echo inside a bash -lc body (P2)',
    expectExit: 1,
    expectInStderr: 'does not EXECUTE',
    mutate: (root) => {
      edit(root, MAIN, (s) => {
        const anchor =
          'bash -lc \'set -o pipefail; cd packages/daemon && paths=$(cd ../.. && scripts/test-online.sh ${{ matrix.module }}) && [ -n "$paths" ] || exit 1; node_modules/.bin/vitest run';
        expect(s.includes(anchor)).toBe(true);
        return s.replace(
          anchor,
          'bash -lc \'echo "set -o pipefail; cd packages/daemon && paths=$(cd ../.. && scripts/test-online.sh ${{ matrix.module }}) && [ -n \\"$paths\\"] || exit 1; node_modules/.bin/vitest run'
        );
      });
    },
  },
  {
    name: 'rejects a non-allowlisted plugin named with a framework prefix (P2)',
    expectExit: 1,
    expectInStderr: 'effective test config does not match',
    mutate: (root) => {
      edit(root, WEB_CFG, (s) =>
        s.replace(
          '  plugins: [',
          "  plugins: [\n    { name: 'vite-narrow-tests', config: () => ({ test: { include: ['x'] } }) },\n"
        )
      );
    },
  },
];

const resolvers: Array<(value: GuardResult) => void> = [];
const results = SCENARIOS.map(() => new Promise<GuardResult>((resolve) => resolvers.push(resolve)));

function effectiveCpus(): number {
  const cpus = os.cpus().length;
  try {
    const v2 = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf-8').trim().split(/\s+/);
    if (v2.length === 2 && v2[0] !== 'max' && /^\d+$/.test(v2[1])) {
      const quota = Number(v2[0]);
      const period = Number(v2[1]) || 100000;
      if (quota > 0) return Math.max(1, Math.min(cpus, Math.floor(quota / period)));
    }
    const quotaV1 = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf-8'));
    const periodV1 = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf-8'));
    if (quotaV1 > 0 && periodV1 > 0) {
      return Math.max(1, Math.min(cpus, Math.floor(quotaV1 / periodV1)));
    }
  } catch {
    return cpus;
  }
  return cpus;
}

async function runGuard(cwd: string, script: string): Promise<GuardResult> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/bash', [script], {
      cwd,
      encoding: 'utf-8',
      timeout: 150_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr, prepareError: false };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.code === 'number' ? e.code : -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(err),
      prepareError: false,
    };
  }
}

let caseSeq = 0;

async function runScenario(scenario: Scenario): Promise<GuardResult> {
  if (scenario.realRepo) {
    return runGuard(REPO_ROOT, path.join(REPO_ROOT, GUARD));
  }
  try {
    const root = path.join(WORK_DIR, `case-${String((caseSeq += 1))}`);
    fs.cpSync(FX, root, { recursive: true });
    if (scenario.mutate) {
      scenario.mutate(root);
    }
    return await runGuard(root, path.join(root, GUARD));
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String(err), prepareError: true };
  }
}

beforeAll(() => {
  const built = spawnSync('/bin/bash', ['-c', BUILDER, 'builder', REPO_ROOT, FX], {
    encoding: 'utf-8',
    timeout: 60_000,
  });
  if (built.status !== 0) {
    throw new Error(`fixture build failed (${built.status}):\n${built.stdout}\n${built.stderr}`);
  }
  const limit = Math.min(8, effectiveCpus());
  let cursor = 0;
  const workers = Array.from({ length: limit }, () => {
    return (async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= SCENARIOS.length) return;
        resolvers[index](await runScenario(SCENARIOS[index]));
      }
    })();
  });
  void Promise.all(workers);
}, 60_000);

afterAll(() => {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

describe('validate-test-matrix.sh', () => {
  for (const [index, scenario] of SCENARIOS.entries()) {
    it(
      scenario.name,
      async () => {
        const result = await results[index];
        if (result.prepareError) {
          throw new Error(result.stderr);
        }
        expect(result.exitCode).toBe(scenario.expectExit);
        if (scenario.expectInStderr) {
          expect(result.stderr).toContain(scenario.expectInStderr);
        }
      },
      TIMEOUT
    );
  }
});
