import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('local registration is absent from discovery and refuses RPC/MCP without writes', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'retire-register-')));
  for (const folder of ['home', 'bin', 'tmp']) mkdirSync(join(run, folder));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/retire-local-register.ts',
            import.meta.url
          )
        ),
        run,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: join(run, 'home'),
          HYPERNEO_DATA_DIR: join(run, 'data'),
          TMPDIR: join(run, 'tmp'),
          NODE_ENV: 'test',
          LOG_LEVEL: 'error',
        },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    expect(JSON.parse(output)).toMatchObject({
      passed: true,
      absentFromCatalog: true,
      rpcUnknown: true,
      mcpUnknown: true,
      noNewRows: true,
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 35000);
