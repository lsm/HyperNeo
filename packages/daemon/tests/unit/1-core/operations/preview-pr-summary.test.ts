import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactPrSummarySchema } from '../../../../src/lib/artifacts/pr-summary.ts';

describe('bound PR preview summaries', () => {
  test('rejects malformed summary contracts', () => {
    expect(ArtifactPrSummarySchema.safeParse({ title: 'incomplete' }).success).toBe(false);
  });
  test('reads only the stored bound GitHub target through the existing gh service', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-pr-summary-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/preview-pr-summary.ts',
              import.meta.url
            )
          ),
          root,
        ],
        {
          cwd: root,
          env: {
            PATH: `${join(root, 'bin')}:${process.env.PATH}`,
            HOME: join(root, 'home'),
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        sourceBound: true,
        knownRepository: true,
        boundedMetadata: true,
        exactHead: true,
        noByteCapture: true,
        revoked: true,
        restart: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
