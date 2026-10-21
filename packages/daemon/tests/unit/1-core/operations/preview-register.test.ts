import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RegisterArtifactInput } from '../../../../src/lib/artifacts/register-operation.ts';

describe('artifact registration', () => {
  test('rejects caller supplied roots and owner identity at the input boundary', () => {
    const input = {
      requestId: 'r1',
      context: { kind: 'todo', id: 't1' },
      path: 'report.md',
      title: 'Report',
    };
    expect(RegisterArtifactInput.safeParse(input).success).toBe(true);
    for (const extra of [{ root: '/synthetic' }, { ownerId: 'other' }, { kind: 'html' }])
      expect(RegisterArtifactInput.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(
      RegisterArtifactInput.safeParse({
        ...input,
        context: { ...input.context, root: '/synthetic' },
      }).success
    ).toBe(false);
  });
  test('registers durable authorized immutable receipts across retries and restart', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-register-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [resolve('../../.claude/skills/verify/preview-register.ts'), root],
        {
          env: { PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'test' },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        durableReceipt: true,
        retryAfterRemoval: true,
        changedHashRefused: true,
        authorizationRechecked: true,
        concurrentIdempotent: true,
        migratedTwice: true,
        registryExcluded: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
