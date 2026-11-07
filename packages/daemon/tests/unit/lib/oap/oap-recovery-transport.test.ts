import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { OapEngine, OapEngineOptions } from '../../../../src/lib/oap/oap-engine.ts';
import { OapHubRequestError, type OapHubClient } from '../../../../src/lib/oap/oap-hub-client.ts';
import { OapQuery, type OapQueryHub } from '../../../../src/lib/oap/oap-query.ts';
import type { OapReopenEvents, OapReopenStore } from '../../../../src/lib/oap/oap-reopen.ts';
import { createOapRuntime } from '../../../../src/lib/oap/oap-runtime.ts';

type Recovery = { previous: string | null; text: string; pendingOpen: boolean; claim?: string };
type TestSession = Session & { metadata: Session['metadata'] & { oapRecovery?: Recovery } };

const options: OapEngineOptions = {
  binaryPath: '/synthetic/oapx',
  identity: { version: 'synthetic', sha256: 'a'.repeat(64) },
  stateDirectory: '/synthetic/state',
  codexExecutable: '/synthetic/codex',
  codexHome: '/synthetic/home',
};

const recovery = (): Recovery => ({
  previous: 'old-thread',
  text: 'saved excerpt',
  pendingOpen: false,
});
const prompt = (uuid: string): SDKUserMessage =>
  ({
    type: 'user',
    uuid,
    session_id: 'session-a',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'explicit request' },
  }) as SDKUserMessage;

function fixture(initial?: Recovery) {
  const current = {
    id: 'session-a',
    workspacePath: '/synthetic/workspace',
    sdkSessionId: 'native-thread-a',
    config: { harness: 'codex' },
    metadata: { messageCount: 2, ...(initial ? { oapRecovery: initial } : {}) },
  } as TestSession;
  let stored = structuredClone(current);
  let held = true;
  let nativeId = 'native-thread-a';
  const operations: string[] = [];
  const client = {
    request: mock(async (op: string) => {
      operations.push(op);
      if (op === 'work.status')
        return held
          ? {
              ref: { adapter: 'codex', session_id: 'session-a' },
              directory: current.workspacePath,
              link: `codex://threads/${nativeId}`,
              status: 'done',
            }
          : {
              ref: { adapter: 'codex', session_id: 'session-a' },
              directory: current.workspacePath,
              held: false,
            };
      if (op === 'close') {
        held = false;
        return {};
      }
      if (op === 'open') {
        held = true;
        nativeId = 'native-thread-b';
        return { type: 'session.open.response', payload: { session_id: 'session-a' } };
      }
      throw new Error(`unexpected operation ${op}`);
    }),
  } as unknown as OapHubClient;
  const submit = mock(async (_sessionId: string, _message: SDKUserMessage, _owner?: symbol) => ({
    runId: 'synthetic-run',
  }));
  const release = mock((_owner?: symbol) => {});
  const transport = { submit, release } as unknown as OapQueryHub;
  const engine = {
    getHub: mock(async () => client),
    isCurrentHub: mock(() => true),
    createQueryHub: mock(() => transport),
  } as unknown as OapEngine;
  const getDeliveryContent = mock((_id: string, _uuid: string): { inputKind?: string } | null => ({
    inputKind: 'human',
  }));
  const persist = async (_id: string, update: Partial<Session>) => {
    stored = { ...stored, ...structuredClone(update) } as TestSession;
    return 'written';
  };
  const db = {
    updateSession: mock(persist),
    getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
    getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
    saveSDKMessage: mock(async () => true),
    getSDKMessageRepo: mock(() => ({ getDeliveryContent })),
  };
  const events = createDaemonInternalEventBus();
  const messageHub = { event: mock(() => {}) };
  const bind = createOapRuntime(
    engine,
    options,
    events,
    db as unknown as OapReopenStore,
    messageHub as OapReopenEvents
  );
  const restart = () =>
    createOapRuntime(
      engine,
      options,
      events,
      db as unknown as OapReopenStore,
      messageHub as OapReopenEvents
    )(structuredClone(stored));
  return {
    current,
    db,
    persist,
    getStored: () => structuredClone(stored),
    bind,
    restart,
    getDeliveryContent,
    submit,
    release,
    operations,
  };
}

describe('OAP recovery claim transport', () => {
  test('persists the claim before submit and attaches the excerpt only once', async () => {
    const host = fixture(recovery());
    const hub = await host.bind(host.current).hub;
    host.submit.mockImplementation(async () => {
      expect(host.getStored().metadata.oapRecovery?.claim).toBe('message-1');
      return { runId: 'synthetic-run' };
    });
    await hub.submit('session-a', prompt('message-1'));
    expect(JSON.stringify(host.submit.mock.calls[0])).toContain('saved excerpt');
    expect(JSON.stringify(host.submit.mock.calls[0])).toContain('explicit request');
    expect(host.getStored().metadata.oapRecovery).toBeUndefined();
    host.submit.mockImplementation(async () => ({ runId: 'synthetic-run' }));
    await hub.submit('session-a', prompt('message-2'));
    expect(JSON.stringify(host.submit.mock.calls[1])).not.toContain('saved excerpt');
  });

  test('does not reattach an accepted excerpt after restart when marker cleanup failed', async () => {
    const host = fixture(recovery());
    host.db.updateSession.mockImplementation(async (id, update) => {
      if (update.metadata && !('oapRecovery' in update.metadata && update.metadata.oapRecovery))
        throw new Error('synthetic marker cleanup failure');
      return host.persist(id, update);
    });
    const first = await host.bind(host.current).hub;
    host.submit.mockImplementation(async () => {
      expect(host.getStored().metadata.oapRecovery?.claim).toBe('message-1');
      return { runId: 'synthetic-run' };
    });
    await first.submit('session-a', prompt('message-1'));
    expect(JSON.stringify(host.submit.mock.calls[0])).toContain('saved excerpt');
    expect(host.getStored().metadata.oapRecovery?.claim).toBe('message-1');
    host.submit.mockImplementation(async () => ({ runId: 'synthetic-run' }));
    const restarted = await host.restart().hub;
    expect(host.submit).toHaveBeenCalledTimes(1);
    await restarted.submit('session-a', prompt('message-2'));
    expect(JSON.stringify(host.submit.mock.calls[1])).not.toContain('saved excerpt');
  });

  test.each(['invalid_request', 'busy', 'unknown_session', 'unsupported_feature'])(
    'restores the durable claim after an explicit %s refusal',
    async (code) => {
      const host = fixture(recovery());
      const hub = await host.bind(host.current).hub;
      host.submit.mockRejectedValueOnce(new OapHubRequestError(code, 'synthetic refusal'));
      await expect(hub.submit('session-a', prompt('message-1'))).rejects.toThrow(
        'synthetic refusal'
      );
      expect(host.submit).toHaveBeenCalledTimes(1);
      expect(host.getStored().metadata.oapRecovery?.claim).toBeUndefined();
      const restarted = await host.restart().hub;
      await restarted.submit('session-a', prompt('message-2'));
      expect(JSON.stringify(host.submit.mock.calls[1])).toContain('saved excerpt');
    }
  );

  test('keeps an ambiguous submission claimed and does not repeat it', async () => {
    const host = fixture(recovery());
    const hub = await host.bind(host.current).hub;
    host.submit.mockRejectedValueOnce(new OapHubRequestError('timeout', 'synthetic timeout'));
    await expect(hub.submit('session-a', prompt('message-1'))).rejects.toThrow('synthetic timeout');
    expect(host.getStored().metadata.oapRecovery?.claim).toBe('message-1');
    const restarted = await host.restart().hub;
    expect(host.submit).toHaveBeenCalledTimes(1);
    await expect(restarted.submit('session-a', prompt('message-1'))).rejects.toThrow(
      /already|unknown/i
    );
    expect(host.submit).toHaveBeenCalledTimes(1);
    await restarted.submit('session-a', prompt('message-2'));
    expect(JSON.stringify(host.submit.mock.calls[1])).not.toContain('saved excerpt');
  });

  test('an interrupted query cannot submit while the claim write is pending', async () => {
    const host = fixture(recovery());
    const hub = await host.bind(host.current).hub;
    let signalStarted!: () => void;
    let finishWrite!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    host.db.updateSession.mockImplementation(async (id, update) => {
      if ((update.metadata as TestSession['metadata'] | undefined)?.oapRecovery?.claim) {
        signalStarted();
        await gate;
      }
      return host.persist(id, update);
    });
    const query = new OapQuery({
      sessionId: 'session-a',
      prompt: (async function* () {
        yield prompt('message-1');
      })(),
      hub,
      translator: { translate: () => [] },
    });
    const running = (async () => {
      for await (const item of query) void item;
    })().catch((error: Error) => error);
    try {
      await Promise.race([
        started,
        running.then(() => {
          throw new Error('submitted before the claim was saved');
        }),
      ]);
      const interrupted = query.interrupt().catch((error: Error) => error);
      finishWrite();
      await Promise.all([running, interrupted]);
    } finally {
      finishWrite();
      query.close();
    }
    expect(host.submit).not.toHaveBeenCalled();
    expect(host.getStored().metadata.oapRecovery?.claim).toBeUndefined();
  });

  test('does not consume the claim when local input is not text', async () => {
    const host = fixture(recovery());
    const hub = await host.bind(host.current).hub;
    const message = {
      ...prompt('message-1'),
      message: { role: 'user', content: [{ type: 'image' }] },
    } as SDKUserMessage;
    await expect(hub.submit('session-a', message)).rejects.toThrow(/text/i);
    expect(host.submit).not.toHaveBeenCalled();
    expect(host.getStored().metadata.oapRecovery?.claim).toBeUndefined();
  });

  test('does not submit when saving the claim fails', async () => {
    const host = fixture(recovery());
    const hub = await host.bind(host.current).hub;
    host.db.updateSession.mockRejectedValueOnce(new Error('synthetic claim write failure'));
    await expect(hub.submit('session-a', prompt('message-1'))).rejects.toThrow(
      /claim|save|persist/i
    );
    expect(host.submit).not.toHaveBeenCalled();
    expect(host.getStored().metadata.oapRecovery?.claim).toBeUndefined();
  });

  test('closing an attempt during claim persistence prevents submission and restores the claim', async () => {
    const host = fixture(recovery());
    const hub = await host.bind(host.current).hub;
    let signalStarted!: () => void;
    let finishWrite!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    host.db.updateSession.mockImplementation(async (id, update) => {
      if ((update.metadata as TestSession['metadata'] | undefined)?.oapRecovery?.claim) {
        signalStarted();
        await gate;
      }
      return host.persist(id, update);
    });
    const owner = Symbol('attempt');
    const pending = hub.submit('session-a', prompt('message-1'), owner).then(
      () => null,
      (error: Error) => error
    );
    try {
      await Promise.race([
        started,
        pending.then(() => {
          throw new Error('submitted before the claim was saved');
        }),
      ]);
      hub.release?.(owner);
    } finally {
      finishWrite();
    }
    expect(await pending).toBeInstanceOf(Error);
    expect(host.submit).not.toHaveBeenCalled();
    expect(host.getStored().metadata.oapRecovery?.claim).toBeUndefined();
  });

  test('does not send a second prompt while the first claim write is pending', async () => {
    const host = fixture(recovery());
    const hub = await host.bind(host.current).hub;
    let signalStarted!: () => void;
    let finishWrite!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    host.db.updateSession.mockImplementation(async (id, update) => {
      if ((update.metadata as TestSession['metadata'] | undefined)?.oapRecovery?.claim) {
        signalStarted();
        await gate;
      }
      return host.persist(id, update);
    });
    const owner = Symbol('attempt');
    const pending = hub.submit('session-a', prompt('message-1'), owner).then(
      () => null,
      (error: Error) => error
    );
    try {
      await Promise.race([
        started,
        pending.then(() => {
          throw new Error('submitted before the claim was saved');
        }),
      ]);
      await expect(hub.submit('session-a', prompt('message-2'))).rejects.toThrow(
        /available|pending|busy/i
      );
      hub.release?.(owner);
    } finally {
      finishWrite();
    }
    await pending;
    expect(host.submit).not.toHaveBeenCalled();
  });

  test('without a recovery marker the transport passes messages and release unchanged', async () => {
    const host = fixture();
    const hub = await host.bind(host.current).hub;
    const owner = Symbol('attempt');
    const message = prompt('message-1');
    await hub.submit('session-a', message, owner, () => false);
    hub.release?.(owner);
    expect(host.submit).toHaveBeenCalledWith('session-a', message, owner);
    expect(host.release).toHaveBeenCalledWith(owner);
    expect(host.db.updateSession).not.toHaveBeenCalled();
  });

  test.each(['system', 'task'])(
    'does not attach or claim the excerpt for a %s input',
    async (inputKind) => {
      const host = fixture(recovery());
      host.getDeliveryContent.mockReturnValueOnce({ inputKind });
      const hub = await host.bind(host.current).hub;
      await hub.submit('session-a', prompt('message-1'));
      expect(JSON.stringify(host.submit.mock.calls[0])).not.toContain('saved excerpt');
      expect(host.getStored().metadata.oapRecovery?.claim).toBeUndefined();
    }
  );

  test.each([null, {}])(
    'refuses to submit if the recovery input cannot be identified',
    async (input) => {
      const host = fixture(recovery());
      host.getDeliveryContent.mockReturnValueOnce(input);
      const hub = await host.bind(host.current).hub;
      await expect(hub.submit('session-a', prompt('message-1'))).rejects.toThrow(
        /identif|recovery/i
      );
      expect(host.submit).not.toHaveBeenCalled();
      expect(host.getStored().metadata.oapRecovery?.claim).toBeUndefined();
    }
  );

  test('does not submit while the recovered thread is still opening', async () => {
    const host = fixture({ ...recovery(), pendingOpen: true });
    const hub = await host.bind(host.current).hub;
    await expect(hub.submit('session-a', prompt('message-1'))).rejects.toThrow(/recovery|opening/i);
    expect(host.submit).not.toHaveBeenCalled();
  });

  test('a deliberate fresh clear discards a pending excerpt', async () => {
    const host = fixture(recovery());
    const runtime = host.bind(host.current);
    await runtime.hub;
    await runtime.clear!();
    expect(host.current.sdkSessionId).toBe('native-thread-b');
    expect(host.current.metadata.oapRecovery).toBeUndefined();
    expect(host.getStored().metadata.oapRecovery).toBeUndefined();
    expect(host.submit).not.toHaveBeenCalled();
  });

  test('a reloaded session consumes its pending excerpt on the cached transport', async () => {
    const host = fixture(recovery());
    const first = await host.bind(host.current).hub;
    const restored = structuredClone(host.current);
    const cached = await host.bind(restored).hub;
    expect(cached).toBe(first);
    await cached.submit('session-a', prompt('message-1'));
    expect(JSON.stringify(host.submit.mock.calls[0])).toContain('saved excerpt');
    expect(restored.metadata.oapRecovery).toBeUndefined();
  });
});
