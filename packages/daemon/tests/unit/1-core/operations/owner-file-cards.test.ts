import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test.each(['file-reference-cards-b1-web-seed.ts', 'owner-home-web-seed.ts'])(
  '%s creates the real browser fixture',
  (helper) => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'owner-card-seed-')));
    for (const name of ['home', 'tmp', 'bin']) mkdirSync(join(run, name));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(`../../../../../../.claude/skills/verify/${helper}`, import.meta.url)
          ),
          run,
          'seed',
        ],
        {
          cwd: run,
          env: {
            HOME: join(run, 'home'),
            HYPERNEO_DATA_DIR: join(run, 'data'),
            TMPDIR: join(run, 'tmp'),
            PATH: `${join(run, 'bin')}:${process.env.PATH}`,
            NODE_ENV: 'test',
            LOG_LEVEL: 'error',
          },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(readFileSync(join(run, 'workspace/current notes.md'), 'utf8')).toContain('Live A');
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  },
  35000
);

test('a PR basename cannot become a card for Neo private cwd, while explicit owner paths still read current bytes', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'owner-file-cards-')));
  for (const name of ['home', 'tmp', 'bin']) mkdirSync(join(run, name));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/owner-file-cards.ts', import.meta.url)
        ),
        run,
      ],
      {
        env: {
          HOME: join(run, 'home'),
          HYPERNEO_DATA_DIR: join(run, 'data'),
          TMPDIR: join(run, 'tmp'),
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          LOG_LEVEL: 'error',
        },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    expect(JSON.parse(output)).toMatchObject({
      passed: true,
      bareRejected: true,
      policyReason: 'sensitive_path',
      wireReason: 'forbidden',
      liveReadEditDelete: true,
      noNewRows: true,
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
