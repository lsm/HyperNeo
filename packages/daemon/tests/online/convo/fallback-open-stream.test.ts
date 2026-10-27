import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('fallback consumes the original prompt when the prior SDK stream remains open', async () => {
  const run = await mkdtemp(join(tmpdir(), 'fallback-query-'));
  for (const name of ['home', 'tmp']) await mkdir(join(run, name));
  try {
    const helper = fileURLToPath(
      new URL('../../../../../.claude/skills/verify/fallback-query-wait.ts', import.meta.url)
    );
    const result = spawnSync('bun', [helper, run], {
      env: {
        HOME: join(run, 'home'),
        PATH: `${join(run, 'bin')}:${process.env.PATH}`,
        TMPDIR: join(run, 'tmp'),
        NODE_ENV: 'test',
        HYPERNEO_DATA_DIR: join(run, 'data'),
        LOG_LEVEL: 'error',
      },
      timeout: 35000,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || String(result.error ?? '')).toBe(0);
    const observed = JSON.parse(
      await readFile(join(run, 'evidence/fallback-query-wait.json'), 'utf8')
    ) as {
      session: { config: { model: string } };
      results: { result?: string }[];
      resourcesStopped: boolean;
    };
    expect(observed.session.config.model).toContain('sonnet');
    expect(observed.results.some((message) => message.result === 'FALLBACK_RECOVERED')).toBe(true);
    expect(observed.resourcesStopped).toBe(true);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
}, 45000);
