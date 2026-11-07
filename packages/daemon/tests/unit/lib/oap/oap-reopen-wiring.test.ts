import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { OapEngine, OapEngineOptions } from '../../../../src/lib/oap/oap-engine';
import { OapHubRequestError, type OapHubClient } from '../../../../src/lib/oap/oap-hub-client';
import { createOapRuntime } from '../../../../src/lib/oap/oap-runtime';
import type { OapQueryHub } from '../../../../src/lib/oap/oap-query';

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
) => (session: Session) => { hub: Promise<OapQueryHub> };

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
    link?: string;
  } = {}
) {
  const operations: Array<{ op: string; params: Record<string, unknown> }> = [];
  let opened = false;
  const request = mock(async (op: string, params: Record<string, unknown>) => {
    operations.push({ op, params });
    if (op === 'work.status') {
      if (!opened && !config.known) throw new OapHubRequestError('unknown_session', 'absent');
      return opened
        ? {
            ref: { adapter: 'codex', session_id: 'session-a' },
            directory: '/synthetic/workspace',
            link: config.link ?? `codex://threads/${config.nativeId ?? 'native-thread-a'}`,
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
      opened = true;
      return { type: 'session.open.response', payload: { session_id: 'session-a' } };
    }
    if (op === 'close') return {};
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
  const db = {
    updateSession: mock(async () => 'written'),
    getSDKMessages: mock(() => ({
      messages: config.history
        ? [{ type: 'assistant', message: { content: [{ type: 'text', text: 'previous answer' }] } }]
        : config.failed
          ? [{ type: 'user', deliveryStatus: 'failed', message: { content: 'previous request' } }]
          : [],
      hasMore: false,
    })),
    getUserMessagesByStatus: mock(() => ({
      messages: config.submitted ? [{ uuid: 'previous-request' }] : [],
      total: config.submitted ? 1 : 0,
    })),
    saveSDKMessage: mock(async () => true),
  };
  const messageHub = { event: mock(() => {}) };
  const events = createDaemonInternalEventBus();
  return {
    operations,
    submit,
    db,
    messageHub,
    runtime: bind(engine, options, events, db, messageHub),
  };
}

describe('OAP native session reopen wiring', () => {
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
  ])(
    'visibly refuses an unavailable original thread without silently creating a new one',
    async (config) => {
      const host = fixture(config);
      await expect(host.runtime(session('native-thread-a', 2)).hub).rejects.toThrow(
        /resum|reopen|absent/i
      );
      expect(host.db.saveSDKMessage).toHaveBeenCalledTimes(1);
      expect(host.messageHub.event).toHaveBeenCalledTimes(1);
      expect(host.db.updateSession).not.toHaveBeenCalled();
      expect(
        host.operations.filter(
          ({ op, params }) =>
            op === 'open' && !(params.request as { payload: { reopen?: boolean } }).payload.reopen
        )
      ).toHaveLength(0);
      expect(host.submit).not.toHaveBeenCalled();
    }
  );

  test('does not replace a legacy session whose binding is missing and history already exists', async () => {
    const host = fixture({ history: true });
    await expect(host.runtime(session(undefined, 1)).hub).rejects.toThrow(/resum|reopen/i);
    expect(host.db.saveSDKMessage).toHaveBeenCalledTimes(1);
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(0);
  });

  test.each([{ submitted: true }, { failed: true }])(
    'does not replace a legacy thread after an earlier submitted or failed delivery',
    async (config) => {
      const host = fixture(config);
      await expect(host.runtime(session()).hub).rejects.toThrow(/resum|reopen/i);
      expect(host.db.saveSDKMessage).toHaveBeenCalledTimes(1);
      expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(0);
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
