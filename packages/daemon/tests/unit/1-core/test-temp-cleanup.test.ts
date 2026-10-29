import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 100000);
