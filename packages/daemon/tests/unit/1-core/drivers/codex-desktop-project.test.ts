import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexDesktopProject,
  ensureCodexDesktopProject,
} from '../../../../src/lib/drivers/codex-desktop-project';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';

describe('ensureCodexDesktopProject', () => {
  let directory = '';
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  function fixture() {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-project-')));
    const folder = join(directory, 'repo with spaces');
    const home = join(directory, 'codex');
    mkdirSync(folder);
    mkdirSync(home);
    const state = {
      'local-projects': { 'desktop-project': { rootPaths: [folder] } },
      'app-server-project-id-by-legacy-project-id-by-host': {
        [`local:${home}`]: { 'desktop-project': 'server-project' },
      },
    };
    const register = () =>
      writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify(state));
    return { folder, home, state, register };
  }

  test('registers the folder through Desktop and returns its acknowledged server project identity', async () => {
    const f = fixture();
    const opened: string[][] = [];
    const spawn: SpawnFn = (args) => {
      opened.push(args);
      setTimeout(f.register, 10);
      return {
        stdout: null,
        stderr: null,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    };
    expect(await ensureCodexDesktopProject(f.folder, f.home, spawn)).toBe('server-project');
    expect(opened).toHaveLength(1);
    expect(opened[0].slice(0, 2)).toEqual(['open', '-g']);
    const url = new URL(opened[0][2]);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('codex://threads/new');
    expect(url.searchParams.get('path')).toBe(f.folder);
    expect(codexDesktopProject(f.state, f.folder, f.home)).toBe('server-project');
  });

  test('reuses an already registered Desktop project without opening another window', async () => {
    const f = fixture();
    f.register();
    expect(
      await ensureCodexDesktopProject(f.folder, f.home, () => {
        throw new Error('Must not open another window');
      })
    ).toBe('server-project');
  });

  test('reports a failed Desktop launch instead of starting ungrouped work', async () => {
    const f = fixture();
    await expect(
      ensureCodexDesktopProject(f.folder, f.home, () => ({
        stdout: null,
        stderr: new Response('Desktop unavailable').body,
        exited: Promise.resolve(1),
        exitCode: 1,
        kill: () => {},
      }))
    ).rejects.toThrow('Desktop unavailable');
  });
});

describe('codexDesktopProject', () => {
  test('ignores a different root or a missing server mapping', () => {
    const state = {
      'local-projects': { desktop: { rootPaths: ['/repos/web'] } },
      'app-server-project-id-by-legacy-project-id-by-host': {
        'local:/codex': { desktop: 'server-project' },
      },
    };
    expect(codexDesktopProject(state, '/repos/web-other', '/codex')).toBeUndefined();
    expect(
      codexDesktopProject({ 'local-projects': state['local-projects'] }, '/repos/web', '/codex')
    ).toBeUndefined();
  });
});
