import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MessageHub, MessageHubRouter } from '@hyperneo/shared';
import { parseMailboxEntry } from '../../../../src/lib/mailbox/entry';
import {
  parseAddress,
  parseRemoteAddress,
  renderRemoteAddress,
} from '../../../../src/lib/mailbox/address';
import { createSendMessageOperation } from '../../../../src/lib/messaging/message-send';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createDiscoveryOperations } from '../../../../src/lib/operations/discovery';
import { setupOperationHandlers } from '../../../../src/lib/rpc-handlers/operation-handlers';
import { RemoteDaemonRegistry } from '../../../../src/lib/remote-daemons/registry';
import { createRemoteSendForwarder } from '../../../../src/lib/remote-daemons/forward-send';
import { createAttachDaemonOperation } from '../../../../src/lib/remote-daemons/attach-operation';
import { createHttpWsServer, type ServerHandle } from '../../../../src/lib/runtime-server/index';
import { WebSocketServerTransport } from '../../../../src/lib/websocket-server-transport';
import { createWebSocketHandlers } from '../../../../src/routes/setup-websocket';
import type { SessionManager } from '../../../../src/lib/session-manager';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const message = {
  type: 'user',
  message: { content: 'ping from daemon A' },
  parent_tool_use_id: null,
};

const noSessionManager = {
  getSessionForControl: async () => null,
} as unknown as SessionManager;

type RemoteDaemon = {
  mailbox: MailboxTestDb;
  url: string;
  clientCount: () => number;
  stop: () => Promise<void>;
};

async function startRemoteDaemon(knownSessionId: string): Promise<RemoteDaemon> {
  const mailbox = createMailboxTestDb();
  const registry = createOperationRegistry([
    createSendMessageOperation(mailbox.jobQueue, (sessionId) => sessionId === knownSessionId),
    ...createDiscoveryOperations(() => registry),
  ]);
  const router = new MessageHubRouter({
    logger: { error: () => {}, warn: () => {}, log: () => {} },
  });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  hub.registerRouter(router);
  const transport = new WebSocketServerTransport({ name: 'remote-daemon-b', router });
  hub.registerTransport(transport);
  await transport.initialize();
  setupOperationHandlers(hub, registry);

  const handlers = createWebSocketHandlers(transport, noSessionManager);
  const server: ServerHandle = await createHttpWsServer({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, upgrade) =>
      new URL(request.url).pathname === '/ws'
        ? (upgrade(request, { connectionSessionId: 'global' }) ??
          new Response('upgrade failed', { status: 500 }))
        : new Response('not found', { status: 404 }),
    websocket: handlers,
  });

  return {
    mailbox,
    url: `ws://127.0.0.1:${server.port}/ws`,
    clientCount: () => transport.getClientCount(),
    stop: async () => {
      await transport.close();
      server.stop(true);
      mailbox.close();
    },
  };
}

async function startSilentServer(): Promise<{ url: string; stop: () => void }> {
  const server: ServerHandle = await createHttpWsServer({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  return { url: `ws://127.0.0.1:${server.port}/ws`, stop: () => server.stop(true) };
}

async function startUnresponsiveWebSocketServer(): Promise<{ url: string; stop: () => void }> {
  const server: ServerHandle = await createHttpWsServer({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, upgrade) =>
      upgrade(request, { connectionSessionId: 'global' }) ??
      new Response('upgrade failed', { status: 500 }),
    websocket: { message: () => {} },
  });
  return { url: `ws://127.0.0.1:${server.port}/ws`, stop: () => server.stop(true) };
}

async function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null).catch((error) => error);
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('forwarding message.send to an attached daemon', () => {
  let remote: RemoteDaemon;
  let local: MailboxTestDb;
  let daemons: RemoteDaemonRegistry;

  beforeEach(async () => {
    remote = await startRemoteDaemon('session-on-b');
    local = createMailboxTestDb();
    daemons = new RemoteDaemonRegistry();
  });

  afterEach(async () => {
    local.close();
    await remote.stop();
  });

  function localRegistry() {
    return createOperationRegistry([
      createSendMessageOperation(
        local.jobQueue,
        (sessionId) => sessionId === 'session-on-a',
        createRemoteSendForwarder(daemons)
      ),
    ]);
  }

  function send(sessionId: string) {
    return invokeOperation(
      localRegistry(),
      'message.send',
      { sessionId, message },
      { source: 'mcp', sessionId: 'agent-on-a' }
    );
  }

  test('lands a forwarded send in the attached daemon mailbox, not the local one', async () => {
    daemons.attach('b', remote.url);

    const outcome = await send('daemon:b::session:session-on-b');

    const entry = parseMailboxEntry(JSON.parse(remote.mailbox.rows()[0].payload));
    expect(entry?.to).toEqual({ kind: 'session', sessionId: 'session-on-b' });
    expect(entry?.message).toEqual(message);
    expect(outcome).toEqual({
      kind: 'completed',
      value: { kind: 'accepted', mailboxId: entry?.id, messageId: entry?.messageUuid },
    });
    expect(local.rowCount()).toBe(0);
  });

  test('probes the operation door without retaining a connection or attachment', async () => {
    await daemons.probe(remote.url);

    await waitFor(() => remote.clientCount() === 0);
    expect(remote.clientCount()).toBe(0);
    expect(daemons.list()).toEqual([]);
  });

  test('closes the previous socket when the same daemon is attached again', async () => {
    daemons.attach('b', remote.url);
    await send('daemon:b::session:session-on-b');
    expect(remote.clientCount()).toBe(1);

    daemons.attach('b', remote.url);
    await send('daemon:b::session:session-on-b');

    await waitFor(() => remote.clientCount() === 1);
    expect(remote.clientCount()).toBe(1);
  });

  test('returns the remote daemon own rejection for a session it does not know', async () => {
    daemons.attach('b', remote.url);

    const outcome = await send('daemon:b::session:session-ghost');

    expect(outcome).toEqual({
      kind: 'completed',
      value: { kind: 'rejected', reason: 'Unknown session: session-ghost' },
    });
    expect(remote.mailbox.rowCount()).toBe(0);
    expect(local.rowCount()).toBe(0);
  });

  test('applies the local provenance gate before anything leaves this daemon', async () => {
    daemons.attach('b', remote.url);

    const outcome = await invokeOperation(
      localRegistry(),
      'message.send',
      {
        sessionId: 'daemon:b::session:session-on-b',
        message: { ...message, inputKind: 'human' },
      },
      { source: 'mcp', sessionId: 'agent-on-a' }
    );

    expect(outcome).toEqual({
      kind: 'completed',
      value: { kind: 'rejected', reason: 'MCP callers cannot claim human input provenance' },
    });
    expect(remote.mailbox.rowCount()).toBe(0);
  });

  test('rejects without persisting when the named daemon was never attached', async () => {
    const outcome = await send('daemon:nowhere::session:session-on-b');

    expect(outcome).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected', reason: expect.stringContaining('No attached daemon: nowhere') },
    });
    expect(local.rowCount()).toBe(0);
    expect(remote.mailbox.rowCount()).toBe(0);
  });

  test('rejects without persisting when the attached daemon is unreachable', async () => {
    await remote.stop();
    daemons.attach('b', remote.url);

    const outcome = await send('daemon:b::session:session-on-b');

    expect(outcome).toMatchObject({
      kind: 'completed',
      value: {
        kind: 'rejected',
        reason: expect.stringContaining('Forward to daemon:b::session:session-on-b failed'),
      },
    });
    expect(local.rowCount()).toBe(0);
    remote = await startRemoteDaemon('session-on-b');
  });

  test('leaves a local send on the local mailbox with the remote path never consulted', async () => {
    daemons.attach('b', remote.url);

    const outcome = await send('session-on-a');

    const entry = parseMailboxEntry(JSON.parse(local.rows()[0].payload));
    expect(entry?.to).toEqual({ kind: 'session', sessionId: 'session-on-a' });
    expect(outcome).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(remote.mailbox.rowCount()).toBe(0);
  });
});

describe('attaching a remote daemon', () => {
  test('lets a human attach over RPC and then forwards to it', async () => {
    const remote = await startRemoteDaemon('session-on-b');
    const local = createMailboxTestDb();
    const daemons = new RemoteDaemonRegistry();
    const registry = createOperationRegistry([
      createAttachDaemonOperation(daemons),
      createSendMessageOperation(
        local.jobQueue,
        (sessionId) => sessionId === 'session-on-a',
        createRemoteSendForwarder(daemons)
      ),
    ]);

    const attached = await invokeOperation(
      registry,
      'daemon.attach',
      { daemonId: 'b', url: remote.url },
      { source: 'rpc' }
    );
    expect(attached).toMatchObject({
      kind: 'completed',
      value: {
        kind: 'attached',
        daemonId: 'b',
        addressExample: 'daemon:b::session:<sessionId>',
      },
    });

    const sent = await invokeOperation(
      registry,
      'message.send',
      { sessionId: 'daemon:b::session:session-on-b', message },
      { source: 'mcp', sessionId: 'agent-on-a' }
    );
    expect(sent).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(remote.mailbox.rowCount()).toBe(1);

    local.close();
    await remote.stop();
  });

  test.each(['mcp', 'internal'] as const)(
    'refuses to dial out for a %s caller, leaving nothing attached',
    async (source) => {
      const remote = await startRemoteDaemon('session-on-b');
      const local = createMailboxTestDb();
      const daemons = new RemoteDaemonRegistry();
      const registry = createOperationRegistry([
        createAttachDaemonOperation(daemons),
        createSendMessageOperation(
          local.jobQueue,
          (sessionId) => sessionId === 'session-on-a',
          createRemoteSendForwarder(daemons)
        ),
      ]);

      const attached = await invokeOperation(
        registry,
        'daemon.attach',
        { daemonId: 'b', url: remote.url },
        { source, sessionId: 'agent-on-a', spaceId: 'space-a', role: 'ad_hoc_member' }
      );
      expect(attached).toMatchObject({
        kind: 'completed',
        value: { kind: 'rejected', reason: expect.stringContaining('restricted to the RPC door') },
      });

      const sent = await invokeOperation(
        registry,
        'message.send',
        { sessionId: 'daemon:b::session:session-on-b', message },
        { source: 'mcp', sessionId: 'agent-on-a' }
      );
      expect(sent).toMatchObject({
        kind: 'completed',
        value: { kind: 'rejected', reason: expect.stringContaining('No attached daemon: b') },
      });
      expect(remote.mailbox.rowCount()).toBe(0);
      expect(remote.clientCount()).toBe(0);

      local.close();
      await remote.stop();
    }
  );
});

describe('tearing down a failed connection', () => {
  test('leaves alone a connection that replaced the one the failed invoke used', async () => {
    const remote = await startRemoteDaemon('session-on-b');
    const daemons = new RemoteDaemonRegistry();
    daemons.attach('b', remote.url);
    await daemons.invoke('b', 'message.send', { sessionId: 'session-on-b', message });

    const stale = settled(daemons.invoke('b', 'no.such.operation', {}));
    daemons.attach('b', remote.url);
    const fresh = daemons.invoke('b', 'message.send', { sessionId: 'session-on-b', message });

    expect(await stale).toBeInstanceOf(Error);
    expect(await fresh).toMatchObject({ kind: 'accepted' });
    expect(remote.mailbox.rowCount()).toBe(2);

    daemons.forget('b');
    await remote.stop();
  });
});

describe('connect deadline on a forwarded send', () => {
  test('bounds a probe when the socket opens but the daemon never answers', async () => {
    const silent = await startUnresponsiveWebSocketServer();
    const daemons = new RemoteDaemonRegistry({ probeRequestTimeoutMs: 30 });
    const startedAt = performance.now();

    try {
      await expect(daemons.probe(silent.url)).rejects.toThrow('Request timeout');
      expect(performance.now() - startedAt).toBeLessThan(1000);
    } finally {
      silent.stop();
    }
  });

  test('rejects a send to a daemon that accepts the socket but never answers the upgrade', async () => {
    const silent = await startSilentServer();
    const local = createMailboxTestDb();
    const daemons = new RemoteDaemonRegistry({ connectTimeoutMs: 100 });
    daemons.attach('stuck', silent.url);
    const registry = createOperationRegistry([
      createSendMessageOperation(
        local.jobQueue,
        (sessionId) => sessionId === 'session-on-a',
        createRemoteSendForwarder(daemons)
      ),
    ]);

    const outcome = await invokeOperation(
      registry,
      'message.send',
      { sessionId: 'daemon:stuck::session:session-on-b', message },
      { source: 'mcp', sessionId: 'agent-on-a' }
    );

    expect(outcome).toMatchObject({
      kind: 'completed',
      value: {
        kind: 'rejected',
        reason: expect.stringContaining(`Timed out connecting to ${silent.url} after 100ms`),
      },
    });
    expect(local.rowCount()).toBe(0);
    local.close();
    silent.stop();
  });

  test('abandons a connect still in flight when the same daemon is attached again', async () => {
    const silent = await startSilentServer();
    const daemons = new RemoteDaemonRegistry({ connectTimeoutMs: 30000 });
    daemons.attach('stuck', silent.url);
    const inFlight = settled(daemons.invoke('stuck', 'message.send', {}));

    daemons.attach('stuck', silent.url);

    expect(await inFlight).toBeInstanceOf(Error);
    daemons.forget('stuck');
    silent.stop();
  });
});

describe('daemon-qualified session addresses', () => {
  test('reads a daemon-qualified session address and renders it back', () => {
    const address = parseRemoteAddress('daemon:b::session:session-on-b');
    expect(address).toEqual({ kind: 'remote-session', daemonId: 'b', sessionId: 'session-on-b' });
    expect(renderRemoteAddress(address!)).toBe('daemon:b::session:session-on-b');
    expect(renderRemoteAddress({ kind: 'remote-session', daemonId: 'a/b', sessionId: 'x y' })).toBe(
      'daemon:a%2Fb::session:x%20y'
    );
  });

  test.each([
    'session:plain',
    'agent:space/handle',
    'daemon:b::agent:space/handle',
    'daemon:b::session:',
    'daemon:::session:x',
    'daemon:b:session:x',
    'daemon:b',
    '',
  ])('does not read %p as a remote address', (raw) => {
    expect(parseRemoteAddress(raw)).toBeNull();
  });

  test('leaves the local address grammar untouched', () => {
    expect(parseAddress('session:plain')).toEqual({ kind: 'session', sessionId: 'plain' });
    expect(parseAddress('agent:space/handle?task=t1')).toEqual({
      kind: 'agent',
      spaceId: 'space',
      handle: 'handle',
      taskId: 't1',
    });
    expect(parseAddress('daemon:b::session:session-on-b')).toBeNull();
  });
});
