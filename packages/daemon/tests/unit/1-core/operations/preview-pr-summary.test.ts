import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactPrSummarySchema,
  readArtifactPrSummary,
} from '../../../../src/lib/artifacts/pr-summary.ts';

describe('bound PR preview summaries', () => {
  test('rejects malformed summary contracts', () => {
    expect(ArtifactPrSummarySchema.safeParse({ title: 'incomplete' }).success).toBe(false);
  });
  test('accepts gh changeType metadata but keeps the output file contract strict', async () => {
    const ghFile = { path: 'docs/report.md', additions: 1, deletions: 0, changeType: 'ADDED' };
    const response = {
      url: 'https://github.com/example/project/pull/42',
      title: 'Preview document',
      body: '',
      state: 'OPEN',
      headRefOid: 'a'.repeat(40),
      reviews: [],
      statusCheckRollup: [],
      changedFiles: 1,
      files: [ghFile],
    };
    const summary = await readArtifactPrSummary(
      { repository: 'github.com/example/project', number: 42 },
      () => ({
        stdout: new Response(JSON.stringify(response)).body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill() {},
      })
    );
    expect(summary).not.toBeNull();
    expect(summary?.files).toEqual([{ path: 'docs/report.md', additions: 1, deletions: 0 }]);
    expect(ArtifactPrSummarySchema.safeParse({ ...summary, files: [ghFile] }).success).toBe(false);
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
