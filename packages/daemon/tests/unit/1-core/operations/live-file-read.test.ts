import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveFileRead } from '../../../../src/lib/artifacts/live-file-read.ts';

const target = { sourceMessageOrCard: { kind: 'message', id: 'stored' }, reference: 'report.md' };
const noStorage = () => {
  throw new Error('No storage access authorized');
};

test('live reader accepts the identity of a public question card', () => {
  expect(
    createLiveFileRead(noStorage).inputSchema.safeParse({
      ...target,
      sourceMessageOrCard: { kind: 'question', id: 'public-question' },
    }).success
  ).toBe(true);
});

test('live reference input requires stored-source provenance and bounded continuation', () => {
  const operation = createLiveFileRead(noStorage);
  expect(operation.inputSchema.safeParse(target).success).toBe(true);
  for (const extra of [
    { offset: 1 },
    { offset: -1 },
    { maxBytes: 0 },
    { maxBytes: 262145 },
    { path: '/some/file' },
  ])
    expect(operation.inputSchema.safeParse({ ...target, ...extra }).success).toBe(false);
  expect(
    operation.inputSchema.safeParse({ ...target, offset: 1, version: 'a'.repeat(64) }).success
  ).toBe(true);
});

test('non-human live readers are rejected before any storage read', async () => {
  const operation = createLiveFileRead(noStorage);
  for (const caller of [
    { source: 'mcp' as const, role: 'neo' as const },
    { source: 'rpc' as const },
  ])
    expect(await operation.execute(target, caller)).toEqual({
      accepted: false,
      reason: 'forbidden',
    });
});

test('isolated daemon reads current bytes with version, safety and no persistence', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'live-file-a2-')));
  for (const folder of ['home', 'bin', 'tmp']) mkdirSync(join(run, folder));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/live-file-read-a2.ts', import.meta.url)
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
    const result = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({
      passed: true,
      noRowsOrBlobs: true,
      safetyAndReauthorization: true,
      unlinkedPublication: true,
      resourcesClosed: true,
      deleted: { accepted: false, reason: 'missing' },
    });
    expect(result.readA).toBe('# Version A 🦊\n');
    expect(result.readB).toBe('# Version B 🦊\n');
    expect(result.chunks).toBeGreaterThan(1);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 35000);
