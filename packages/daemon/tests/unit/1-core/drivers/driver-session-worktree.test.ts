import {
  prepareWorkerSandbox,
  releaseWorkerSandbox,
} from '../../../../src/lib/drivers/worker-sandbox';
import { existsSync } from 'node:fs';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway';
import { sdkPendingRemoval } from '../../../../src/storage/repositories/sdk-message-transactions';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';
import { createMailboxEntry } from '../../../../src/lib/mailbox/entry';
import { enqueueMailboxEntry } from '../../../../src/lib/mailbox/enqueue';
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

describe('hyperneoSessionControl withdraw', () => {
  let fixture: MailboxTestDb;
  beforeEach(() => {
    fixture = createMailboxTestDb();
  });
  afterEach(() => fixture.close());

  test.each(
    [false, true].flatMap((cached) =>
      ['deferred', 'enqueued', 'consumed'].map((status) => ({ cached, status }))
    )
  )('withdraws only deferred inputs without restoring %j', async ({ cached, status }) => {
    const entry = createMailboxEntry({
      to: { kind: 'session', sessionId: 'owned' },
      origin: 'session:sender',
      deliveryMode: 'defer',
      messageUuid: 'input',
      message: { type: 'user', message: { content: 'later' }, parent_tool_use_id: null },
    });
    enqueueMailboxEntry(fixture.jobQueue, entry);
    fixture.db.exec("UPDATE job_queue SET status = 'completed'");
    fixture.db
      .prepare(`INSERT INTO sdk_messages
      (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
      VALUES ('db-input', 'owned', 'user', '{"uuid":"input"}', '2026-10-16', ?, 'input')`)
      .run(status);
    const delivery = fixture.jobQueue.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: 'owned', messageUuid: 'input' },
    });
    const restore = mock(() => {
      throw new Error('must not restore');
    });
    const revoke = mock(
      async (id: string, mode: string, expected: 'deferred', withdrawalJobId: string) => {
        expect(mode).toBe('remove');
        const removed = await gatewayFor(fixture.db).run(sdkPendingRemoval, {
          sessionId: 'owned',
          messageDbId: id,
          mode: 'remove',
          expectedStatus: expected,
          withdrawalJobId,
        });
        return { changed: !!removed };
      }
    );
    const controls = hyperneoSessionControl({
      deps: {
        sessionManager: {
          getCachedSession: () => (cached ? { revokePendingDelivery: revoke } : undefined),
          getSession: restore,
        },
        db: {
          gateway: gatewayFor(fixture.db),
          getDatabase: () => fixture.db,
          getSDKMessageRepo: () => fixture.sdkMessageRepo,
          deletePendingUserMessage: (
            ...args: Parameters<typeof fixture.sdkMessageRepo.deletePendingUserMessage>
          ) => fixture.sdkMessageRepo.deletePendingUserMessage(...args),
          notifyChange: mock(() => {}),
        },
        jobQueue: fixture.jobQueue,
      },
    } as never);
    expect(await controls.withdraw!('owned', entry.id, 'session:other')).toMatchObject({
      value: { withdrawn: false },
    });
    expect(fixture.sdkRows()).toHaveLength(1);
    expect(await controls.withdraw!('owned', entry.id, 'session:sender')).toMatchObject({
      value: { withdrawn: status === 'deferred' },
    });
    expect(fixture.sdkRows()).toHaveLength(status === 'deferred' ? 0 : 1);
    expect(await controls.withdraw!('owned', entry.id, 'session:sender')).toMatchObject({
      value: { withdrawn: status === 'deferred' },
    });
    expect(restore).not.toHaveBeenCalled();
    if (!cached)
      expect(fixture.jobQueue.getJob(delivery.id)?.status ?? null).toBe(
        status === 'deferred' ? null : 'pending'
      );
    expect(revoke).toHaveBeenCalledTimes(cached ? (status === 'deferred' ? 1 : 2) : 0);
    if (cached)
      expect(revoke).toHaveBeenCalledWith('db-input', 'remove', 'deferred', expect.any(String));
  });
});

describe('hyperneoSessionControl interrupt', () => {
  test.each(['idle', 'interrupted', 'processing', 'missing', 'replaced'])(
    'checks the same live runtime after interrupt acknowledgement (%s)',
    async (after) => {
      let state = 'processing';
      const runtime = { getProcessingState: () => ({ status: state }) };
      let current: typeof runtime | undefined = runtime;
      const controls = hyperneoSessionControl({
        deps: {
          sessionManager: { getCachedSession: () => current },
          internalEventBus: {
            publish: async () => {
              state = after;
              if (after === 'missing') current = undefined;
              if (after === 'replaced')
                current = { getProcessingState: () => ({ status: 'idle' }) };
            },
          },
        },
      } as never);
      expect(await controls.interrupt('session')).toBe(after === 'idle' || after === 'interrupted');
    }
  );

  test('waits for the handler and propagates its failure', async () => {
    let fail: (error: Error) => void = () => {};
    const handling = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const controls = hyperneoSessionControl({
      deps: {
        sessionManager: {
          getCachedSession: () => ({ getProcessingState: () => ({ status: 'processing' }) }),
        },
        internalEventBus: { publish: () => handling },
      },
    } as never);
    let settled = false;
    const result = Promise.resolve(controls.interrupt('session')).finally(() => {
      settled = true;
    });
    const rejected = expect(result).rejects.toThrow('interrupt refused');
    await Promise.resolve();
    expect(settled).toBe(false);
    fail(new Error('interrupt refused'));
    await rejected;
  });

  test('does not restore an uncached runtime', async () => {
    const published: string[] = [];
    const controls = hyperneoSessionControl({
      deps: {
        sessionManager: { getCachedSession: () => undefined },
        internalEventBus: {
          publish: async () => {
            published.push('interrupt');
          },
        },
      },
    } as never);
    expect(await controls.interrupt('session')).toBe(false);
    expect(published).toEqual([]);
  });
});

describe('hyperneoSessionControl archive', () => {
  test('an admitted archive retry releases an already archived SDK worker runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archived-runtime-'));
    mkdirSync(join(root, '.git'));
    const env = await prepareWorkerSandbox(root);
    const controls = hyperneoSessionControl({
      deps: {
        db: { listChildSessions: () => [] },
        sessionManager: {
          getSessionFromDB: () => ({ id: 'owned', workspacePath: root, status: 'archived' }),
          getCachedSession: () => undefined,
          archiveSessionResources: async () => {
            throw new Error('must not archive twice');
          },
        },
      },
    } as never);
    try {
      expect(
        await controls.archive!({ adapter: 'hyperneo', id: 'owned' }, () => ({
          ok: false,
          reason: 'busy',
          detail: 'new',
        }))
      ).toMatchObject({ ok: false });
      expect(existsSync(env.TMPDIR)).toBe(true);
      expect(await controls.archive!({ adapter: 'hyperneo', id: 'owned' }, () => null)).toEqual({
        ok: true,
        value: { archived: false },
      });
      expect(existsSync(env.TMPDIR)).toBe(false);
      expect(existsSync(env.XDG_CACHE_HOME)).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      await releaseWorkerSandbox(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

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
        state === 'late_refusal' ? { ok: false, reason: 'busy', detail: 'new' } : null
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
  const offers = () => [
    { ...model('swe-2-high', '2026-09-01'), name: 'SWE-2 High', provider: 'custom:synthetic' },
    { ...model('other-high', '2026-09-01'), name: 'Other High', provider: 'custom:other' },
  ];

  test('preserves provider and effort for a shared-folder start under a Git parent', async () => {
    const { created, manager } = sessionManager(true);
    await createDriverSession(
      manager as never,
      '/HyperNeo',
      'task',
      'swe-2-high',
      async () => offers(),
      'custom:synthetic',
      'extra high',
      true
    );
    expect(created).toEqual([
      {
        workspacePath: '/HyperNeo',
        title: 'task',
        worktreeMode: 'direct',
        config: { model: 'swe-2-high', provider: 'custom:synthetic', thinkingLevel: 'think32k' },
      },
    ]);
  });

  test('starts on a unique case-insensitive display name and its provider', async () => {
    const { created, manager } = sessionManager(false);
    await createDriverSession(manager as never, '/notes', 'task', 'sWe-2 HIGH', async () =>
      offers()
    );
    expect(created[0].config).toEqual({ model: 'swe-2-high', provider: 'custom:synthetic' });
  });

  test('refuses an ambiguous display name and lists both matching ids before creation', async () => {
    const { created, manager } = sessionManager(false);
    await expect(
      createDriverSession(manager as never, '/notes', 'task', 'SWE-2 High', async () =>
        offers().map((entry) => ({ ...entry, name: 'SWE-2 High' }))
      )
    ).rejects.toThrow(/swe-2-high.*other-high/);
    expect(created).toEqual([]);
  });

  test('an exact id wins over another model display name', async () => {
    const { created, manager } = sessionManager(false);
    await createDriverSession(manager as never, '/notes', 'task', 'swe-2-high', async () =>
      offers().map((entry) => ({ ...entry, name: 'swe-2-high' }))
    );
    expect(created[0].config).toEqual({ model: 'swe-2-high', provider: 'custom:synthetic' });
  });

  test('opens the session on the model asked for', async () => {
    const { created, manager } = sessionManager(false);
    await createDriverSession(manager as never, '/notes', 'essay', 'glm-5.3', async () => [
      { ...model('glm-5.3[1m]', '2026-08-14'), alias: 'glm-5.3' },
    ]);
    expect(created[0].config).toEqual({ model: 'glm-5.3[1m]', provider: 'glm' });
  });

  test('applies effort to session configuration while retaining its default model', async () => {
    const { created, manager } = sessionManager(false);
    await createDriverSession(
      manager as never,
      '/notes',
      'task',
      undefined,
      async () => offers(),
      undefined,
      'high'
    );
    expect(created[0].config).toEqual({ thinkingLevel: 'think24k' });
  });

  test('preserves the selected provider when another provider offers the same id', async () => {
    const { created, manager } = sessionManager(false);
    await createDriverSession(manager as never, '/notes', 'task', 'Other Model', async () => [
      offers()[0],
      { ...offers()[0], provider: 'custom:other', name: 'Other Model' },
    ]);
    expect(created[0].config).toEqual({ model: 'swe-2-high', provider: 'custom:other' });
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
      { model: 'kimi-k3-0901', provider: 'kimi' },
      { model: 'sonnet', provider: 'sonnet' },
    ]);
  });

  test('exact shared ids retain catalog precedence while a unique name selects its provider', async () => {
    const { created, manager } = sessionManager(false);
    const models = async () => [
      offers()[0],
      {
        ...offers()[0],
        provider: 'custom:other',
        name: 'Other SWE offer',
      },
    ];
    await createDriverSession(manager as never, '/notes', 'task', 'swe-2-high', models);
    await createDriverSession(manager as never, '/notes', 'task', 'Other SWE offer', models);
    expect(created.map((entry) => entry.config)).toEqual([
      { model: 'swe-2-high', provider: 'custom:synthetic' },
      { model: 'swe-2-high', provider: 'custom:other' },
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
