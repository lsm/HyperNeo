import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { GlobalSettings } from '@hyperneo/shared/types/settings';
import { createCodexCutover } from '../../../../src/lib/drivers/codex-cutover.ts';
import { createCodexSetup } from '../../../../src/lib/drivers/codex-setup.ts';
import { createCodexSetupOperation } from '../../../../src/lib/drivers/codex-setup-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { SESSION_DOOR_PRINCIPAL } from '../../../../src/lib/pairing/pairing-operations.ts';

async function fixture(
  environment: string,
  run: (fixture: {
    setup: ReturnType<typeof createCodexSetup>;
    read: () => GlobalSettings['codexAppServerBridge'];
    environment: () => string | null;
    tokenFile: string;
    effects: string[];
    failRestart: () => void;
    failStart: (value: boolean) => void;
    loseUpstream: () => void;
    stopManaged: () => void;
  }) => Promise<void>
) {
  const data = await mkdtemp('/tmp/hn-setup-');
  vi.stubEnv('HYPERNEO_DATA_DIR', data);
  let value: string | null = environment;
  let state: GlobalSettings['codexAppServerBridge'];
  let remote = false;
  let fail = false;
  let failStart = false;
  let running = true;
  let loseUpstream = () => {};
  const effects: string[] = [];
  const gate = createCodexCutover(async () => true);
  const setup = createCodexSetup(
    {
      ...gate,
      async environment() {
        return value;
      },
      async setEnvironment(next) {
        value = next;
        effects.push('environment');
      },
      async startManaged() {
        effects.push('start');
        running = !failStart;
        if (failStart) throw new Error('start failed');
      },
      async remoteEnabled() {
        return remote;
      },
      async managedRunning() {
        return running;
      },
      async enableRemote() {
        remote = true;
        effects.push('enable');
      },
      async migrate() {
        effects.push('migrate');
        return [];
      },
      async startBridge(_port, _token, onUnreachable) {
        loseUpstream = () => onUnreachable?.();
        effects.push('bridge');
      },
      async close() {
        effects.push('close');
      },
      async restartApp() {
        if (fail) {
          fail = false;
          throw new Error('restart failed');
        }
        effects.push('restart');
      },
    },
    () => state,
    (next) => {
      state = next;
    }
  );
  try {
    await run({
      setup,
      read: () => state,
      environment: () => value,
      tokenFile: join(data, 'codex-app-server-bridge', 'token'),
      effects,
      failRestart: () => {
        fail = true;
      },
      failStart: (value) => {
        failStart = value;
      },
      loseUpstream: () => loseUpstream(),
      stopManaged: () => {
        running = false;
      },
    });
  } finally {
    await setup.close();
    vi.unstubAllEnvs();
    await rm(data, { recursive: true, force: true });
  }
}

test('setup preserves a distinct original URL across repeats and reuses the current token at login', async () => {
  const original = 'ws://127.0.0.1:47912/another-service';
  await fixture(original, async ({ setup, read, environment, tokenFile, effects }) => {
    await setup.manual({ noRemoteControl: true });
    expect(read()).toMatchObject({
      enabled: true,
      remoteControl: 'skipped',
      originalUrl: original,
    });
    const first = environment();
    await setup.manual({});
    const rotated = environment();
    expect(first !== rotated).toBe(true);
    await setup.manual({});
    expect(effects.filter((effect) => effect === 'enable')).toHaveLength(1);
    const current = environment();
    effects.length = 0;
    await setup.login();
    expect(environment() === current).toBe(true);
    expect(effects).toEqual(['environment', 'bridge', 'start']);
    await setup.manual({ undo: true });
    expect(environment()).toBe(original);
    expect(read()).toEqual({ enabled: false, decision: 'declined' });
    await expect(stat(tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('undo never restores the legacy bridge URL and can retry a failed app restart', async () => {
  await fixture(
    'ws://127.0.0.1:47912/rpc',
    async ({ setup, read, environment, effects, failRestart }) => {
      await setup.manual({});
      failRestart();
      await expect(setup.manual({ undo: true })).rejects.toThrow('restart failed');
      expect(environment()).toBeNull();
      expect(read()).toMatchObject({ enabled: false, originalUrl: null, decision: 'declined' });
      effects.length = 0;
      await setup.login();
      expect(effects).toEqual([]);
      await expect(setup.manual({ undo: true })).resolves.toMatchObject({ ok: true });
      expect(effects).toEqual(['environment', 'close', 'restart']);
      expect(read()).toEqual({ enabled: false, decision: 'declined' });
    }
  );
});

test('only the paired local session door can run setup', async () => {
  await fixture('ws://distinct.example/', async ({ setup, effects }) => {
    const registry = createOperationRegistry([createCodexSetupOperation(setup)]);
    const local = {
      source: 'mcp',
      principal: SESSION_DOOR_PRINCIPAL,
      device: { deviceId: 'local', kind: 'human' },
    } as const;
    for (const denied of [
      { ...local, source: 'rpc' as const, principal: 'local' },
      { ...local, device: { deviceId: 'agent', kind: 'agent' as const } },
    ]) {
      const result = await invokeOperation(registry, 'system.codex.setup', {}, denied);
      expect(
        result.kind === 'failed' ||
          (result.kind === 'completed' && (result.value as { ok: boolean }).ok === false)
      ).toBe(true);
    }
    expect(effects).toEqual([]);
    expect(
      await invokeOperation(registry, 'system.codex.setup', { noRemoteControl: true }, local)
    ).toMatchObject({ kind: 'completed', value: { ok: true } });
  });
});

test('an unanswered Codex question runs no host changes and decline survives repeated checks', async () => {
  await fixture('ws://distinct.example/', async ({ setup, read, effects }) => {
    const questions = new Set<string>();
    let answer: boolean | undefined;
    setup.bindQuestion({
      async open(id) {
        questions.add(id);
      },
      answer: () => answer,
      retire() {},
    });
    setup.check();
    setup.firstUse();
    await vi.waitFor(() =>
      expect(read()).toMatchObject({ decision: 'asked', questionId: expect.any(String) })
    );
    expect(effects).toEqual([]);
    answer = false;
    setup.check();
    await vi.waitFor(() => expect(read()?.decision).toBe('declined'));
    setup.check();
    await setup.close();
    expect(questions.size).toBe(1);
    expect(effects).toEqual(['close']);
  });
});

test('approval runs the shared setup once and keeps it configured on later checks', async () => {
  await fixture('ws://distinct.example/', async ({ setup, read, effects }) => {
    let answer: boolean | undefined;
    const questions = new Set<string>();
    setup.bindQuestion({
      async open(id) {
        questions.add(id);
      },
      answer: () => answer,
      retire() {},
    });
    setup.check();
    await vi.waitFor(() => expect(read()?.decision).toBe('asked'));
    answer = true;
    setup.check();
    await vi.waitFor(() => {
      expect(read()).toMatchObject({ enabled: true, remoteControl: 'enabled' });
      expect(read()?.decision).toBeUndefined();
    });
    setup.firstUse();
    await setup.close();
    expect(questions.size).toBe(1);
    expect(effects).toEqual([
      'migrate',
      'start',
      'bridge',
      'environment',
      'enable',
      'restart',
      'close',
    ]);
  });
});

test('login opens the bridge even when the Codex app-server cannot start', async () => {
  await fixture('ws://distinct.example/', async ({ setup, effects, failStart }) => {
    await setup.manual({ noRemoteControl: true });
    effects.length = 0;
    failStart(true);
    await setup.login();
    expect(effects).toEqual(['environment', 'bridge', 'start']);
  });
});

test('a lost Codex app-server starts once per outage and failed recovery waits before retrying', async () => {
  await fixture('ws://distinct.example/', async ({ setup, effects, failStart, loseUpstream }) => {
    expect(await setup.recover()).toBe(false);
    expect(effects).toEqual([]);
    await setup.manual({ noRemoteControl: true });
    effects.length = 0;
    loseUpstream();
    expect(await Promise.all([setup.recover(), setup.recover()])).toEqual([true, true]);
    expect(effects).toEqual(['start']);

    vi.useFakeTimers();
    try {
      failStart(true);
      expect(await setup.recover()).toBe(false);
      expect(await setup.recover()).toBe(false);
      expect(effects).toEqual(['start', 'start']);
      failStart(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await setup.recover()).toBe(true);
      expect(effects).toEqual(['start', 'start', 'start']);
    } finally {
      vi.useRealTimers();
    }

    await setup.manual({ undo: true });
    effects.length = 0;
    expect(await setup.recover()).toBe(false);
    expect(effects).toEqual([]);
  });
});

test('first use after a crash brings the app-server back instead of asking for setup', async () => {
  await fixture('ws://distinct.example/', async ({ setup, read, effects, stopManaged }) => {
    const open = vi.fn(async () => {});
    setup.bindQuestion({ open, answer: () => undefined, retire() {} });
    await setup.manual({ noRemoteControl: true });
    effects.length = 0;
    stopManaged();
    setup.firstUse();
    await vi.waitFor(() => expect(effects).toEqual(['start']));
    await setup.close();
    expect(open).not.toHaveBeenCalled();
    expect(read()?.decision).toBeUndefined();
  });
});
