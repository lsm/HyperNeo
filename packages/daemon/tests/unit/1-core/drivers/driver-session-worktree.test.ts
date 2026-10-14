import { describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo } from '@hyperneo/shared';
import {
  type CreateSessionParams,
  ModelUnavailableError,
} from '../../../../src/lib/session/session-lifecycle.ts';
import {
  createDriverSession,
  newestAvailableModel,
  hyperneoSessionControl,
} from '../../../../src/lib/rpc-handlers/family-operations/drivers.ts';

describe('hyperneoSessionControl archive', () => {
  test.each(['idle', 'busy', 'clones', 'late_refusal', 'archived'])(
    'uses the preserving lifecycle only for an admitted idle session (%s)',
    async (state) => {
      const archived: string[] = [];
      const session = { id: 'session', status: state === 'archived' ? 'archived' : 'active' };
      const controls = hyperneoSessionControl({
        deps: {
          db: { listChildSessions: () => (state === 'clones' ? [{ id: 'child' }] : []) },
          sessionManager: {
            getSessionFromDB: () => session,
            getCachedSession: () => ({
              getProcessingState: () => ({ status: state === 'busy' ? 'processing' : 'idle' }),
            }),
            archiveSessionResources: async (id: string, trigger: string) => {
              archived.push(`${id}:${trigger}`);
            },
          },
        },
      } as never);
      const result = await controls.archive!({ adapter: 'hyperneo', id: 'session' }, () =>
        state === 'late_refusal' ? { ok: false, reason: 'live_card', detail: 'new' } : null
      );
      expect(result.ok).toBe(state === 'idle' || state === 'archived');
      expect(archived).toEqual(state === 'idle' ? ['session:ui_session_archive'] : []);
      if (state === 'archived') expect(result).toMatchObject({ value: { archived: false } });
    }
  );

  test.each(['worktree', 'base', 'fallback'])('checks the session checkout (%s)', async (dirty) => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-worktree-'));
    const repo = join(dir, 'repo');
    const worktree = join(dir, 'worktree');
    mkdirSync(repo);
    const { simpleGit } = await import('simple-git');
    try {
      const git = simpleGit(repo);
      await git.init();
      await git.raw([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '--no-gpg-sign',
        '-m',
        'base',
      ]);
      await git.raw(['worktree', 'add', '-b', 'work', worktree]);
      const dirtyPath = dirty === 'base' ? repo : worktree;
      writeFileSync(join(dirtyPath, 'keep.txt'), 'unsaved work');
      const archived: string[] = [];
      const controls = hyperneoSessionControl({
        deps: {
          db: { listChildSessions: () => [] },
          sessionManager: {
            getSessionFromDB: () => ({
              id: 'session',
              status: 'active',
              workspacePath: dirty === 'fallback' ? worktree : repo,
              worktree: {
                branch: 'work',
                worktreePath: dirty === 'fallback' ? undefined : worktree,
              },
            }),
            getWorktreeManager: () => ({
              getCommitsAhead: async () => ({ hasCommitsAhead: false }),
            }),
            getCachedSession: () => undefined,
            archiveSessionResources: async (id: string) => {
              archived.push(id);
            },
          },
        },
      } as never);
      const result = await controls.archive!({ adapter: 'hyperneo', id: 'session' }, () => null);
      expect(result).toMatchObject(
        dirty === 'base'
          ? { ok: true, value: { archived: true } }
          : { ok: false, reason: 'unsupported' }
      );
      expect(archived).toEqual(dirty === 'base' ? ['session'] : []);
      expect(await simpleGit(dirtyPath).status()).toMatchObject({ not_added: ['keep.txt'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sessionManager(
  isGitRepo: boolean,
  canRun: (params: CreateSessionParams) => boolean = () => true,
  gitRoot = '/repo'
) {
  const created: CreateSessionParams[] = [];
  return {
    created,
    manager: {
      createSession: mock(async (params: CreateSessionParams) => {
        created.push(params);
        if (!canRun(params)) throw new ModelUnavailableError("Model 'sonnet' is not available");
        return 'new';
      }),
      getWorktreeManager: () => ({
        detectGitSupport: async () => ({ isGitRepo, gitRoot: isGitRepo ? gitRoot : null }),
      }),
    },
  };
}

describe('createDriverSession', () => {
  test('starts work in a git repo in its own worktree', async () => {
    const { created, manager } = sessionManager(true);
    expect(await createDriverSession(manager as never, '/repo', 'font size')).toBe('new');
    expect(created).toEqual([
      { workspacePath: '/repo', title: 'font size', worktreeMode: 'worktree' },
    ]);
  });

  test('starts work in a linked worktree in place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-linked-'));
    const linked = join(root, 'feature');
    mkdirSync(linked);
    writeFileSync(join(linked, '.git'), `gitdir: ${root}/repo/.git/worktrees/feature\n`);
    try {
      const { created, manager } = sessionManager(true, () => true, linked);
      await createDriverSession(manager as never, linked, 'font size');
      expect(created).toEqual([
        { workspacePath: linked, title: 'font size', worktreeMode: 'direct' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('starts work in a plain folder directly', async () => {
    const { created, manager } = sessionManager(false);
    await createDriverSession(manager as never, '/notes', 'essay');
    expect(created).toEqual([{ workspacePath: '/notes', title: 'essay', worktreeMode: 'direct' }]);
  });
});

const model = (id: string, releaseDate: string, available = true): ModelInfo =>
  ({ id, alias: id, provider: id.split('-')[0], releaseDate, available }) as ModelInfo;

describe('newestAvailableModel', () => {
  test('takes the most recently released model that is available', () => {
    expect(
      newestAvailableModel([
        model('gpt-5', '2026-01-01'),
        model('glm-6', '2026-12-01', false),
        model('gpt-6', '2026-09-01'),
      ])?.id
    ).toBe('gpt-6');
    expect(newestAvailableModel([])).toBeNull();
  });
});

describe('createDriverSession model', () => {
  test('opens the session on the model asked for', async () => {
    const { created, manager } = sessionManager(false);
    await createDriverSession(manager as never, '/notes', 'essay', 'glm-5.3', async () => [
      { ...model('glm-5.3[1m]', '2026-08-14'), alias: 'glm-5.3' },
    ]);
    expect(created[0].config).toEqual({ model: 'glm-5.3' });
  });

  test('falls back to the newest available model when the default cannot run', async () => {
    const { created, manager } = sessionManager(false, (params) => !!params.config);
    const id = await createDriverSession(
      manager as never,
      '/notes',
      'essay',
      undefined,
      async () => [model('gpt-5', '2026-01-01'), model('gpt-6', '2026-09-01')]
    );
    expect(id).toBe('new');
    expect(created.map((params): unknown => params.config)).toEqual([
      undefined,
      { model: 'gpt-6', provider: 'gpt' },
    ]);
  });

  test('accepts the provider aliases and legacy names session creation resolves', async () => {
    const { created, manager } = sessionManager(false);
    const models = async () => [
      { ...model('kimi-k3-0901', '2026-09-01'), providerAliases: ['kimi-k3'] },
      { ...model('sonnet', '2026-05-01'), alias: 'sonnet' },
    ];
    await createDriverSession(manager as never, '/notes', 'essay', 'kimi-k3', models);
    await createDriverSession(manager as never, '/notes', 'essay', 'claude-sonnet-4-6', models);
    expect(created.map((params): unknown => params.config)).toEqual([
      { model: 'kimi-k3' },
      { model: 'claude-sonnet-4-6' },
    ]);
  });

  test('refuses a named model that is not available instead of using the default', async () => {
    const { created, manager } = sessionManager(false);
    await expect(
      createDriverSession(manager as never, '/notes', 'essay', 'nope-1', async () => [
        model('gpt-6', '2026-09-01'),
      ])
    ).rejects.toThrow(ModelUnavailableError);
    expect(created).toEqual([]);
  });

  test('keeps the failure for a model asked for by name, or when nothing can run', async () => {
    const asked = sessionManager(false, () => false);
    await expect(
      createDriverSession(asked.manager as never, '/notes', 'essay', 'gpt-6', async () => [
        model('gpt-6', '2026-09-01'),
      ])
    ).rejects.toThrow(ModelUnavailableError);
    expect(asked.created).toHaveLength(1);
    const none = sessionManager(false, () => false);
    await expect(
      createDriverSession(none.manager as never, '/notes', 'essay', undefined, async () => [])
    ).rejects.toThrow(ModelUnavailableError);
    expect(none.created).toHaveLength(1);
  });
});
