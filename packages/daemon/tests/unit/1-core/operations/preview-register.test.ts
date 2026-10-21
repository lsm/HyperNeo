import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  test('registers durable receipts from an unrelated working directory', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-register-')));
    mkdirSync(join(root, 'home'));
    const previousWorkingDirectory = process.cwd();
    try {
      process.chdir(root);
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL('../../../../../../.claude/skills/verify/preview-register.ts', import.meta.url)
          ),
          root,
        ],
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
      process.chdir(previousWorkingDirectory);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
