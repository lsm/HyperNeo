import type { WorkExecutionPreparer } from '../../../../src/lib/drivers/start-preparation';
import { CODEX_WORKER_INSTRUCTIONS } from '@hyperneo/prompts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexAppServer } from '../../../../src/lib/drivers/codex-app-server';
import {
  codexStartReceipt,
  createCodexDesktopAdapter,
  startedThreadId,
} from '../../../../src/lib/drivers/codex-desktop-adapter';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const user = { from: 'user', caller: { source: 'rpc' as const } };
const place = { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' };
const request = { place, title: 'Bigger font', message: 'Raise the body font to 16px.' };
const openingMessage = `${request.message}\n${CODEX_WORKER_INSTRUCTIONS}`;
const model = {
  id: 'sol-catalog-entry',
  model: 'gpt-6.1-sol',
  displayName: 'GPT-6.1 Sol',
  isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
};
const catalog = { data: [model], nextCursor: null };
const threadAccess = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  projectId: 'project-1',
};
const turnAccess = { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };

function adapter(
  server: Partial<CodexAppServer> | Error,
  folders = ['/focus/dolmen'],
  git: {
    root?: string;
    exit?: number;
    linked?: boolean;
    prepareExecution?: WorkExecutionPreparer;
  } = {}
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const projectFolders: string[] = [];
  const spawned: Array<{ args: string[]; cwd?: string }> = [];
  let closed = false;
  const instance = createCodexDesktopAdapter({
    statePath: '/codex/state.sqlite',
    prepareExecution: git.prepareExecution,
    worktreesDir: '/codex/worktrees',
    machine: 'laptop',
    now: () => NOW,
    spawn: (args, options) => {
      spawned.push({ args, cwd: options?.cwd });
      const code = git.exit ?? 0;
      return {
        stdout: null,
        stderr: new Response(code ? 'fatal: already exists' : '').body,
        exited: Promise.resolve(code),
        exitCode: code,
        kill: () => {},
      };
    },
    appServer: async () => {
      throw new Error('Shared daemon must not create desktop threads');
    },
    prepareDesktopProject: async (folder) => {
      projectFolders.push(folder);
      return 'project-1';
    },
    startDesktopTurn: async (threadId, params) => {
      expect(closed).toBe(true);
      expect(params.threadId).toBe(threadId);
      calls.push(['desktop/start-turn', params]);
      if (!(server instanceof Error)) await server.call?.('desktop/start-turn', params);
    },
    bootstrapServer: async () => {
      if (server instanceof Error) throw server;
      return {
        call: async (method, params) => {
          calls.push([method, params]);
          return server.call?.(method, params);
        },
        close: async () => {
          await server.close?.();
          closed = true;
        },
      };
    },
    folderExists: (folder) => folders.includes(folder),
    makeFolder: () => {},
    homeDir: '/Users/test',
    gitCheckout: async () => (git.root ? { repo: git.root, linked: git.linked ?? false } : null),
    newId: () => 'abcd1234-0000',
  });
  return { instance, calls, projectFolders, spawned, closed: () => closed };
}

describe('startedThreadId', () => {
  test('reads the id from thread/start in either shape', () => {
    expect(startedThreadId({ thread: { id: 'th1' } })).toBe('th1');
    expect(startedThreadId({ threadId: 'th2' })).toBe('th2');
    expect(startedThreadId({ thread: {} })).toBeNull();
    expect(startedThreadId(null)).toBeNull();
  });
});

const brief = (id: string, text: string) =>
  JSON.stringify({
    type: 'response_item',
    timestamp: '2026-10-05T12:00:01.000Z',
    payload: { type: 'message', role: 'user', id, content: [{ type: 'input_text', text }] },
  });

describe('codexStartReceipt', () => {
  test('receipts the brief by its user message id, skipping injected context', () => {
    const lines = [
      brief('msg_ctx', '<environment_context>cwd</environment_context>'),
      brief('msg_1', `${request.message}\n[HyperNeo agent input]`),
    ];
    expect(codexStartReceipt(lines, request.message, 'th1')).toEqual({
      executionId: 'th1',
      inputId: 'msg_1',
    });
    expect(codexStartReceipt(lines.slice(0, 1), request.message, 'th1')).toBeNull();
  });
});

describe('codex-desktop start receipt', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  test('a started thread returns the receipt of its brief read from the rollout it reports', async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-start-'));
    const path = join(dir, 'rollout.jsonl');
    writeFileSync(path, brief('msg_7', openingMessage));
    const { instance } = adapter({
      call: async (method) =>
        method === 'model/list'
          ? catalog
          : method === 'thread/start'
            ? { thread: { id: 'th1', path } }
            : {},
    });
    expect(await instance.start?.(request, user)).toMatchObject({
      ok: true,
      value: { ref: { id: 'th1' }, receipt: { executionId: 'th1', inputId: 'msg_7' } },
    });
  });

  test('a thread with no readable rollout starts without a receipt', async () => {
    const { instance } = adapter({
      call: async (method) =>
        method === 'model/list'
          ? catalog
          : method === 'thread/start'
            ? { thread: { id: 'th1' } }
            : {},
    });
    const started = await instance.start?.(request, user);
    expect(started).toMatchObject({ ok: true, value: { ref: { id: 'th1' } } });
    expect(started?.ok && 'receipt' in started.value).toBe(false);
  });
});

describe('codex-desktop start', () => {
  test('tells a new Codex worker how to trim only its own merged or closed PR links', async () => {
    const { instance, calls } = adapter({
      call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}),
    });
    expect(await instance.start!(request, user)).toMatchObject({ ok: true });
    expect(
      (
        calls.find(([method]) => method === 'desktop/start-turn')?.[1].input as { text: string }[]
      )[0].text
    ).toBe(
      `${request.message}\nTo trim this thread's PR links, call mcp__codex_app__list_artifacts, check each PR's GitHub state, then call mcp__codex_app__remove_artifact({artifact_type:"pull_request", url}) for merged/closed PRs; own thread only; never edit ~/.codex state files directly.`
    );
  });

  test('surfaces a refused Full Access request without retrying with weaker permissions', async () => {
    const { instance, calls, closed } = adapter({
      call: async () => {
        throw new Error('Full Access disabled by policy');
      },
    });
    expect(await instance.start!(request, user)).toMatchObject({
      ok: false,
      reason: 'not_delivered',
      detail: 'Full Access disabled by policy',
    });
    expect(calls).toEqual([['thread/start', { ...threadAccess, cwd: place.folder }]]);
    expect(closed()).toBe(true);
  });

  test('starts in the prepared location instead of another HEAD worktree and keeps its resource', async () => {
    const prepared: unknown[] = [];
    let released = false;
    const { instance, calls, spawned } = adapter(
      { call: async () => ({ thread: { id: 'fresh' } }) },
      undefined,
      {
        root: '/focus/dolmen',
        linked: true,
        prepareExecution: async (input, location) => {
          prepared.push({ input, location });
          return {
            ok: true,
            value: {
              directory: '/fresh/remote-base',
              release: async () => {
                released = true;
              },
            },
          };
        },
      }
    );
    const preparation = { pack: 'coding', parameters: { target: 'dev' } };
    expect(await instance.start!({ ...request, preparation }, user)).toMatchObject({ ok: true });
    expect(prepared).toEqual([
      {
        input: preparation,
        location: { directory: '/focus/dolmen', destination: '/codex/worktrees/abcd1234/dolmen' },
      },
    ]);
    expect(calls[0]).toEqual(['thread/start', { ...threadAccess, cwd: '/fresh/remote-base' }]);
    expect(spawned).toEqual([]);
    expect(released).toBe(false);
  });

  test('failed preparation creates no thread and a failed thread start releases the prepared directory', async () => {
    let released = false;
    for (const failedPreparation of [true, false]) {
      const { instance, calls, spawned } = adapter(
        {
          call: async () => {
            throw new Error('start failed');
          },
        },
        undefined,
        {
          prepareExecution: async () =>
            failedPreparation
              ? { ok: false, reason: 'preparation_failed', detail: 'fetch failed' }
              : {
                  ok: true,
                  value: {
                    directory: '/fresh',
                    release: async () => {
                      released = true;
                    },
                  },
                },
        }
      );
      expect(
        await instance.start!({ ...request, preparation: { pack: 'coding', parameters: {} } }, user)
      ).toMatchObject({
        ok: false,
        reason: failedPreparation ? 'preparation_failed' : 'not_delivered',
      });
      expect(calls).toHaveLength(failedPreparation ? 0 : 1);
      expect(spawned).toEqual([]);
    }
    expect(released).toBe(true);
  });

  test('resolves an alias and returns the model confirmed by thread/start', async () => {
    const { instance, calls, closed } = adapter({
      call: async (method) =>
        method === 'model/list'
          ? catalog
          : method === 'thread/start'
            ? { thread: { id: 'th1' }, model: model.model }
            : {},
    });
    expect(await instance.start?.({ ...request, model: 'sol 6.1' }, user)).toMatchObject({
      ok: true,
      value: { model: 'gpt-6.1-sol', ref: { id: 'th1' }, status: 'running' },
    });
    expect(calls).toEqual([
      ['model/list', { limit: 100, includeHidden: false }],
      ['thread/start', { ...threadAccess, cwd: '/focus/dolmen', model: 'gpt-6.1-sol' }],
      ['thread/name/set', { threadId: 'th1', name: request.title }],
      [
        'desktop/start-turn',
        {
          ...turnAccess,
          threadId: 'th1',
          input: [{ type: 'text', text: openingMessage, text_elements: [] }],
          model: model.model,
        },
      ],
    ]);
    expect(closed()).toBe(true);
  });

  test.each([undefined, 'sol 6.1'])('applies and confirms effort with model %s', async (name) => {
    const { instance, calls } = adapter({
      call: async (method) =>
        method === 'model/list'
          ? catalog
          : method === 'thread/start'
            ? { thread: { id: 'th1' }, model: model.model, reasoningEffort: 'medium' }
            : {},
    });
    expect(
      await instance.start?.({ ...request, model: name, effort: ' MEDIUM ' }, user)
    ).toMatchObject({
      ok: true,
      value: { model: model.model, effort: 'medium', status: 'running' },
    });
    expect(calls).toEqual([
      ['model/list', { limit: 100, includeHidden: false }],
      [
        'thread/start',
        {
          ...threadAccess,
          cwd: '/focus/dolmen',
          model: model.model,
          config: { model_reasoning_effort: 'medium' },
        },
      ],
      ['thread/name/set', { threadId: 'th1', name: request.title }],
      [
        'desktop/start-turn',
        {
          ...turnAccess,
          threadId: 'th1',
          input: [{ type: 'text', text: openingMessage, text_elements: [] }],
          model: model.model,
          effort: 'medium',
        },
      ],
    ]);
  });

  test('rejects unsupported effort before preparing work', async () => {
    const { instance, calls, spawned, closed } = adapter(
      { call: async () => catalog },
      ['/focus/dolmen'],
      { root: '/focus/dolmen' }
    );
    expect(
      await instance.start?.({ ...request, model: model.model, effort: 'ultra' }, user)
    ).toMatchObject({
      ok: false,
      reason: 'unsupported_effort',
    });
    expect(calls.map(([method]) => method)).toEqual(['model/list']);
    expect(spawned).toEqual([]);
    expect(closed()).toBe(true);
  });

  test.each([undefined, null, '', ' ', 42, 'high'])(
    'refuses an unconfirmed effort receipt: %s',
    async (reported) => {
      const { instance, calls, closed } = adapter({
        call: async (method) =>
          method === 'model/list'
            ? catalog
            : { thread: { id: 'th1' }, model: model.model, reasoningEffort: reported },
      });
      expect(await instance.start?.({ ...request, effort: 'medium' }, user)).toMatchObject({
        ok: false,
        reason: 'not_delivered',
        detail: expect.stringContaining('confirm effort'),
      });
      expect(calls.map(([method]) => method)).toEqual(['model/list', 'thread/start']);
      expect(closed()).toBe(true);
    }
  );

  test('reports effective default effort without overriding or inventing it', async () => {
    for (const reported of ['high', null]) {
      const { instance, calls } = adapter({
        call: async (method) =>
          method === 'thread/start'
            ? { thread: { id: 'th1' }, model: 'configured-default', reasoningEffort: reported }
            : {},
      });
      const result = await instance.start?.(request, user);
      expect(result?.ok).toBe(true);
      expect(result?.ok && result.value.effort).toBe(reported ?? undefined);
      expect(calls[0]).toEqual(['thread/start', { ...threadAccess, cwd: '/focus/dolmen' }]);
      expect(calls.some(([method]) => method === 'model/list')).toBe(false);
    }
  });

  test('records an effective default model without querying or overriding the catalog', async () => {
    const { instance, calls } = adapter({
      call: async (method) =>
        method === 'thread/start' ? { thread: { id: 'th1' }, model: 'configured-default' } : {},
    });
    expect(await instance.start?.(request, user)).toMatchObject({
      ok: true,
      value: { model: 'configured-default' },
    });
    expect(calls[0]).toEqual(['thread/start', { ...threadAccess, cwd: '/focus/dolmen' }]);
    expect(calls.some(([method]) => method === 'model/list')).toBe(false);
  });

  for (const [name, data] of [
    ['missing', []],
    ['hidden', [{ ...model, hidden: true }]],
    ['ambiguous', [model, { ...model, id: 'other', model: 'other', displayName: 'sol 6.1' }]],
  ] as const) {
    test(`refuses a ${name} model before creating a worktree or thread`, async () => {
      const { instance, calls, spawned, closed } = adapter(
        { call: async () => ({ data, nextCursor: null }) },
        ['/focus/dolmen'],
        { root: '/focus/dolmen' }
      );
      expect(await instance.start?.({ ...request, model: 'sol 6.1' }, user)).toMatchObject({
        ok: false,
        reason: 'unsupported_model',
      });
      expect(calls.map(([method]) => method)).toEqual(['model/list']);
      expect(spawned).toEqual([]);
      expect(closed()).toBe(true);
    });
  }

  test('cannot start work when the model catalog is unavailable', async () => {
    const { instance, calls, spawned, closed } = adapter(
      {
        call: async () => {
          throw new Error('catalog offline');
        },
      },
      ['/focus/dolmen'],
      { root: '/focus/dolmen' }
    );
    expect(await instance.start?.({ ...request, model: model.model }, user)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(calls.map(([method]) => method)).toEqual(['model/list']);
    expect(spawned).toEqual([]);
    expect(closed()).toBe(true);
  });

  for (const reported of [undefined, null, '', ' ', 42, 'gpt-6-astra']) {
    test(`does not send the first turn for an unconfirmed model receipt: ${reported}`, async () => {
      const { instance, calls, spawned, closed } = adapter(
        {
          call: async (method) =>
            method === 'model/list' ? catalog : { thread: { id: 'th1' }, model: reported },
        },
        ['/focus/dolmen'],
        { root: '/focus/dolmen' }
      );
      const result = await instance.start?.({ ...request, model: model.model }, user);
      expect(result).toMatchObject({ ok: false, reason: 'not_delivered' });
      expect(result && !result.ok && result.detail).toContain(
        'Thread th1 was created without its first turn.'
      );
      expect(calls.map(([method]) => method)).toEqual(['model/list', 'thread/start']);
      expect(spawned.map(({ args }) => args.slice(0, 3))).toEqual([['git', 'worktree', 'add']]);
      expect(closed()).toBe(true);
    });
  }

  test('starts a named thread in the folder and sends the first turn', async () => {
    const { instance, calls, closed } = adapter({
      call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}),
    });
    expect(await instance.start?.(request, user)).toEqual({
      ok: true,
      value: {
        ref: { adapter: 'codex-desktop', id: 'th1' },
        title: 'Bigger font',
        place,
        status: 'running',
        lastActivityAt: NOW,
        link: 'codex://threads/th1',
      },
    });
    expect(calls).toEqual([
      ['thread/start', { ...threadAccess, cwd: '/focus/dolmen' }],
      ['thread/name/set', { threadId: 'th1', name: 'Bigger font' }],
      [
        'desktop/start-turn',
        {
          ...turnAccess,
          threadId: 'th1',
          input: [{ type: 'text', text: openingMessage, text_elements: [] }],
        },
      ],
    ]);
    expect(closed()).toBe(true);
  });

  test('returns the saved thread in a typed rejection when bootstrap exit fails', async () => {
    let closes = 0;
    const { instance, calls } = adapter({
      call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}),
      close: async () => {
        closes++;
        throw new Error('Codex bootstrap exited with 7.');
      },
    });
    expect(await instance.start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail:
        'Codex bootstrap exited with 7. Thread th1 was created, but its opening turn was not confirmed.',
    });
    expect(closes).toBe(1);
    expect(calls.map(([method]) => method)).toEqual(['thread/start', 'thread/name/set']);
  });

  test('the opening text includes the spans Desktop needs to render its live turn', async () => {
    const { instance, calls } = adapter({
      call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}),
    });
    expect(await instance.start?.(request, user)).toMatchObject({ ok: true });
    const opening = calls.find(([method]) => method === 'desktop/start-turn')?.[1];
    expect(opening?.input).toEqual([{ type: 'text', text: openingMessage, text_elements: [] }]);
  });

  test('creates the repo project and assigns the new worktree thread to it', async () => {
    const { instance, calls, projectFolders } = adapter(
      { call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}) },
      ['/focus/dolmen/web'],
      { root: '/focus/dolmen' }
    );
    expect(
      await instance.start?.({ ...request, place: { ...place, folder: '/focus/dolmen/web' } }, user)
    ).toMatchObject({ ok: true });
    expect(projectFolders).toEqual(['/focus/dolmen']);
    expect(calls.find(([method]) => method === 'thread/start')?.[1]).toMatchObject({
      cwd: '/codex/worktrees/abcd1234/dolmen',
      projectId: 'project-1',
    });
  });

  test('starts a thread in a git repo in its own detached worktree', async () => {
    const { instance, calls, spawned } = adapter(
      { call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}) },
      ['/focus/dolmen'],
      { root: '/focus/dolmen' }
    );
    expect(await instance.start?.(request, user)).toMatchObject({ ok: true, value: { place } });
    expect(spawned).toEqual([
      {
        args: ['git', 'worktree', 'add', '--detach', '/codex/worktrees/abcd1234/dolmen', 'HEAD'],
        cwd: '/focus/dolmen',
      },
    ]);
    expect(calls[0]).toEqual([
      'thread/start',
      { ...threadAccess, cwd: '/codex/worktrees/abcd1234/dolmen' },
    ]);
  });

  test('runs in place when the folder is already a linked worktree', async () => {
    const { instance, calls, spawned, projectFolders } = adapter(
      { call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}) },
      ['/focus/dolmen'],
      { root: '/focus/dolmen-main', linked: true }
    );
    expect(await instance.start?.(request, user)).toMatchObject({ ok: true, value: { place } });
    expect(spawned).toEqual([]);
    expect(calls[0]).toEqual(['thread/start', { ...threadAccess, cwd: '/focus/dolmen' }]);
    expect(projectFolders).toEqual(['/focus/dolmen-main']);
  });

  test('runs a subfolder start at the worktree root', async () => {
    const { instance, calls } = adapter(
      { call: async (method) => (method === 'thread/start' ? { thread: { id: 'th1' } } : {}) },
      ['/focus/dolmen/web'],
      { root: '/focus/dolmen' }
    );
    await instance.start?.(
      { ...request, place: { ...place, folder: '/focus/dolmen/web', name: 'web' } },
      user
    );
    expect(calls[0]).toEqual([
      'thread/start',
      { ...threadAccess, cwd: '/codex/worktrees/abcd1234/dolmen' },
    ]);
  });

  test('removes the worktree when no thread starts', async () => {
    const { instance, spawned } = adapter({ call: async () => ({}) }, ['/focus/dolmen'], {
      root: '/focus/dolmen',
    });
    expect(await instance.start?.(request, user)).toMatchObject({ ok: false });
    expect(spawned.map(({ args }) => args.slice(0, 3))).toEqual([
      ['git', 'worktree', 'add'],
      ['git', 'worktree', 'remove'],
    ]);
    expect(spawned[1].args.at(-1)).toBe('/codex/worktrees/abcd1234/dolmen');
  });

  test('does not start a thread when the worktree cannot be created', async () => {
    const { instance, calls, closed } = adapter({}, ['/focus/dolmen'], {
      root: '/focus/dolmen',
      exit: 128,
    });
    expect(await instance.start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'Could not create a worktree in /focus/dolmen: fatal: already exists',
    });
    expect(calls).toEqual([]);
    expect(closed()).toBe(true);
  });

  test('needs an existing folder on this machine', async () => {
    const { instance, calls } = adapter({});
    const start = (at: Record<string, string>) =>
      instance.start?.({ ...request, place: at as typeof place }, user);
    expect(await start({ machine: 'laptop', name: 'Chats' })).toMatchObject({
      reason: 'invalid_place',
    });
    expect(await start({ ...place, machine: 'imac' })).toMatchObject({ reason: 'invalid_place' });
    expect(await start({ ...place, folder: '/gone' })).toEqual({
      ok: false,
      reason: 'invalid_place',
      detail: '/gone does not exist. To start a new project there, pass createFolder: true.',
    });
    expect(calls).toEqual([]);
  });

  test('reports an absent app-server and a thread left without its first turn', async () => {
    expect(await adapter(new Error('ENOENT')).instance.start?.(request, user)).toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'The Codex app-server is not running: ENOENT',
    });
    const halfway = adapter({
      call: async (method) => {
        if (method === 'desktop/start-turn') throw new Error('desktop/start-turn: busy');
        return method === 'thread/start' ? { threadId: 'th2' } : {};
      },
    });
    expect(await halfway.instance.start?.(request, user)).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail:
        'desktop/start-turn: busy Thread th2 was created, but its opening turn was not confirmed.',
    });
    expect(halfway.closed()).toBe(true);
  });
});
