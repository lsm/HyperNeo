/**
 * Tests for scripts/validate-test-matrix.sh — the universal test-coverage guard.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

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
});
