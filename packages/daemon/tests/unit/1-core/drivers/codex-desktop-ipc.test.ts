import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCodexDesktopIpc } from '../../../../src/lib/drivers/codex-desktop-ipc';
import { steerCodexDesktopTurn } from '../../../../src/lib/drivers/codex-desktop-handoff';
import { createCodexDesktopAdapter } from '../../../../src/lib/drivers/codex-desktop-adapter';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';
import { Database } from '../../../../src/storage/sqlite-compat';

const refuseOpen: SpawnFn = () => ({
  stdout: null,
  stderr: new Response('open failed').body,
  exited: Promise.resolve(1),
  exitCode: 1,
  kill: () => {},
});

interface Message {
  type: string;
  requestId: string;
  method?: string;
  sourceClientId?: string;
  targetClientId?: string;
  version?: number;
  response?: unknown;
  params?: Record<string, unknown>;
}

describe('withCodexDesktopIpc', () => {
  let directory = '';
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  async function fixture(
    handle: (message: Message, socket: Socket, send: (response: object) => void) => void,
    initialization: object = { resultType: 'success', result: { clientId: 'neo-client' } }
  ) {
    directory = mkdtempSync(join(tmpdir(), 'codex-ipc-client-'));
    const path = join(directory, 'ipc.sock');
    const seen: Message[] = [];
    let resolveClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', resolveClosed);
      let buffer = Buffer.alloc(0);
      const send = (response: object) => {
        const body = Buffer.from(JSON.stringify(response));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        socket.write(header.subarray(0, 2));
        socket.write(Buffer.concat([header.subarray(2), body]));
      };
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
          const size = buffer.readUInt32LE(0);
          const message = JSON.parse(buffer.subarray(4, 4 + size).toString()) as Message;
          buffer = buffer.subarray(4 + size);
          seen.push(message);
          if (message.method === 'initialize') {
            send({ type: 'response', requestId: message.requestId, ...initialization });
          } else {
            handle(message, socket, send);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(path, resolve));
    return { path, seen, closed };
  }

  describe('steerCodexDesktopTurn discovery fallback', () => {
    test('refuses input when reachable Desktop cannot confirm ownership', async () => {
      const f = await fixture((message, _socket, send) =>
        send({
          type: 'response',
          requestId: message.requestId,
          resultType: 'error',
          error: 'request-version-mismatch',
        })
      );
      expect(
        await steerCodexDesktopTurn(f.path, refuseOpen, 'thread-1', 'now', 'input-1')
      ).toMatchObject({
        reason: {
          ok: false,
          reason: 'not_delivered',
          detail: expect.stringContaining('request-version-mismatch'),
        },
      });
      expect(f.seen.some((message) => message.method === 'thread-follower-steer-turn')).toBe(false);
    });
  });

  test('correlates out-of-order fragmented replies and declines discovery requests', async () => {
    const pending: Message[] = [];
    let resolveDiscovery = () => {};
    const declinedDiscovery = new Promise<void>((resolve) => {
      resolveDiscovery = resolve;
    });
    const f = await fixture((message, _socket, send) => {
      if (message.type === 'client-discovery-response') resolveDiscovery();
      if (message.type !== 'request') return;
      pending.push(message);
      if (pending.length !== 2) return;
      send({ type: 'client-discovery-request', requestId: 'discovery-1' });
      send({ type: 'broadcast', method: 'client-status-changed' });
      for (const request of [...pending].reverse()) {
        send({
          type: 'response',
          requestId: request.requestId,
          resultType: 'success',
          handledByClientId: request.method,
        });
      }
    });
    const responses = await withCodexDesktopIpc(f.path, async ({ call }) => {
      const values = await Promise.all([
        call('thread-owner-discovery', { conversationId: 'thread-1' }, 1),
        call('thread-follower-interrupt-turn', { conversationId: 'thread-1' }, 4, 'owner-1'),
      ]);
      await declinedDiscovery;
      return values;
    });
    await f.closed;
    expect(responses.map((response) => response.handledByClientId)).toEqual([
      'thread-owner-discovery',
      'thread-follower-interrupt-turn',
    ]);
    expect(f.seen[0]).toMatchObject({
      type: 'request',
      method: 'initialize',
      version: 0,
      sourceClientId: 'initializing-client',
    });
    expect(f.seen[1]).toMatchObject({ sourceClientId: 'neo-client', version: 1 });
    expect(f.seen[2]).toMatchObject({
      sourceClientId: 'neo-client',
      targetClientId: 'owner-1',
      version: 4,
    });
    expect(f.seen).toContainEqual({
      type: 'client-discovery-response',
      requestId: 'discovery-1',
      response: { canHandle: false },
    });
  });

  test.each([
    { resultType: 'error', error: 'client rejected' },
    { resultType: 'success', result: {} },
  ])('rejects an invalid handshake and closes before invoking the caller: %j', async (reply) => {
    const f = await fixture(() => {}, reply);
    let invoked = false;
    await expect(
      withCodexDesktopIpc(f.path, async () => {
        invoked = true;
      })
    ).rejects.toThrow(reply.resultType === 'error' ? 'client rejected' : 'initialization failed');
    await f.closed;
    expect(invoked).toBe(false);
    expect(f.seen).toHaveLength(1);
  });

  test.each([0, 16 * 1024 * 1024 + 1])('rejects invalid frame length %i', async (size) => {
    const f = await fixture((_message, socket) => {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(size);
      socket.write(header);
    });
    await expect(
      withCodexDesktopIpc(f.path, ({ call }) => call('thread-owner-discovery', {}, 1))
    ).rejects.toThrow('Invalid Codex Desktop IPC frame');
    await f.closed;
  });

  test('rejects all outstanding requests when Desktop disconnects', async () => {
    const f = await fixture((_message, socket) => socket.destroy());
    const responses = await withCodexDesktopIpc(f.path, ({ call }) =>
      Promise.allSettled([call('first', {}, 1), call('second', {}, 1)])
    );
    expect(responses.map((response) => response.status)).toEqual(['rejected', 'rejected']);
  });

  test('closes the connection when the caller fails', async () => {
    const f = await fixture(() => {});
    await expect(
      withCodexDesktopIpc(f.path, async () => {
        throw new Error('operation failed');
      })
    ).rejects.toThrow('operation failed');
    await f.closed;
  });

  test('reports an unavailable socket without invoking the caller', async () => {
    directory = mkdtempSync(join(tmpdir(), 'codex-ipc-absent-'));
    let invoked = false;
    await expect(
      withCodexDesktopIpc(join(directory, 'missing.sock'), async () => {
        invoked = true;
      })
    ).rejects.toThrow();
    expect(invoked).toBe(false);
  });

  async function driverFor(path: string, open: () => number) {
    const statePath = join(directory, 'worker.sqlite');
    const db = new Database(statePath);
    db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
      CREATE TABLE projects (id TEXT, name TEXT);
      CREATE TABLE project_roots (project_id TEXT, path TEXT);
      INSERT INTO threads VALUES ('thread-1', 'Worker', '', '', '/tmp/verify', 'desktop', 0, 1, '/missing.jsonl')`);
    db.close();
    const shared: string[] = [];
    const launched: string[][] = [];
    const driver = createCodexDesktopAdapter({
      statePath,
      desktopSocketPath: path,
      worktreesDir: directory,
      machine: 'test',
      now: Date.now,
      spawn: (args) => {
        launched.push(args);
        const code = open();
        return {
          stdout: null,
          stderr: new Response(code ? 'open failed' : '').body,
          exited: Promise.resolve(code),
          exitCode: code,
          kill: () => {},
        };
      },
      appServer: async () => {
        shared.push('connect');
        throw new Error('second writer forbidden');
      },
      bootstrapServer: async () => {
        throw new Error('must not create another thread');
      },
      prepareDesktopProject: async () => {
        throw new Error('must not register a project');
      },
      startDesktopTurn: async () => {
        throw new Error('must use the existing owner');
      },
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: directory,
      gitCheckout: async () => null,
      newId: () => 'input-1',
    });
    return { driver, shared, launched };
  }

  test.each([false, true])(
    'opens an unowned saved worker in Desktop before its next turn, idle=%s',
    async (idle) => {
      let opened = false;
      const f = await fixture((message, _socket, send) => {
        const discovery = message.method === 'thread-owner-discovery';
        send({
          type: 'response',
          requestId: message.requestId,
          ...(discovery
            ? opened
              ? { resultType: 'success', handledByClientId: 'desktop-owner' }
              : { resultType: 'error', error: 'no-client-found' }
            : message.method === 'thread-follower-steer-turn' && idle
              ? { resultType: 'error', error: 'NoActiveTurn' }
              : {
                  resultType: 'success',
                  result: {
                    result: idle
                      ? { turn: { id: 'new-desktop-turn' } }
                      : { turnId: 'desktop-active' },
                  },
                }),
        });
      });
      const w = await driverFor(f.path, () => {
        opened = true;
        return 0;
      });
      expect(
        await w.driver.send!({ adapter: 'codex-desktop', id: 'thread-1' }, 'next task', {
          from: 'user',
          caller: { source: 'rpc' },
        })
      ).toMatchObject({
        ok: true,
        value: idle
          ? { startedTurnId: 'new-desktop-turn' }
          : { steeredIntoTurnId: 'desktop-active' },
      });
      expect(w.shared).toEqual([]);
      expect(w.launched).toEqual([['open', '-g', 'codex://threads/thread-1']]);
      expect(f.seen.at(-1)?.targetClientId).toBe('desktop-owner');
    }
  );

  test.each([
    { resultType: 'error', error: 'client rejected' },
    { resultType: 'success', result: {} },
  ])('never starts a shared writer after Desktop handshake refusal: %j', async (reply) => {
    const f = await fixture(() => {}, reply);
    const w = await driverFor(f.path, () => 0);
    expect(
      await w.driver.send!({ adapter: 'codex-desktop', id: 'thread-1' }, 'next task', {
        from: 'user',
        caller: { source: 'rpc' },
      })
    ).toMatchObject({ ok: false, reason: 'not_delivered' });
    expect(w.shared).toEqual([]);
    expect(w.launched).toEqual([]);
  });

  test('never resumes through shared server when reachable Desktop disconnects before discovery', async () => {
    const f = await fixture((_message, socket) => socket.destroy());
    const w = await driverFor(f.path, () => 0);
    expect(
      await w.driver.send!({ adapter: 'codex-desktop', id: 'thread-1' }, 'next task', {
        from: 'user',
        caller: { source: 'rpc' },
      })
    ).toMatchObject({ ok: false, reason: 'not_delivered' });
    expect(w.shared).toEqual([]);
  });

  describe('Desktop-owned message delivery', () => {
    test('steers through the Desktop owner with restorable agent input', async () => {
      const f = await fixture((message, _socket, send) =>
        send({
          type: 'response',
          requestId: message.requestId,
          resultType: 'success',
          ...(message.method === 'thread-owner-discovery'
            ? { handledByClientId: 'desktop-owner' }
            : { result: { result: { turnId: 'desktop-turn' } } }),
        })
      );
      const text = 'use the parser\n[HyperNeo agent input]';
      expect(await steerCodexDesktopTurn(f.path, refuseOpen, 'thread-1', text, 'input-1')).toEqual({
        reason: { ok: true, value: { delivered: true, steeredIntoTurnId: 'desktop-turn' } },
      });
      expect(f.seen.at(-1)).toMatchObject({
        method: 'thread-follower-steer-turn',
        version: 1,
        targetClientId: 'desktop-owner',
        params: {
          conversationId: 'thread-1',
          clientUserMessageId: 'input-1',
          input: [{ type: 'text', text, text_elements: [] }],
          restoreMessage: {
            id: 'input-1',
            text,
            context: { workspaceRoots: [], commentAttachments: [] },
            responsesapiClientMetadata: {},
          },
        },
      });
    });

    test('work.send returns the Desktop steer receipt through the operation result schema', async () => {
      const f = await fixture((message, _socket, send) =>
        send({
          type: 'response',
          requestId: message.requestId,
          resultType: 'success',
          ...(message.method === 'thread-owner-discovery'
            ? { handledByClientId: 'desktop-owner' }
            : { result: { result: { turnId: 'desktop-turn' } } }),
        })
      );
      const statePath = join(directory, 'state.sqlite');
      const db = new Database(statePath);
      db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
      CREATE TABLE projects (id TEXT, name TEXT);
      CREATE TABLE project_roots (project_id TEXT, path TEXT);
      INSERT INTO threads VALUES ('thread-1', 'Verification', '', '', '/tmp/verify', 'desktop', 0, 1, '/missing.jsonl')`);
      db.close();
      const driver = createCodexDesktopAdapter({
        statePath,
        desktopSocketPath: f.path,
        worktreesDir: directory,
        machine: 'test',
        now: Date.now,
        spawn: () => {
          throw new Error('Desktop steering must not spawn');
        },
        appServer: async () => {
          throw new Error('Desktop owns the turn; app-server must not be consulted');
        },
        bootstrapServer: async () => {
          throw new Error('Must not resume the thread');
        },
        prepareDesktopProject: async () => {
          throw new Error('Must not register a project while steering');
        },
        startDesktopTurn: async () => {
          throw new Error('Must not start a new turn');
        },
        folderExists: () => true,
        makeFolder: () => {},
        homeDir: directory,
        gitCheckout: async () => null,
        newId: () => 'input-1',
      });
      const registry = createOperationRegistry(
        createWorkVerbOperations({
          adapters: () => [driver],
          daemonName: 'test',
          remote: { list: () => [], invoke: async () => ({}) },
        })
      );
      expect(
        await invokeOperation(
          registry,
          'work.send',
          { ref: { adapter: driver.id, id: 'thread-1' }, message: 'use the parser' },
          { source: 'mcp', role: 'neo', sessionId: 'neo' }
        )
      ).toEqual({
        kind: 'completed',
        value: { ok: true, value: { delivered: true, steeredIntoTurnId: 'desktop-turn' } },
      });
      expect(f.seen.at(-1)?.params?.restoreMessage).toMatchObject({
        text: 'use the parser\n\nReport progress, questions or blockers to Neo at any time, mid-work, with: hyperneo send neo "<text>" (not SendMessage). Keep working after you send.\n[HyperNeo agent input]',
      });
    });

    test.each([false, true])(
      'starts idle Desktop input or reports its refusal: %s',
      async (refused) => {
        const f = await fixture((message, _socket, send) =>
          send({
            type: 'response',
            requestId: message.requestId,
            ...(message.method === 'thread-owner-discovery'
              ? { resultType: 'success', handledByClientId: 'desktop-owner' }
              : message.method === 'thread-follower-start-turn' && !refused
                ? { resultType: 'success', result: { result: { turn: { id: 'new-turn' } } } }
                : {
                    resultType: 'error',
                    error:
                      message.method === 'thread-follower-start-turn'
                        ? 'start unavailable'
                        : 'NoActiveTurn',
                  }),
          })
        );
        const result = await steerCodexDesktopTurn(
          f.path,
          refuseOpen,
          'thread-1',
          'later',
          'input-1'
        );
        expect(result).toMatchObject({
          reason: refused
            ? {
                ok: false,
                reason: 'not_delivered',
                detail: expect.stringContaining('start unavailable'),
              }
            : { ok: true, value: { delivered: true, startedTurnId: 'new-turn' } },
        });
        expect(f.seen.at(-1)).toMatchObject({
          method: 'thread-follower-start-turn',
          version: 2,
          targetClientId: 'desktop-owner',
          params: {
            conversationId: 'thread-1',
            turnStart: {
              request: {
                threadId: 'thread-1',
                input: [{ type: 'text', text: 'later', text_elements: [] }],
              },
              context: { inheritThreadSettings: true },
            },
          },
        });
      }
    );

    test('does not start a second writer when Desktop has no owner', async () => {
      const f = await fixture((message, _socket, send) =>
        send({
          type: 'response',
          requestId: message.requestId,
          resultType: 'error',
          error: 'no-client-found',
        })
      );
      expect(
        await steerCodexDesktopTurn(f.path, refuseOpen, 'thread-1', 'hi', 'input-1')
      ).toMatchObject({
        reason: {
          ok: false,
          reason: 'not_delivered',
          detail: expect.stringContaining('open failed'),
        },
      });
      expect(f.seen.map((message) => message.method)).toEqual([
        'initialize',
        'thread-owner-discovery',
      ]);
    });

    test.each(['disconnect', 'missing-turn-id', 'unknown-error'])(
      'never queues a possibly accepted Desktop steer: %s',
      async (failure) => {
        const f = await fixture((message, socket, send) => {
          if (message.method === 'thread-owner-discovery')
            send({
              type: 'response',
              requestId: message.requestId,
              resultType: 'success',
              handledByClientId: 'desktop-owner',
            });
          else if (failure === 'disconnect') socket.destroy();
          else
            send({
              type: 'response',
              requestId: message.requestId,
              resultType: failure === 'unknown-error' ? 'error' : 'success',
              error: failure === 'unknown-error' ? 'request outcome unknown' : undefined,
              result: {},
            });
        });
        expect(
          await steerCodexDesktopTurn(f.path, refuseOpen, 'thread-1', 'hi', 'input-1')
        ).toMatchObject({
          reason: { ok: false, reason: 'not_delivered' },
        });
      }
    );
  });
});
