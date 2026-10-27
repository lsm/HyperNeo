import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const suites = [
  ['4-space-storage/storage/scoped-invalidation.test.ts', 'ReactiveDatabase — scope extraction'],
  ['4-space-storage/storage/scoped-messages-integration.test.ts', 'Scoped invalidation'],
  [
    '4-space-storage/storage/live-query-delivery-status.test.ts',
    'delivery-status reactive pipeline',
  ],
  ['2-handlers/rpc-handlers/live-query-handlers.test.ts', 'sessions.list reactive scope filter'],
  ['2-handlers/rpc-handlers/inactivity-nag-mailbox-probes.test.ts', 'inactivity nag probes'],
];

for (const [suite, filter] of suites) {
  test.each([false, true])(
    `${suite} removes fixtures after failure=%s`,
    (fail) => {
      const root = mkdtempSync(join(tmpdir(), 'backup-hygiene-'));
      try {
        const preload = join(root, 'force-failure.ts');
        writeFileSync(
          preload,
          "import { afterEach } from 'bun:test'; afterEach(() => { throw new Error('forced hygiene failure'); });"
        );
        const result = spawnSync(
          process.execPath,
          [
            'test',
            ...(fail ? ['--preload', preload] : []),
            join(daemonRoot, 'tests/unit', suite),
            '--test-name-pattern',
            filter,
          ],
          {
            cwd: daemonRoot,
            env: { ...process.env, TMPDIR: root },
            encoding: 'utf8',
            timeout: 120000,
          }
        );
        if (result.error) throw result.error;
        const output = `${result.stdout}${result.stderr}`;
        expect(output).toMatch(/Ran \d+ tests?/);
        if (fail) {
          expect(output).toContain('forced hygiene failure');
          expect(result.status).toBe(1);
        } else {
          expect(result.status).toBe(0);
        }
        expect(readdirSync(root).filter((name) => name !== 'force-failure.ts')).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    150000
  );
}
