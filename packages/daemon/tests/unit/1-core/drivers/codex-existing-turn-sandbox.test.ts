import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  queueCodexMessage,
  type CodexDesktopAdapterDeps,
} from '../../../../src/lib/drivers/codex-desktop-adapter';
import { configureWorkerSandbox } from '../../../../src/lib/drivers/worker-sandbox';

describe('existing Codex queued turn sandbox preference', () => {
  let root = '';
  afterEach(() => {
    configureWorkerSandbox(() => 'off');
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function fixture(marked: boolean, loaded: boolean, refuseSettings = false) {
    root = mkdtempSync(join(tmpdir(), 'codex-old-policy-'));
    mkdirSync(join(root, '.git'));
    if (marked) writeFileSync(join(root, '.git/hyperneo-worker-sandbox'), 'restricted');
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let cliCalls = 0;
    const deps = {
      desktopRunning: async () => false,
      newId: () => 'next-input',
      spawn: () => {
        cliCalls++;
        throw new Error('CLI fallback cannot refresh the policy');
      },
      appServer: async () => ({
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          if (method === 'thread/loaded/list')
            return { data: loaded ? ['old-thread'] : [], nextCursor: null };
          if (method === 'permissionProfile/list')
            return { data: [{ id: 'hyperneo-worker', allowed: true }] };
          if (method === 'thread/settings/update' && refuseSettings)
            throw new Error('policy refresh refused');
          if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queued-next' } };
          return {};
        },
        close: () => {},
      }),
    } as unknown as CodexDesktopAdapterDeps;
    const detail = {
      thread: {
        id: 'old-thread',
        folder: root,
        title: 'Old restricted worker',
        archived: 0,
        updatedAt: 1,
        rolloutPath: join(root, 'rollout.jsonl'),
      },
      roots: [],
    };
    return { calls, deps, detail, cliCalls: () => cliCalls };
  }

  for (const marked of [false, true])
    for (const loaded of [false, true])
      test(`off replaces old policy before enqueue (marked=${marked}, loaded=${loaded})`, async () => {
        configureWorkerSandbox(() => 'off');
        const f = fixture(marked, loaded);
        expect(await queueCodexMessage(f.detail, 'continue', f.deps)).toMatchObject({
          ok: true,
          value: { queuedSubmissionId: 'queued-next' },
        });
        expect(f.calls.map((call) => call.method)).toEqual([
          'thread/loaded/list',
          ...(!loaded ? ['thread/resume'] : []),
          'thread/settings/update',
          'thread/queue/add',
        ]);
        if (!loaded)
          expect(f.calls.find((call) => call.method === 'thread/resume')?.params).toEqual({
            threadId: 'old-thread',
            sandbox: 'danger-full-access',
          });
        expect(f.calls.find((call) => call.method === 'thread/settings/update')?.params).toEqual({
          threadId: 'old-thread',
          sandboxPolicy: { type: 'dangerFullAccess' },
        });
        expect(f.cliCalls()).toBe(0);
      });

  test('off does not enqueue when the policy refresh is rejected', async () => {
    configureWorkerSandbox(() => 'off');
    const f = fixture(false, true, true);
    expect(await queueCodexMessage(f.detail, 'continue', f.deps)).toMatchObject({
      ok: false,
      reason: 'not_delivered',
      notSent: true,
      detail: expect.stringContaining('thread/settings/update'),
    });
    expect(f.calls.some((call) => call.method === 'thread/queue/add')).toBe(false);
    expect(f.cliCalls()).toBe(0);
  });

  test('off does not bypass a required policy refresh through the offline CLI', async () => {
    configureWorkerSandbox(() => 'off');
    const f = fixture(false, true);
    f.deps.appServer = async () => {
      throw new Error('synthetic app-server unavailable');
    };
    expect(await queueCodexMessage(f.detail, 'continue', f.deps)).toMatchObject({ ok: false });
    expect(f.cliCalls()).toBe(0);
  });
});
