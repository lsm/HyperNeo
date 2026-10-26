import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('failed daemon startup releases its port and database and stops started processors', {
  timeout: 30_000,
}, async () => {
  const run = mkdtempSync(join(tmpdir(), 'startup-failure-'));
  mkdirSync(join(run, 'home'));
  mkdirSync(join(run, 'tmp'));
  try {
    const child = spawn(
      'bun',
      [resolve('../../.claude/skills/verify/daemon-startup-failure.ts'), run],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          HOME: join(run, 'home'),
          TMPDIR: join(run, 'tmp'),
          HYPERNEO_DATA_DIR: join(run, 'data'),
        },
        stdio: 'ignore',
      }
    );
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    const evidence = JSON.parse(readFileSync(join(run, 'evidence/startup-failure.json'), 'utf8'));
    expect(evidence).toMatchObject({ verified: true });
    expect(code).toBe(0);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
