import {
  configureLogger,
  getLoggerConfig,
  LogLevel,
  subscribeToStructuredLogs,
} from '../../../../src/lib/logger.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  connectCodexAppServer,
  startCodexBootstrapServer,
} from '../../../../src/lib/drivers/codex-app-server';

describe('connectCodexAppServer', () => {
  let dir: string;
  let server: Server;
  let sockets: WebSocketServer;

  afterEach(async () => {
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  async function listen(): Promise<{
    path: string;
    seen: Array<{ method: string; params: unknown }>;
  }> {
    dir = mkdtempSync(join(tmpdir(), 'codex-app-server-'));
    const path = join(dir, 'control.sock');
    const seen: Array<{ method: string; params: unknown }> = [];
    server = createServer();
    sockets = new WebSocketServer({ server });
    sockets.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data));
        seen.push({ method: message.method, params: message.params });
        if (message.id === undefined) return;
        socket.send(
          JSON.stringify(
            message.method === 'thread/start'
              ? { id: message.id, result: { thread: { id: 'th1' } } }
              : message.method === 'initialize'
                ? { id: message.id, result: {} }
                : { id: message.id, error: { message: 'no such method' } }
          )
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return { path, seen };
  }

  test('initializes, answers calls and turns JSON-RPC errors into throws', async () => {
    const { path, seen } = await listen();
    const client = await connectCodexAppServer(path);
    try {
      expect(await client.call('thread/start', { cwd: '/focus' })).toEqual({
        thread: { id: 'th1' },
      });
      await expect(client.call('thread/fly', {})).rejects.toThrow('thread/fly');
      expect(seen.map((message) => message.method)).toEqual([
        'initialize',
        'initialized',
        'thread/start',
        'thread/fly',
      ]);
      expect(seen[0].params).toEqual({
        clientInfo: { name: 'hyperneo', title: 'HyperNeo', version: '1' },
        capabilities: { experimentalApi: true },
      });
    } finally {
      client.close();
    }
  });

  test.each([false, true])(
    'unsubscribes only its own turn at completion, including early notification: %s',
    async (early) => {
      const { path, seen } = await listen();
      let complete = () => {};
      sockets.removeAllListeners('connection');
      sockets.on('connection', (socket) => {
        complete = () =>
          socket.send(
            JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'owned-thread', turn: { id: 'owned-turn', status: 'completed' } },
            })
          );
        socket.on('message', (data) => {
          const message = JSON.parse(String(data));
          seen.push({ method: message.method, params: message.params });
          if (message.id === undefined) return;
          if (message.method === 'turn/start' && early) complete();
          socket.send(
            JSON.stringify({
              id: message.id,
              result: message.method === 'turn/start' ? { turn: { id: 'owned-turn' } } : {},
            })
          );
        });
      });
      const client = await connectCodexAppServer(path);
      try {
        await client.call('turn/start', { threadId: 'owned-thread', input: [] });
        if (!early) {
          await client.close();
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(seen.some((m) => m.method === 'thread/unsubscribe')).toBe(false);
          for (const peer of sockets.clients)
            peer.send(
              JSON.stringify({
                method: 'turn/completed',
                params: { threadId: 'other-thread', turn: { id: 'owned-turn' } },
              })
            );
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(seen.some((m) => m.method === 'thread/unsubscribe')).toBe(false);
          complete();
        }
        const deadline = Date.now() + 1000;
        while (!seen.some((m) => m.method === 'thread/unsubscribe') && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(seen.filter((m) => m.method === 'thread/unsubscribe')).toEqual([
          { method: 'thread/unsubscribe', params: { threadId: 'owned-thread' } },
        ]);
      } finally {
        await client.close();
      }
    }
  );

  test.each([false, true])(
    'bounds deferred close retention when completion is missing or mismatched: %s',
    async (mismatched) => {
      const { path, seen } = await listen();
      sockets.removeAllListeners('connection');
      sockets.on('connection', (socket) => {
        socket.on('message', (data) => {
          const message = JSON.parse(String(data));
          seen.push({ method: message.method, params: message.params });
          if (message.id === undefined) return;
          socket.send(
            JSON.stringify({
              id: message.id,
              result: message.method === 'turn/start' ? { turn: { id: 'owned-turn' } } : {},
            })
          );
          if (message.method === 'turn/start' && mismatched)
            socket.send(
              JSON.stringify({
                method: 'turn/completed',
                params: { threadId: 'owned-thread', turn: { id: 'different-turn' } },
              })
            );
        });
      });
      const client = await connectCodexAppServer(path, 25);
      try {
        await client.call('turn/start', { threadId: 'owned-thread', input: [] });
        client.close();
        const deadline = Date.now() + 500;
        while (sockets.clients.size && Date.now() < deadline)
          await new Promise((done) => setTimeout(done, 5));
        expect(seen.filter((m) => m.method === 'thread/unsubscribe')).toEqual([
          { method: 'thread/unsubscribe', params: { threadId: 'owned-thread' } },
        ]);
        expect(sockets.clients.size).toBe(0);
        expect(seen.some((m) => m.method === 'turn/interrupt')).toBe(false);
      } finally {
        for (const peer of sockets.clients) peer.terminate();
        client.close();
      }
    }
  );

  test('logs unrecognized completion shape without its contents', async () => {
    const { path } = await listen();
    const config = getLoggerConfig();
    configureLogger({ level: LogLevel.WARN, filter: ['*'], excludeFilter: [] });
    const logs: string[] = [];
    const off = subscribeToStructuredLogs((event) => {
      if (event.message.startsWith('work.send app-server completion unrecognized'))
        logs.push(event.message);
    });
    const client = await connectCodexAppServer(path);
    try {
      for (const peer of sockets.clients)
        peer.send(
          JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'synthetic-thread', turn: {}, privateMarker: 'MUST_NOT_BE_LOGGED' },
          })
        );
      for (let n = 0; n < 50 && !logs.length; n++)
        await new Promise((done) => setTimeout(done, 10));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('"hasThreadId":true');
      expect(logs[0]).toContain('"hasTurnId":false');
      expect(logs[0]).not.toContain('MUST_NOT_BE_LOGGED');
    } finally {
      client.close();
      off();
      configureLogger(config);
    }
  });

  test('fails to connect when nothing listens on the socket', async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-app-server-'));
    server = createServer();
    sockets = new WebSocketServer({ noServer: true });
    server.listen(join(dir, 'other.sock'));
    await expect(connectCodexAppServer(join(dir, 'missing.sock'))).rejects.toThrow();
  });

  test('exposes configuration selection without creating a thread on catalog failure', async () => {
    const { path, seen } = await listen();
    const client = await connectCodexAppServer(path);
    try {
      expect(await client.selectConfiguration?.({ model: 'sol 6.1' })).toMatchObject({
        ok: false,
        reason: 'unreachable',
      });
      expect(seen.map((message) => message.method)).toEqual([
        'initialize',
        'initialized',
        'model/list',
      ]);
    } finally {
      client.close();
    }
  });
});

describe('startCodexBootstrapServer', () => {
  let directory = '';
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  function executable(failInitialization = false) {
    directory = mkdtempSync(join(tmpdir(), 'codex-bootstrap-'));
    const command = join(directory, 'codex');
    const persisted = join(directory, 'saved.json');
    writeFileSync(
      command,
      `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const seen = [];
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  seen.push({ method: message.method, params: message.params });
  if (message.id === undefined) return;
  const response = ${failInitialization} && message.method === 'initialize'
    ? { error: { code: -1, message: 'initialization failed' } }
    : { result: message.method === 'thread/start' ? { thread: { id: 'saved-thread' } } : {} };
  process.stdout.write(JSON.stringify({ id: message.id, ...response }) + '\\n');
});
lines.on('close', () => {
  fs.writeFileSync(${JSON.stringify(persisted)}, JSON.stringify(seen));
});
`,
      { mode: 0o700 }
    );
    return { command, persisted };
  }

  test('flushes the saved thread through EOF and waits for process exit before resolving close', async () => {
    const f = executable();
    const client = await startCodexBootstrapServer(f.command);
    try {
      expect(await client.call('thread/start', { cwd: '/focus' })).toEqual({
        thread: { id: 'saved-thread' },
      });
      await client.call('thread/name/set', { threadId: 'saved-thread', name: 'Desktop chat' });
      expect(existsSync(f.persisted)).toBe(false);
      await Promise.all([client.close(), client.close()]);
      const seen = JSON.parse(readFileSync(f.persisted, 'utf8'));
      expect(seen.map((message: { method: string }) => message.method)).toEqual([
        'initialize',
        'initialized',
        'thread/start',
        'thread/name/set',
      ]);
      expect(seen[0].params).toEqual({
        clientInfo: { name: 'hyperneo', title: 'HyperNeo', version: '1' },
        capabilities: { experimentalApi: true },
      });
      await expect(client.call('turn/start', {})).rejects.toThrow('closed');
    } finally {
      await client.close();
    }
  });

  test('closes its owned process after failed initialization', async () => {
    const f = executable(true);
    await expect(startCodexBootstrapServer(f.command)).rejects.toThrow('initialization failed');
    expect(
      JSON.parse(readFileSync(f.persisted, 'utf8')).map(
        (message: { method: string }) => message.method
      )
    ).toEqual(['initialize']);
  });
});
