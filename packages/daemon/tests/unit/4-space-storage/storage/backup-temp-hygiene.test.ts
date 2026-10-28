import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const suites = [
  ['4-space-storage/storage/database-facade.test.ts', 'creates a Database instance'],
  [
    '1-core/core/backfill-deepseek-provider.test.ts',
    'backfillDeepSeekProvider|migrateProvidersIfNeeded',
  ],
  ['4-space-storage/storage/scoped-invalidation.test.ts', 'ReactiveDatabase — scope extraction'],
  [
    '4-space-storage/storage/scoped-messages-integration.test.ts',
    'writing message for sess-A DOES trigger delta',
  ],
  [
    '4-space-storage/storage/live-query-delivery-status.test.ts',
    'delivery-status reactive pipeline',
  ],
  ['2-handlers/rpc-handlers/live-query-handlers.test.ts', 'sessions.list reactive scope filter'],
  [
    '2-handlers/rpc-handlers/inactivity-nag-mailbox-probes.test.ts',
    'treats an active admission for the nag claim key as pending delivery',
  ],
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
          'bun',
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
          expect(result.status, output).toBe(0);
        }
        expect(readdirSync(root).filter((name) => name !== 'force-failure.ts')).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    150000
  );
}
