import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemon = fileURLToPath(new URL('../../../', import.meta.url));
const suites = [
  'tests/unit/1-core/drivers/acp-agent-adapter.test.ts',
  'tests/unit/1-core/drivers/copilot-history-find.test.ts',
  'tests/unit/1-core/providers/codex-model-discovery.test.ts',
  'tests/unit/lib/oap/oap-stdio-client.test.ts',
  'tests/unit/2-handlers/job-handlers/skill-validate.handler.test.ts',
  'tests/unit/2-handlers/github/neo-read-checkout-sync.test.ts',
];

test('fixture suites remove their owned temporary directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-cleanup-proof-'));
  try {
    execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...suites], {
      cwd: daemon,
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
      stdio: 'pipe',
      timeout: 90000,
    });
    expect(
      readdirSync(root).filter((name) => /^(acp-|copilot-|hyperneo-|neo-|oap-)/.test(name))
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 100000);

test('shared-process Bun suites retain exit cleanup for later files', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-shared-process-'));
  const helper = fileURLToPath(new URL('../../helpers/temporary-directory.ts', import.meta.url));
  try {
    for (const name of ['first', 'second']) {
      writeFileSync(
        join(root, `${name}.test.ts`),
        `import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDirectory } from ${JSON.stringify(helper)};
test(${JSON.stringify(name)}, () => {
  const directory = createTestDirectory(join(process.env.FIXTURE_TMP_ROOT!, 'shared-process-'));
  expect(existsSync(directory)).toBe(true);
});
`
      );
    }
    execFileSync('bun', ['test', './first.test.ts', './second.test.ts'], {
      cwd: root,
      env: { PATH: process.env.PATH, FIXTURE_TMP_ROOT: root },
      stdio: 'pipe',
      timeout: 15000,
    });
    expect(readdirSync(root).filter((name) => name.startsWith('shared-process-'))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
