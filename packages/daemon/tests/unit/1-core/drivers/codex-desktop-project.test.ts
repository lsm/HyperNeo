import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCodexDesktopProject } from '../../../../src/lib/drivers/codex-desktop-project';

describe('ensureCodexDesktopProject', () => {
  let directory = '';
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  function fixture(listed: (folder: string) => Record<string, unknown>[]) {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-project-')));
    const folder = join(directory, 'repo with spaces');
    mkdirSync(folder);
    const pages = listed(folder);
    const calls: [string, Record<string, unknown>][] = [];
    const server = {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push([method, params]);
        if (method === 'project/list') return pages.shift() ?? { data: [] };
        return { project: { id: 'created-project', roots: params.roots } };
      },
    };
    return { folder, calls, server };
  }

  test('reuses the app-server project whose root is the folder, across pages', async () => {
    const f = fixture((folder) => [
      { data: [{ id: 'other', roots: [{ path: '/repos/other' }] }], nextCursor: 'page-2' },
      { data: [{ id: 'server-project', roots: [{ path: folder }] }], nextCursor: null },
    ]);
    expect(await ensureCodexDesktopProject(f.folder, f.server)).toBe('server-project');
    expect(f.calls).toEqual([
      ['project/list', {}],
      ['project/list', { cursor: 'page-2' }],
    ]);
  });

  test('creates a project for an unregistered folder without opening Desktop', async () => {
    const f = fixture(() => [{ data: [{ id: 'other', roots: [{ path: '/repos/other' }] }] }]);
    const link = join(directory, 'link');
    symlinkSync(f.folder, link);
    expect(await ensureCodexDesktopProject(link, f.server)).toBe('created-project');
    expect(f.calls[1]).toEqual([
      'project/create',
      {
        idempotencyKey: `hyperneo:${f.folder}`,
        name: 'repo with spaces',
        roots: [{ path: f.folder }],
      },
    ]);
  });

  test('fails when the app-server returns no project id', async () => {
    const f = fixture(() => []);
    const server = {
      call: async (method: string) => (method === 'project/list' ? { data: [] } : {}),
    };
    await expect(ensureCodexDesktopProject(f.folder, server)).rejects.toThrow(
      'Codex did not create a project'
    );
  });
});
