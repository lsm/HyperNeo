import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { OapEngine, OapEngineOptions } from '../../../../src/lib/oap/oap-engine';
import { OapHubRequestError, type OapHubClient } from '../../../../src/lib/oap/oap-hub-client';
import * as query from '../../../../src/lib/oap/oap-query';
import type { OapQueryRuntime } from '../../../../src/lib/agent/query-runner';
import type { OapQueryHub } from '../../../../src/lib/oap/oap-query';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';

const bindOapRuntime = (
  query as unknown as {
    createOapRuntime(
      engine: OapEngine,
      options?: OapEngineOptions,
      events?: ReturnType<typeof createDaemonInternalEventBus>,
      db?: unknown,
      messageHub?: unknown
    ): (session: Session) => OapQueryRuntime;
  }
).createOapRuntime;

function createOapRuntime(
  engine: OapEngine,
  options?: OapEngineOptions,
  events?: ReturnType<typeof createDaemonInternalEventBus>,
  history = false
): (session: Session) => OapQueryRuntime {
  const db = {
    updateSession: mock(async () => 'written'),
    getSDKMessages: mock(() => ({
      messages: history ? [{ type: 'assistant' }] : [],
      hasMore: false,
    })),
    getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
    saveSDKMessage: mock(async () => true),
  };
  return bindOapRuntime(engine, options, events, db, { event: mock(() => {}) });
}

const options: OapEngineOptions = {
  binaryPath: '/synthetic/oapx',
  identity: { version: 'synthetic', sha256: 'a'.repeat(64) },
  stateDirectory: '/synthetic/state',
  codexExecutable: '/synthetic/codex',
  codexHome: '/synthetic/codex-home',
};

function session(id: string, workspace: string): Session {
  return {
    id,
    workspacePath: workspace,
    config: { harness: 'codex' },
  } as Session;
}

function fixture(status?: { directory: string }) {
  const opened = new Map<string, string>();
  const recorded = new Map<string, string>();
  const operations: Array<{ op: string; parameters: Record<string, unknown> }> = [];
  const request = mock(async (op: string, parameters: Record<string, unknown>) => {
    operations.push({ op, parameters });
    if (op === 'work.status') {
      const id = parameters.session_id as string;
      const directory = opened.get(id);
      if (directory)
        return {
          ref: { adapter: 'codex', session_id: id },
          directory,
          link: `codex://threads/native-${id}`,
          status: 'done',
        };
      const prior = recorded.get(id) ?? status?.directory;
      if (prior)
        return {
          ref: { adapter: 'codex', session_id: id },
          directory: prior,
          held: false,
          state: 'live',
        };
      throw new OapHubRequestError('unknown_session', 'no session');
    }
    if (op === 'capabilities')
      return {
        type: 'capabilities.response',
        capability_revision: 'v1',
        payload: { features: { 'session.open.reopen': { level: 'native' } } },
      };
    if (op === 'close') return {};
    if (op === 'open') {
      const envelope = parameters.request as { payload: { session_id: string; reopen?: boolean } };
      const id = envelope.payload.session_id;
      if (envelope.payload.reopen && !recorded.has(id) && !status)
        throw new OapHubRequestError('unknown_session', 'no session');
      opened.set(id, parameters.directory as string);
      return { type: 'session.open.response', payload: { session_id: id } };
    }
    throw new Error(`unexpected operation ${op}`);
  });
  const client = { request } as unknown as OapHubClient;
  const getHub = mock(async () => client);
  const createQueryHub = mock(
    (_client: OapHubClient) =>
      ({
        release: mock(() => {}),
        submit: mock(async () => ({ runId: 'synthetic-run' })),
      }) as unknown as OapQueryHub
  );
  const isCurrentHub = mock((_client: OapHubClient) => true);
  const engine = { getHub, createQueryHub, isCurrentHub } as unknown as OapEngine;
  return { engine, client, getHub, createQueryHub, isCurrentHub, operations, recorded };
}

describe('OAP daemon runtime', () => {
  test('lazily opens the exact session workspace once, even across concurrent callers', async () => {
    const host = fixture();
    const bind = createOapRuntime(host.engine, options);
    const runtime = bind(session('session-a', '/synthetic/workspace'));
    expect(host.getHub).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([runtime.hub, runtime.hub]);
    expect(first).toBe(second);
    expect(host.createQueryHub).toHaveBeenCalledTimes(1);
    expect(host.createQueryHub).toHaveBeenCalledWith(host.client);
    expect(host.getHub).toHaveBeenCalledTimes(1);
    expect(host.getHub).toHaveBeenCalledWith(options);
    expect(host.operations.map(({ op }) => op)).toEqual(['work.status', 'open', 'work.status']);
    expect(host.operations[1].parameters).toMatchObject({
      adapter: 'codex',
      directory: '/synthetic/workspace',
      request: {
        protocol: 'open-agent-protocol',
        type: 'session.open.request',
        payload: { session_id: 'session-a' },
      },
    });
  });

  test('keeps separate query transports for sessions sharing one daemon hub', async () => {
    const host = fixture();
    const bind = createOapRuntime(host.engine, options);
    const first = bind(session('session-a', '/synthetic/workspace'));
    const second = bind(session('session-b', '/synthetic/other'));
    const [firstHub, secondHub] = await Promise.all([first.hub, second.hub]);
    expect(firstHub).not.toBe(secondHub);
    expect(await bind(session('session-a', '/synthetic/workspace')).hub).toBe(firstHub);
    expect(host.createQueryHub).toHaveBeenCalledTimes(2);
    const opens = host.operations.filter(({ op }) => op === 'open');
    expect(opens.map(({ parameters }) => parameters.directory)).toEqual([
      '/synthetic/workspace',
      '/synthetic/other',
    ]);
  });

  test('retries a failed hub start only on a later explicit request', async () => {
    const host = fixture();
    host.getHub.mockRejectedValueOnce(new Error('synthetic startup failure'));
    const runtime = createOapRuntime(
      host.engine,
      options
    )(session('session-a', '/synthetic/workspace'));
    const first = await Promise.allSettled([runtime.hub, runtime.hub]);
    expect(first.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(host.getHub).toHaveBeenCalledTimes(1);
    expect(host.operations).toHaveLength(0);
    await expect(runtime.hub).resolves.toBeDefined();
    expect(host.getHub).toHaveBeenCalledTimes(2);
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(1);
  });

  test('replaces dead per-session transports only when sessions are explicitly used again', async () => {
    const host = fixture();
    const replacement = fixture();
    replacement.recorded.set('session-a', '/synthetic/workspace');
    replacement.recorded.set('session-b', '/synthetic/other');
    const bind = createOapRuntime(host.engine, options);
    const first = bind(session('session-a', '/synthetic/workspace'));
    const second = bind(session('session-b', '/synthetic/other'));
    const [oldFirst, oldSecond] = await Promise.all([first.hub, second.hub]);

    host.isCurrentHub.mockImplementation((client) => client === replacement.client);
    host.getHub.mockResolvedValue(replacement.client);
    expect(host.getHub).toHaveBeenCalledTimes(2);
    expect(replacement.operations).toHaveLength(0);

    const [newFirst, sameFirst] = await Promise.all([first.hub, first.hub]);
    expect(newFirst).toBe(sameFirst);
    expect(newFirst).not.toBe(oldFirst);
    expect(oldFirst.release).toHaveBeenCalledTimes(1);
    expect(oldSecond.release).not.toHaveBeenCalled();
    expect(replacement.operations.map(({ op }) => op)).toEqual([
      'work.status',
      'capabilities',
      'open',
      'work.status',
    ]);

    const newSecond = await second.hub;
    expect(newSecond).not.toBe(oldSecond);
    expect(newSecond).not.toBe(newFirst);
    expect(oldSecond.release).toHaveBeenCalledTimes(1);
    expect(replacement.operations.filter(({ op }) => op === 'open')).toHaveLength(2);
  });

  test('refuses to replace known history after the shared hub dies', async () => {
    const host = fixture();
    const replacement = fixture();
    const bind = createOapRuntime(host.engine, options);
    const runtime = bind(session('session-a', '/synthetic/workspace'));
    const oldHub = await runtime.hub;
    host.isCurrentHub.mockImplementation((client) => client === replacement.client);
    host.getHub.mockResolvedValue(replacement.client);

    await expect(runtime.hub).rejects.toThrow(/resum|reopen/i);
    expect(oldHub.release).toHaveBeenCalledTimes(1);
    expect(replacement.operations.map(({ op }) => op)).toEqual([
      'work.status',
      'capabilities',
      'open',
    ]);
    expect(replacement.operations.find(({ op }) => op === 'open')?.parameters).toMatchObject({
      request: { payload: { reopen: true } },
    });
  });

  test('does not replace a completed session when its hub history is missing', async () => {
    const host = fixture();
    const replacement = fixture();
    const bind = createOapRuntime(host.engine, options);
    const oldHub = await bind(session('session-a', '/synthetic/workspace')).hub;
    host.isCurrentHub.mockReturnValue(false);
    host.getHub.mockResolvedValue(replacement.client);
    const completed = {
      ...session('session-a', '/synthetic/workspace'),
      sdkSessionId: 'native-session-a',
      metadata: { messageCount: 1 },
    } as Session;

    await expect(bind(completed).hub).rejects.toThrow(/resum|reopen/i);
    expect(oldHub.release).toHaveBeenCalledTimes(1);
    expect(host.getHub).toHaveBeenCalledTimes(2);
    expect(replacement.operations.find(({ op }) => op === 'open')?.parameters).toMatchObject({
      request: { payload: { reopen: true } },
    });
  });

  test('does not create a fresh thread after the first submitted turn loses its hub', async () => {
    const host = fixture();
    const replacement = fixture();
    const runtime = createOapRuntime(
      host.engine,
      options
    )(session('session-a', '/synthetic/workspace'));
    const oldHub = await runtime.hub;
    await oldHub.submit('session-a', {} as Parameters<OapQueryHub['submit']>[1]);
    host.isCurrentHub.mockImplementation((client) => client === replacement.client);
    host.getHub.mockResolvedValue(replacement.client);

    await expect(runtime.hub).rejects.toThrow(/resum|reopen/i);
    expect(oldHub.release).toHaveBeenCalledTimes(1);
    expect(host.getHub).toHaveBeenCalledTimes(2);
    expect(replacement.operations.find(({ op }) => op === 'open')?.parameters).toMatchObject({
      request: { payload: { reopen: true } },
    });
  });

  test('rechecks history after an ambiguous open failure before considering another open', async () => {
    const host = fixture();
    let openCount = 0;
    let created = false;
    (host.client.request as ReturnType<typeof mock>).mockImplementation(async (op: string) => {
      if (op === 'work.status') {
        if (!created) throw new OapHubRequestError('unknown_session', 'no session');
        return {
          ref: { adapter: 'codex', session_id: 'session-a' },
          directory: '/synthetic/workspace',
          link: 'codex://threads/native-session-a',
          status: 'done',
        };
      }
      if (op === 'open') {
        openCount++;
        created = true;
        throw new OapHubRequestError('timeout', 'synthetic ambiguous open');
      }
      throw new Error(`unexpected operation ${op}`);
    });
    const runtime = createOapRuntime(
      host.engine,
      options
    )(session('session-a', '/synthetic/workspace'));
    await expect(runtime.hub).rejects.toThrow('ambiguous open');
    await expect(runtime.hub).resolves.toBeDefined();
    expect(openCount).toBe(1);
  });

  test('closes only the deleted session and prevents its stale runtime reopening', async () => {
    const host = fixture();
    const events = createDaemonInternalEventBus();
    const bind = createOapRuntime(host.engine, options, events);
    const first = bind(session('session-a', '/synthetic/workspace'));
    const second = bind(session('session-b', '/synthetic/other'));
    const [firstHub, secondHub] = await Promise.all([first.hub, second.hub]);
    await events.publish('session.deleted', { sessionId: 'session-a' });
    expect(firstHub.release).toHaveBeenCalledTimes(1);
    expect(secondHub.release).not.toHaveBeenCalled();
    expect(host.operations.filter(({ op }) => op === 'close')).toEqual([
      { op: 'close', parameters: { session_id: 'session-a' } },
    ]);
    expect(await second.hub).toBe(secondHub);
    await expect(first.hub).rejects.toThrow(/deleted/i);
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(2);
  });

  test('deletion during session open retires the attempt and closes the opened session', async () => {
    const host = fixture();
    const events = createDaemonInternalEventBus();
    let finishOpen!: () => void;
    let openStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      openStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const request = host.client.request as ReturnType<typeof mock>;
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (op: string, parameters: Record<string, unknown>) => {
      if (op === 'open') {
        openStarted();
        await gate;
      }
      return original(op, parameters);
    });
    const runtime = createOapRuntime(
      host.engine,
      options,
      events
    )(session('session-a', '/synthetic/workspace'));
    const opening = Promise.resolve(runtime.hub);
    const result = opening.then(
      () => 'opened',
      (error: Error) => error.message
    );
    await started;
    const deleting = events.publish('session.deleted', { sessionId: 'session-a' });
    finishOpen();
    expect(await result).toMatch(/deleted/i);
    await deleting;
    expect(host.operations.filter(({ op }) => op === 'close')).toEqual([
      { op: 'close', parameters: { session_id: 'session-a' } },
    ]);
    expect(host.createQueryHub).not.toHaveBeenCalled();
    await expect(runtime.hub).rejects.toThrow(/deleted/i);
  });

  test('opens a worktree path instead of its parent workspace', async () => {
    const host = fixture();
    const withWorktree = {
      ...session('session-a', '/synthetic/workspace'),
      worktree: { worktreePath: '/synthetic/worktree' },
    } as Session;
    await createOapRuntime(host.engine, options)(withWorktree).hub;
    expect(host.operations.find(({ op }) => op === 'open')?.parameters.directory).toBe(
      '/synthetic/worktree'
    );
  });

  test('rejects changing an already opened session workspace', async () => {
    const host = fixture();
    const bind = createOapRuntime(host.engine, options);
    await bind(session('session-a', '/synthetic/workspace')).hub;
    await expect(bind(session('session-a', '/synthetic/other')).hub).rejects.toThrow(/workspace/i);
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(1);
  });

  test('reopens an existing history binding', async () => {
    const host = fixture({ directory: '/synthetic/workspace' });
    const runtime = createOapRuntime(
      host.engine,
      options
    )(session('session-a', '/synthetic/workspace'));
    await expect(runtime.hub).resolves.toBeDefined();
    expect(host.operations.map(({ op }) => op)).toEqual([
      'work.status',
      'capabilities',
      'open',
      'work.status',
    ]);
  });

  test('does not replace a saved native session when hub history is missing', async () => {
    const host = fixture();
    const resumed = { ...session('session-a', '/synthetic/workspace'), sdkSessionId: 'native-a' };
    const runtime = createOapRuntime(host.engine, options)(resumed);
    await expect(runtime.hub).rejects.toThrow(/resum|reopen/i);
    expect(host.operations.find(({ op }) => op === 'open')?.parameters).toMatchObject({
      request: { payload: { reopen: true } },
    });
  });

  test('does not start a fresh thread for a completed session whose hub history is missing', async () => {
    const host = fixture();
    const resumed = {
      ...session('session-a', '/synthetic/workspace'),
      metadata: { messageCount: 1 },
    } as Session;
    const runtime = createOapRuntime(host.engine, options, undefined, true)(resumed);
    await expect(runtime.hub).rejects.toThrow(/resum|reopen/i);
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(0);
  });

  test('refuses a hub that cannot prove the requested directory', async () => {
    const host = fixture();
    let probes = 0;
    (host.client.request as ReturnType<typeof mock>).mockImplementation(async (op: string) => {
      if (op === 'work.status' && ++probes === 1)
        throw new OapHubRequestError('unknown_session', 'no session');
      if (op === 'work.status') return { directory: '/synthetic/other' };
      return {
        type: 'session.open.response',
        payload: { session_id: 'session-a' },
      };
    });
    const runtime = createOapRuntime(
      host.engine,
      options
    )(session('session-a', '/synthetic/workspace'));
    await expect(runtime.hub).rejects.toThrow(/open-directory|workspace/i);
  });

  test('refuses a missing configuration or nonabsolute workspace before launching a hub', async () => {
    const host = fixture();
    await expect(
      createOapRuntime(host.engine)(session('a', '/synthetic/workspace')).hub
    ).rejects.toThrow(/config/i);
    await expect(
      createOapRuntime(host.engine, options)(session('a', 'relative')).hub
    ).rejects.toThrow(/absolute/i);
    expect(host.getHub).not.toHaveBeenCalled();
  });
});
