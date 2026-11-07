import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { OapEngine, OapEngineOptions } from '../../../../src/lib/oap/oap-engine';
import { OapHubRequestError, type OapHubClient } from '../../../../src/lib/oap/oap-hub-client';
import { createOapRuntime } from '../../../../src/lib/oap/oap-runtime';
import type { OapQueryHub } from '../../../../src/lib/oap/oap-query';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';

const options: OapEngineOptions = {
  binaryPath: '/synthetic/oapx',
  identity: { version: 'synthetic', sha256: 'a'.repeat(64) },
  stateDirectory: '/synthetic/state',
  codexExecutable: '/synthetic/codex',
  codexHome: '/synthetic/home',
};
const bind = createOapRuntime as unknown as (
  engine: OapEngine,
  options: OapEngineOptions,
  events: ReturnType<typeof createDaemonInternalEventBus>,
  db: unknown,
  messageHub: unknown
) => (session: Session) => { hub: Promise<OapQueryHub>; clear(): Promise<void> };

function session(nativeId?: string, messageCount = 0): Session {
  return {
    id: 'session-a',
    workspacePath: '/synthetic/workspace',
    sdkSessionId: nativeId,
    config: { harness: 'codex' },
    metadata: { messageCount },
  } as Session;
}

function fixture(
  config: {
    known?: boolean;
    nativeId?: string;
    supportsReopen?: boolean;
    refusal?: OapHubRequestError;
    history?: boolean;
    submitted?: boolean;
    failed?: boolean;
    priorStatus?: 'consumed' | 'failed';
    link?: string;
    freshId?: string;
    failIdentityOnce?: boolean;
    failFreshOpenOnce?: boolean;
    loseFreshOpenResponseOnce?: boolean;
  } = {}
) {
  const operations: Array<{ op: string; params: Record<string, unknown> }> = [];
  let opened = false;
  let threadId = config.nativeId ?? 'native-thread-a';
  let freshOpenFailed = false;
  const request = mock(async (op: string, params: Record<string, unknown>) => {
    operations.push({ op, params });
    if (op === 'work.status') {
      if (!opened && !config.known) throw new OapHubRequestError('unknown_session', 'absent');
      return opened
        ? {
            ref: { adapter: 'codex', session_id: 'session-a' },
            directory: '/synthetic/workspace',
            link: config.link ?? `codex://threads/${threadId}`,
          }
        : {
            ref: { adapter: 'codex', session_id: 'session-a' },
            directory: '/synthetic/workspace',
            held: false,
            state: 'live',
          };
    }
    if (op === 'capabilities')
      return {
        type: 'capabilities.response',
        capability_revision: 'v1',
        payload: {
          features: {
            'session.open.reopen': {
              level: config.supportsReopen === false ? 'unavailable' : 'native',
            },
          },
        },
      };
    if (op === 'open') {
      const payload = (params.request as { payload: { reopen?: boolean } }).payload;
      if (payload.reopen && config.refusal) throw config.refusal;
      if (payload.reopen && !config.known)
        throw new OapHubRequestError('unknown_session', 'absent');
      if (!payload.reopen && config.failFreshOpenOnce && !freshOpenFailed) {
        freshOpenFailed = true;
        throw new OapHubRequestError('timeout', 'synthetic interrupted fresh open');
      }
      if (!payload.reopen && config.freshId) threadId = config.freshId;
      opened = true;
      if (!payload.reopen && config.loseFreshOpenResponseOnce && !freshOpenFailed) {
        freshOpenFailed = true;
        throw new OapHubRequestError('timeout', 'synthetic lost fresh open response');
      }
      return { type: 'session.open.response', payload: { session_id: 'session-a' } };
    }
    if (op === 'close') {
      opened = false;
      return {};
    }
    throw new Error(`unexpected operation ${op}`);
  });
  const client = { request } as unknown as OapHubClient;
  const submit = mock(async () => ({ runId: 'synthetic-run' }));
  const transport = { submit, release: mock(() => {}) } as unknown as OapQueryHub;
  const engine = {
    getHub: mock(async () => client),
    isCurrentHub: mock(() => true),
    createQueryHub: mock(() => transport),
  } as unknown as OapEngine;
  let identityFailed = false;
  const db = {
    updateSession: mock(async (_id: string, update: Partial<Session>) => {
      if (config.failIdentityOnce && update.sdkSessionId === config.freshId && !identityFailed) {
        identityFailed = true;
        throw new Error('synthetic storage failure');
      }
      return 'written';
    }),
    getSDKMessages: mock(() => ({
      messages: config.history
        ? [
            {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'previous answer' }] },
            },
            { type: 'result', subtype: 'success', is_error: false },
          ]
        : config.failed
          ? [{ type: 'user', deliveryStatus: 'failed', message: { content: 'previous request' } }]
          : [],
      hasMore: false,
    })),
    getUserMessagesByStatus: mock((_session: string, status: string) => {
      const prior = (config.submitted && status === 'submitted') || status === config.priorStatus;
      return { messages: prior ? [{ uuid: 'previous-request' }] : [], total: prior ? 1 : 0 };
    }),
    saveSDKMessage: mock(async () => true),
    getSDKMessageRepo: mock(() => ({ getDeliveryContent: () => ({ inputKind: 'human' }) })),
  };
  const messageHub = { event: mock(() => {}) };
  const events = createDaemonInternalEventBus();
  return {
    operations,
    submit,
    db,
    messageHub,
    events,
    runtime: bind(engine, options, events, db, messageHub),
  };
}

describe('OAP native session reopen wiring', () => {
  test('the fallback excerpt excludes an accepted turn with no successful terminal result', async () => {
    const host = fixture({
      known: true,
      freshId: 'native-thread-b',
      refusal: new OapHubRequestError('unknown_session', 'missing'),
    });
    host.db.getSDKMessages.mockReturnValue({
      messages: [
        { type: 'user', deliveryStatus: 'delivered', message: { content: 'completed request' } },
        { type: 'assistant', message: { content: 'completed answer' } },
        { type: 'result', subtype: 'success', is_error: false },
        { type: 'user', deliveryStatus: 'delivered', message: { content: 'unfinished request' } },
        { type: 'assistant', message: { content: 'partial answer' } },
      ] as never,
      hasMore: false,
    });
    const current = session('native-thread-a', 2);
    await host.runtime(current).hub;
    expect(current.metadata.oapRecovery?.text).toContain('completed request');
    expect(current.metadata.oapRecovery?.text).toContain('completed answer');
    expect(current.metadata.oapRecovery?.text).not.toContain('unfinished request');
    expect(current.metadata.oapRecovery?.text).not.toContain('partial answer');
    expect(host.submit).not.toHaveBeenCalled();
  });
  test('a refused reopen saves the excerpt and opens a new thread without submitting', async () => {
    const host = fixture({
      known: true,
      history: true,
      freshId: 'native-thread-b',
      refusal: new OapHubRequestError('unknown_session', 'missing'),
    });
    const current = session('native-thread-a', 2);
    const hub = await host.runtime(current).hub;
    expect(current.sdkSessionId).toBe('native-thread-b');
    expect(current.metadata.oapRecovery?.previous).toBe('native-thread-a');
    expect(current.metadata.oapRecovery?.pendingOpen).toBe(false);
    expect(current.metadata.oapRecovery?.text).toContain('previous answer');
    expect(host.db.saveSDKMessage).toHaveBeenCalledTimes(1);
    expect(host.messageHub.event).toHaveBeenCalledTimes(1);
    expect(host.submit).not.toHaveBeenCalled();
    await hub.submit('session-a', {
      type: 'user',
      uuid: 'next-message',
      session_id: 'session-a',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'explicit request' },
    } as SDKUserMessage);
    expect(JSON.stringify(host.submit.mock.calls[0])).toContain('previous answer');
  });

  test('a lost fresh-open response is adopted without resending a prompt', async () => {
    const host = fixture({
      known: true,
      history: true,
      freshId: 'native-thread-b',
      loseFreshOpenResponseOnce: true,
      refusal: new OapHubRequestError('unknown_session', 'missing'),
    });
    const current = session('native-thread-a', 2);
    const runtime = host.runtime(current);
    await expect(runtime.hub).rejects.toThrow('synthetic lost fresh open response');
    expect(current.metadata.oapRecovery?.pendingOpen).toBe(true);
    expect(host.submit).not.toHaveBeenCalled();
    await runtime.hub;
    expect(current.sdkSessionId).toBe('native-thread-b');
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(2);
    expect(host.submit).not.toHaveBeenCalled();
  });
  test('clearing a session closes the old binding and persists a new native thread', async () => {
    const host = fixture({ known: true, freshId: 'native-thread-b' });
    const current = session('native-thread-a', 2);
    current.sdkOriginPath = '/synthetic/previous';
    const runtime = host.runtime(current);
    await runtime.hub;

    await runtime.clear();

    expect(host.operations.filter(({ op }) => op === 'close')).toHaveLength(1);
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(2);
    expect(current.sdkSessionId).toBe('native-thread-b');
    expect(current.sdkOriginPath).toBeUndefined();
    expect(host.db.updateSession).toHaveBeenCalledWith(
      'session-a',
      expect.objectContaining({ sdkSessionId: 'native-thread-b', sdkOriginPath: undefined })
    );
    expect(host.submit).not.toHaveBeenCalled();
  });

  test('a failed identity write adopts the already opened fresh thread', async () => {
    const host = fixture({ known: true, freshId: 'native-thread-b', failIdentityOnce: true });
    const current = session('native-thread-a', 2);
    const runtime = host.runtime(current);
    await runtime.hub;
    await expect(runtime.clear()).rejects.toThrow('synthetic storage failure');
    expect(current.sdkSessionId).toBe('native-thread-a');
    expect(current.metadata.oapClearThreadId).toBe('native-thread-a');

    await runtime.hub;
    expect(current.sdkSessionId).toBe('native-thread-b');
    expect(current.metadata.oapClearThreadId).toBeUndefined();
    expect(
      host.operations
        .filter(({ op }) => op === 'open')
        .map(({ params }) => (params.request as { payload: { reopen?: boolean } }).payload.reopen)
    ).toEqual([true, undefined]);
    expect(host.submit).not.toHaveBeenCalled();
  });

  test('a clear interrupted before fresh open inspects the old binding without sending on it', async () => {
    const host = fixture({ known: true, freshId: 'native-thread-b', failFreshOpenOnce: true });
    const current = session('native-thread-a', 2);
    const runtime = host.runtime(current);
    await runtime.hub;
    await expect(runtime.clear()).rejects.toThrow('synthetic interrupted fresh open');
    expect(current.sdkSessionId).toBe('native-thread-a');
    expect(current.metadata.oapClearThreadId).toBe('native-thread-a');

    await runtime.hub;
    expect(current.sdkSessionId).toBe('native-thread-b');
    expect(current.metadata.oapClearThreadId).toBeUndefined();
    expect(
      host.operations
        .filter(({ op }) => op === 'open')
        .map(({ params }) => (params.request as { payload: { reopen?: boolean } }).payload.reopen)
    ).toEqual([true, undefined, true, undefined]);
    expect(host.operations.filter(({ op }) => op === 'close')).toHaveLength(2);
    expect(host.submit).not.toHaveBeenCalled();
  });

  test('a lost fresh-open response adopts that thread without opening another', async () => {
    const host = fixture({
      known: true,
      freshId: 'native-thread-b',
      loseFreshOpenResponseOnce: true,
    });
    const current = session('native-thread-a', 2);
    const runtime = host.runtime(current);
    await runtime.hub;
    await expect(runtime.clear()).rejects.toThrow('synthetic lost fresh open response');
    expect(current.metadata.oapClearThreadId).toBe('native-thread-a');

    await runtime.hub;
    expect(current.sdkSessionId).toBe('native-thread-b');
    expect(current.metadata.oapClearThreadId).toBeUndefined();
    expect(
      host.operations
        .filter(({ op }) => op === 'open')
        .map(({ params }) => (params.request as { payload: { reopen?: boolean } }).payload.reopen)
    ).toEqual([true, undefined]);
    expect(host.submit).not.toHaveBeenCalled();
  });

  test('persists the native thread id and keeps a live session usable on later turns', async () => {
    const host = fixture();
    const current = session();
    const runtime = host.runtime(current);
    const first = await runtime.hub;
    expect(host.db.updateSession).toHaveBeenCalledWith('session-a', {
      sdkSessionId: 'native-thread-a',
    });
    expect(current.sdkSessionId).toBe('native-thread-a');
    expect(await runtime.hub).toBe(first);
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(1);
  });

  test.each([true, false])(
    'reopens an existing binding and saves its native id (already saved=%s)',
    async (saved) => {
      const host = fixture({ known: true });
      const current = session(saved ? 'native-thread-a' : undefined, 2);
      await host.runtime(current).hub;
      const opens = host.operations.filter(({ op }) => op === 'open');
      expect(opens).toHaveLength(1);
      expect(opens[0].params).toMatchObject({
        request: { capability_revision: 'v1', payload: { session_id: 'session-a', reopen: true } },
      });
      expect(current.sdkSessionId).toBe('native-thread-a');
      expect(host.submit).not.toHaveBeenCalled();
    }
  );

  test('does not attach a different native thread to a saved session', async () => {
    const host = fixture({ known: true, nativeId: 'another-thread' });
    await expect(host.runtime(session('native-thread-a')).hub).rejects.toThrow(
      /native|thread|identity/i
    );
    expect(host.db.updateSession).not.toHaveBeenCalled();
    expect(host.submit).not.toHaveBeenCalled();
  });

  test.each([
    'https://threads/native-thread-a',
    'codex://threads/native-thread-a/other',
    'codex://threads/native-thread-a?extra=1',
  ])('rejects an invalid native thread link', async (link) => {
    const host = fixture({ link });
    await expect(host.runtime(session()).hub).rejects.toThrow(/native|thread|identity/i);
    expect(host.db.updateSession).not.toHaveBeenCalled();
  });

  test.each([
    { known: false },
    {
      known: true,
      refusal: new OapHubRequestError(
        'unsupported_feature',
        'cannot reopen',
        'session.open.reopen'
      ),
    },
    { known: true, supportsReopen: false },
  ])('visibly recovers an unavailable original thread without sending a prompt', async (config) => {
    const host = fixture({ ...config, freshId: 'native-thread-b' });
    const current = session('native-thread-a', 2);
    await host.runtime(current).hub;
    expect(host.db.saveSDKMessage).toHaveBeenCalledTimes(1);
    expect(host.messageHub.event).toHaveBeenCalledTimes(1);
    expect(current.sdkSessionId).toBe('native-thread-b');
    expect(current.metadata.oapRecovery?.pendingOpen).toBe(false);
    expect(
      host.operations.filter(
        ({ op, params }) =>
          op === 'open' && !(params.request as { payload: { reopen?: boolean } }).payload.reopen
      )
    ).toHaveLength(1);
    expect(host.submit).not.toHaveBeenCalled();
  });

  test('drops a reopen notice if its session is deleted while the notice is being saved', async () => {
    const host = fixture({
      known: true,
      refusal: new OapHubRequestError('unknown_session', 'missing'),
    });
    let noticeStarted!: () => void;
    let finishNotice!: () => void;
    const started = new Promise<void>((resolve) => {
      noticeStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishNotice = resolve;
    });
    host.db.saveSDKMessage.mockImplementation(async () => {
      noticeStarted();
      await gate;
      return true;
    });
    const opening = Promise.resolve(host.runtime(session('native-thread-a')).hub).then(
      () => null,
      (error: Error) => error
    );
    await started;
    const deleting = host.events.publish('session.deleted', { sessionId: 'session-a' });
    finishNotice();
    expect((await opening)?.message).toMatch(/deleted/i);
    await deleting;
    expect(host.messageHub.event).not.toHaveBeenCalled();
    expect(host.submit).not.toHaveBeenCalled();
  });

  test('recovers a legacy session whose binding is missing and history already exists', async () => {
    const host = fixture({ history: true });
    const current = session(undefined, 1);
    await host.runtime(current).hub;
    expect(host.db.saveSDKMessage).toHaveBeenCalledTimes(1);
    expect(current.metadata.oapRecovery?.text).toContain('previous answer');
    expect(host.submit).not.toHaveBeenCalled();
  });

  test.each([{ submitted: true }, { failed: true }])(
    'recovers a legacy thread without resending an earlier submitted or failed delivery',
    async (config) => {
      const host = fixture(config);
      await host.runtime(session()).hub;
      expect(host.db.saveSDKMessage).toHaveBeenCalledTimes(1);
      expect(host.submit).not.toHaveBeenCalled();
    }
  );

  test.each(['consumed', 'failed'] as const)(
    'detects an earlier %s delivery even when it is outside the history page',
    async (priorStatus) => {
      const host = fixture({ priorStatus });
      await host.runtime(session()).hub;
      expect(host.db.saveSDKMessage).toHaveBeenCalledTimes(1);
      expect(host.submit).not.toHaveBeenCalled();
    }
  );

  test('does not confuse an enqueued first prompt with previously delivered history', async () => {
    const host = fixture();
    await host.runtime(session(undefined, 1)).hub;
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(1);
    expect(host.db.saveSDKMessage).not.toHaveBeenCalled();
  });

  test.each([
    new OapHubRequestError('unsupported_feature', 'unrelated', 'run.cancel'),
    new OapHubRequestError('invalid_request', 'directory changed'),
    new OapHubRequestError('timeout', 'transport timeout'),
  ])('never opens a new thread after an unrelated or infrastructure failure', async (refusal) => {
    const host = fixture({ known: true, refusal });
    await expect(host.runtime(session('native-thread-a', 2)).hub).rejects.toBe(refusal);
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(1);
    expect(host.db.updateSession).not.toHaveBeenCalled();
    expect(host.submit).not.toHaveBeenCalled();
  });
});
