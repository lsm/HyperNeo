import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseWorkCleanup } from '../../../../src/lib/work-cleanup/release.ts';

const root = mkdtempSync(join(tmpdir(), 'cleanup-release-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('releaseWorkCleanup', () => {
  test('a successful archive that keeps the folder reports its reason and records no release', async () => {
    const recorded: string[] = [];
    const result = await releaseWorkCleanup(
      root,
      ['todo'],
      async () => true,
      async () => ({
        kind: 'completed',
        value: {
          ok: true,
          value: {
            archived: true,
            worktree: { removed: false, reason: 'Unpublished branch; kept.' },
          },
        },
      }),
      async (id) => {
        recorded.push(id);
      }
    );
    expect(result).toEqual({ keep: 'Unpublished branch; kept.' });
    expect(existsSync(root)).toBe(true);
    expect(recorded).toEqual([]);
  });

  test('a lost fence never archives the worker', async () => {
    let archives = 0;
    expect(
      await releaseWorkCleanup(
        root,
        [],
        async () => false,
        async () => {
          archives++;
          return { kind: 'failed', code: 'unexpected', message: 'Unexpected archive' };
        },
        async () => {}
      )
    ).toEqual({ keep: 'live' });
    expect(archives).toBe(0);
  });
});
