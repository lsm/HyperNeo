import { createTestDirectory } from '../../../helpers/temporary-directory';
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Neo reads a current default-branch checkout', () => {
  test('the existing poll RPC advances a detached clone while human edits stay untouched', () => {
    const run = realpathSync(createTestDirectory(join(tmpdir(), 'neo-read-checkout-')));
    mkdirSync(join(run, 'home'));
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/neo-read-checkout-sync.ts',
            import.meta.url
          )
        ),
        'verify',
        run,
      ],
      {
        env: {
          PATH: `${join(run, 'bin')}:${process.env.PATH}`,
          HOME: join(run, 'home'),
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
          HYPERNEO_USE_DEV_PROXY: '1',
          LOG_LEVEL: 'error',
        },
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    const result = JSON.parse(output);
    expect(result.created).toBe(true);
    expect(result.readHead).toBe(result.originAdvanced);
    expect(result.readHead).not.toBe(result.initial);
    expect(result.humanAfter).toEqual(result.humanBefore);
    expect(result.content).toBe('version two\n');
    expect(result.verified).toBe(true);
  }, 30_000);
});
