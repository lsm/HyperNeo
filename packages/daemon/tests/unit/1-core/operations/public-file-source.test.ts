import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPublicFileSource } from '../../../../src/storage/repositories/public-file-source.ts';

test('public file sources refuse non-human callers before reading storage', () => {
  const db = {
    prepare: () => {
      throw new Error('No storage access authorized');
    },
  };
  expect(
    readPublicFileSource(db as never, { kind: 'todo', id: 't' }, { source: 'mcp', role: 'neo' })
  ).toBeNull();
  expect(
    readPublicFileSource(db as never, { kind: 'message', id: 'm' }, { source: 'rpc' })
  ).toBeNull();
});

test('isolated daemon accepts public references and rejects hidden prompts and wrong owners', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'public-file-a1-')));
  for (const folder of ['home', 'bin', 'tmp']) mkdirSync(join(run, folder));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/public-file-source-a1.ts',
            import.meta.url
          )
        ),
        run,
      ],
      {
        cwd: run,
        env: {
          PATH: `${join(run, 'bin')}:${process.env.PATH}`,
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
    const evidence = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(evidence).toMatchObject({
      passed: true,
      publicText: true,
      ownerWorkspace: true,
      compatibility: true,
      hidden: { accepted: false },
      intakeHidden: { accepted: false },
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 35000);
