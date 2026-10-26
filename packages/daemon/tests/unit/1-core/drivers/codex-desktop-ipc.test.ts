import {
  subscribeToStructuredLogs,
  configureLogger,
  getLoggerConfig,
  LogLevel,
} from '../../../../src/lib/logger.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCodexDesktopIpc } from '../../../../src/lib/drivers/codex-desktop-ipc';
import { steerCodexDesktopTurn } from '../../../../src/lib/drivers/codex-desktop-handoff';
import { createCodexDesktopAdapter } from '../../../../src/lib/drivers/codex-desktop-adapter';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { Database } from '../../../../src/storage/sqlite-compat';

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
  const noDesktopOpen: import('../../../../src/lib/runtime-spawn').SpawnFn = (args) => {
    if (args[0] === 'ps')
      return {
        stdout: new Response('/Applications/Codex.app/Contents/MacOS/Codex\n').body,
        stderr: null,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    throw new Error('Synthetic Desktop open refused');
  };
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

  describe('steerCodexDesktopTurn Desktop admission', () => {
    test('a slow Desktop owner past the old handoff deadline still receives the send', async () => {
      const ownerAt = Date.now() + 9_000;
      const f = await fixture((message, _socket, send) => {
        if (message.method === 'thread-owner-discovery') {
          if (Date.now() < ownerAt)
            return send({
              type: 'response',
              requestId: message.requestId,
              resultType: 'error',
              error: 'no-client-found',
            });
          return send({
            type: 'response',
            requestId: message.requestId,
            resultType: 'success',
            handledByClientId: 'slow-owner',
          });
        }
        if (message.method === 'thread-follower-steer-turn')
          return send({
            type: 'response',
            requestId: message.requestId,
            resultType: 'success',
            result: { result: { turnId: 'turn-1' } },
          });
        send({ type: 'response', requestId: message.requestId, resultType: 'success' });
      });
      const result = await steerCodexDesktopTurn(
        f.path,
        (args) => {
          if (args[0] !== 'open') throw new Error(`Unexpected spawn ${args[0]}`);
          return {
            stdout: null,
            stderr: new Response('').body,
            exited: Promise.resolve(0),
            exitCode: 0,
            kill: () => {},
          };
        },
        'thread-1',
        'now',
        'input-1',
        'auto',
        async () => true
      );
      expect(result).toMatchObject({
        reason: { ok: true, value: { delivered: true, steeredIntoTurnId: 'turn-1' } },
      });
      const methods = f.seen.map((message) => message.method);
      expect(methods).toContain('thread-follower-steer-turn');
    }, 30_000);

    test.each([
      ['/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', true],
      ['/Users/test/Applications/Codex.app/Contents/MacOS/Codex', true],
      ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', false],
      ['/usr/bin/sleep', false],
    ])(
      'detects the Desktop executable rather than its background CLI: %s',
      async (path, running) => {
        const probes: string[][] = [];
        const result = await steerCodexDesktopTurn(
          undefined,
          (args) => {
            probes.push(args);
            return {
              stdout: new Response(`${path}\n`).body,
              stderr: null,
              exited: Promise.resolve(0),
              exitCode: 0,
              kill: () => {},
            };
          },
          'thread-1',
          'marker',
          'input-1'
        );
        expect(probes).toEqual([['ps', '-axo', 'comm=']]);
        expect(result).toMatchObject(
          running ? { reason: { ok: false, reason: 'not_delivered' } } : { value: 'app-server' }
        );
      }
    );

    test.each(['linux', 'win32', 'darwin'] as const)(
      'probe launch failure respects the host contract: %s',
      async (platform) => {
        const result = await steerCodexDesktopTurn(
          undefined,
          () => {
            throw new Error('Synthetic ps missing');
          },
          'thread-1',
          'marker',
          'input-1',
          'auto',
          undefined,
          platform
        );
        expect(result).toMatchObject(
          platform === 'darwin'
            ? { reason: { ok: false, reason: 'not_delivered' } }
            : { value: 'app-server' }
        );
      }
    );

    test('opens while negative owner discovery is pending and waits for asynchronous ownership', async () => {
      let opened = false;
      let readyAt = Infinity;
      const f = await fixture((message, _socket, send) => {
        if (message.method === 'thread-owner-discovery' && Date.now() < readyAt) return;
        send({
          type: 'response',
          requestId: message.requestId,
          resultType: 'success',
          handledByClientId: 'desktop-owner',
          result: { result: { turnId: 'desktop-turn' } },
        });
      });
      const started = performance.now();
      const result = await steerCodexDesktopTurn(
        f.path,
        () => {
          opened = true;
          readyAt = Date.now() + 400;
          return {
            stdout: null,
            stderr: null,
            exited: Promise.resolve(0),
            exitCode: 0,
            kill: () => {},
          };
        },
        'thread-1',
        'marker',
        'input-1',
        'auto',
        async () => true
      );
      expect(result).toMatchObject({
        reason: { ok: true, value: { delivered: true, steeredIntoTurnId: 'desktop-turn' } },
      });
      expect(opened).toBe(true);
      expect(performance.now() - started).toBeLessThan(3_000);
    }, 10_000);

    test('refuses at the handoff deadline when Desktop never acquires the thread', async () => {
      const started = performance.now();
      const f = await fixture((message, _socket, send) =>
        send({
          type: 'response',
          requestId: message.requestId,
          resultType: 'error',
          error: 'no-client-found',
        })
      );
      const result = await steerCodexDesktopTurn(
        f.path,
        () => ({
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        }),
        'thread-1',
        'marker',
        'input-1',
        'auto',
        async () => true
      );
      expect(result).toMatchObject({
        reason: {
          ok: false,
          reason: 'not_delivered',
          detail: expect.stringContaining('No background writer was started'),
        },
      });
      expect(f.seen.some((message) => message.method === 'thread-follower-steer-turn')).toBe(false);
      expect(performance.now() - started).toBeLessThan(31_000);
    }, 35_000);

    test('kills a stalled launcher and closes IPC at the existing-turn deadline', async () => {
      const f = await fixture((message, _socket, send) =>
        send({
          type: 'response',
          requestId: message.requestId,
          resultType: 'error',
          error: 'no-client-found',
        })
      );
      let killed = false;
      const started = performance.now();
      const result = await steerCodexDesktopTurn(
        f.path,
        () => ({
          stdout: null,
          stderr: null,
          exited: new Promise<number>(() => {}),
          exitCode: null,
          kill: () => {
            killed = true;
          },
        }),
        'thread-1',
        'marker',
        'input-1',
        'auto',
        async () => true
      );
      await f.closed;
      expect(result).toMatchObject({ reason: { ok: false, reason: 'not_delivered' } });
      expect(killed).toBe(true);
      expect(performance.now() - started).toBeLessThan(31_000);
      expect(f.seen.some((message) => message.method?.startsWith('thread-follower-'))).toBe(false);
    }, 35_000);

    test('opens an unloaded thread and waits for its Desktop owner before delivering', async () => {
      let opened = false;
      const f = await fixture((message, _socket, send) =>
        send({
          type: 'response',
          requestId: message.requestId,
          ...(message.method === 'thread-owner-discovery'
            ? opened
              ? { resultType: 'success', handledByClientId: 'desktop-owner' }
              : { resultType: 'error', error: 'no-client-found' }
            : { resultType: 'success', result: { result: { turnId: 'desktop-turn' } } }),
        })
      );
      const launched: string[][] = [];
      const result = await steerCodexDesktopTurn(
        f.path,
        (args) => {
          if (args[0] === 'ps')
            return {
              stdout: new Response('/Applications/Codex.app/Contents/MacOS/Codex\n').body,
              stderr: null,
              exited: Promise.resolve(0),
              exitCode: 0,
              kill: () => {},
            };
          launched.push(args);
          return {
            stdout: null,
            stderr: null,
            exitCode: null,
            exited: new Promise<number>((resolve) =>
              setTimeout(() => {
                opened = true;
                resolve(0);
              }, 20)
            ),
            kill: () => {},
          };
        },
        'thread-1',
        'ownership marker',
        'input-1'
      );
      expect(result).toEqual({
        reason: { ok: true, value: { delivered: true, steeredIntoTurnId: 'desktop-turn' } },
      });
      expect(launched).toEqual([['open', '-g', 'codex://threads/thread-1']]);
      expect(f.seen.at(-1)).toMatchObject({
        method: 'thread-follower-steer-turn',
        targetClientId: 'desktop-owner',
      });
    });

    test('refuses instead of creating a background writer if running Desktop cannot be reached', async () => {
      directory = mkdtempSync(join(tmpdir(), 'codex-running-no-ipc-'));
      expect(
        await steerCodexDesktopTurn(
          join(directory, 'missing.sock'),
          noDesktopOpen,
          'thread-1',
          'ownership marker',
          'input-1',
          'auto',
          async () => true
        )
      ).toMatchObject({ reason: { ok: false, reason: 'not_delivered' } });
    });
  });

  describe('steerCodexDesktopTurn discovery fallback', () => {
    test('refuses when running Desktop discovery rejects the protocol before dispatch', async () => {
      const f = await fixture((message, _socket, send) =>
        send({
          type: 'response',
          requestId: message.requestId,
          resultType: 'error',
          error: 'request-version-mismatch',
        })
      );
      expect(
        await steerCodexDesktopTurn(f.path, noDesktopOpen, 'thread-1', 'now', 'input-1')
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

  describe('existing-thread work.send without a Desktop owner', () => {
    test.each(
      (['active', 'completed'] as const).flatMap((state) =>
        (['refused', 'hung'] as const).flatMap((launcher) =>
          (['missing', 'stale'] as const).map(
            (connection) => [state, launcher, connection] as const
          )
        )
      )
    )(
      'queues %s input even if Desktop open would be %s and socket is %s',
      async (state, launcher, connection) => {
        const f = await fixture((message, _socket, send) =>
          send({
            type: 'response',
            requestId: message.requestId,
            resultType: 'error',
            error: 'no-client-found',
          })
        );
        let desktopSocketPath = f.path;
        if (connection === 'missing') desktopSocketPath = join(directory, 'missing.sock');
        if (connection === 'stale') {
          desktopSocketPath = join(directory, 'stale.sock');
          renameSync(f.path, desktopSocketPath);
          await new Promise<void>((resolve) => server!.close(() => resolve()));
          server = undefined;
        }
        const statePath = join(directory, 'state.sqlite');
        const rollout = join(directory, 'rollout.jsonl');
        writeFileSync(
          rollout,
          JSON.stringify({
            type: 'event_msg',
            payload: { type: state === 'active' ? 'task_started' : 'task_complete' },
          }) + '\n'
        );
        const db = new Database(statePath);
        db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
        CREATE TABLE projects (id TEXT, name TEXT);
        CREATE TABLE project_roots (project_id TEXT, path TEXT);`);
        db.prepare(
          `INSERT INTO threads VALUES ('thread-1', 'Existing worker', '', '', '/tmp/verify', 'desktop', 0, 1, ?)`
        ).run(rollout);
        db.close();
        const calls: string[] = [];
        const launches: string[][] = [];
        let releaseOpen!: (code: number) => void;
        const openExit = new Promise<number>((resolve) => {
          releaseOpen = resolve;
        });
        const driver = createCodexDesktopAdapter({
          statePath,
          desktopSocketPath,
          desktopRunning: async () => false,
          worktreesDir: directory,
          machine: 'test',
          now: Date.now,
          spawn: (args) => {
            launches.push(args);
            if (launcher === 'refused') throw new Error('Synthetic Desktop open refused');
            return {
              stdout: null,
              stderr: null,
              exitCode: null,
              exited: openExit,
              kill: () => releaseOpen(1),
            };
          },
          appServer: async () => ({
            call: async (method, params) => {
              calls.push(method);
              if (method === 'thread/loaded/list') return { data: ['thread-1'], nextCursor: null };
              if (method === 'thread/queue/add') {
                const text = (params.input as { text: string }[])[0].text;
                appendFileSync(
                  rollout,
                  JSON.stringify({
                    type: 'response_item',
                    timestamp: new Date().toISOString(),
                    payload: {
                      type: 'message',
                      role: 'user',
                      id: params.clientUserMessageId,
                      content: [{ type: 'input_text', text }],
                    },
                  }) + '\n'
                );
                return { queuedSubmission: { id: 'existing-queue' } };
              }
              throw new Error(`Unexpected peer request ${method}`);
            },
            close: () => {},
          }),
          bootstrapServer: async () => {
            throw new Error('Existing work must not bootstrap');
          },
          prepareDesktopProject: async () => {
            throw new Error('Existing work must not create a project');
          },
          startDesktopTurn: async () => {
            throw new Error('Existing work must not use new-thread handoff');
          },
          folderExists: () => true,
          makeFolder: () => {},
          homeDir: directory,
          gitCheckout: async () => null,
          newId: () => 'existing-input',
        });
        const registry = createOperationRegistry(
          createWorkVerbOperations({
            adapters: () => [driver],
            daemonName: 'test',
            isOpenTodo: (todoId) => todoId === 'open-todo',
            remote: { list: () => [], invoke: async () => ({}) },
          })
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            invokeOperation(
              registry,
              'work.send',
              {
                ref: { adapter: driver.id, id: 'thread-1' },
                message: 'Existing worker input',
                todoId: 'open-todo',
              },
              { source: 'mcp', role: 'neo', sessionId: 'neo' }
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Existing-thread delivery waited for Desktop open')),
                2000
              );
            }),
          ]);
          expect(result).toMatchObject({
            kind: 'completed',
            value: {
              ok: true,
              value: {
                delivered: true,
                queuedSubmissionId: 'existing-queue',
                receipt: { executionId: 'thread-1', inputId: 'existing-input' },
              },
            },
          });
          expect(calls).toEqual(['thread/loaded/list', 'thread/queue/add']);
          expect(f.seen).toEqual([]);
          expect(launches).toEqual([]);
        } finally {
          clearTimeout(timer);
          releaseOpen(1);
        }
      }
    );
  });

  describe('existing-thread work.send through the Desktop owner', () => {
    test.each(['steer', 'start'] as const)(
      'delivers by follower %s to the owner client and never touches the app-server',
      async (delivery) => {
        const f = await fixture((message, _socket, send) => {
          if (message.method === 'thread-owner-discovery')
            return send({
              type: 'response',
              requestId: message.requestId,
              resultType: 'success',
              handledByClientId: 'desktop-owner',
            });
          if (message.method === 'thread-follower-steer-turn') {
            if (delivery === 'start')
              return send({
                type: 'response',
                requestId: message.requestId,
                resultType: 'error',
                error: 'active turn already ended',
              });
            return send({
              type: 'response',
              requestId: message.requestId,
              resultType: 'success',
              result: { result: { turnId: 'turn-1' } },
            });
          }
          if (message.method === 'thread-follower-start-turn')
            return send({
              type: 'response',
              requestId: message.requestId,
              resultType: 'success',
              result: { result: { turn: { id: 'turn-2' } } },
            });
          send({ type: 'response', requestId: message.requestId, resultType: 'success' });
        });
        const statePath = join(directory, 'owner-state.sqlite');
        const db = new Database(statePath);
        db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
        CREATE TABLE projects (id TEXT, name TEXT);
        CREATE TABLE project_roots (project_id TEXT, path TEXT);`);
        db.prepare(
          `INSERT INTO threads VALUES ('thread-1', 'Held worker', '', '', '/tmp/verify', 'desktop', 0, 1, ?)`
        ).run(join(directory, 'owner-rollout.jsonl'));
        db.close();
        const driver = createCodexDesktopAdapter({
          statePath,
          desktopSocketPath: f.path,
          desktopRunning: async () => true,
          worktreesDir: directory,
          machine: 'test',
          now: Date.now,
          spawn: () => {
            throw new Error('Owner delivery must not spawn processes');
          },
          appServer: async () => {
            throw new Error('Owner delivery must not contact the app-server');
          },
          bootstrapServer: async () => {
            throw new Error('Held work must not bootstrap');
          },
          prepareDesktopProject: async () => {
            throw new Error('Held work must not create a project');
          },
          startDesktopTurn: async () => {
            throw new Error('Held work must not use new-thread handoff');
          },
          folderExists: () => true,
          makeFolder: () => {},
          homeDir: directory,
          gitCheckout: async () => null,
          newId: () => 'owner-input',
        });
        const registry = createOperationRegistry(
          createWorkVerbOperations({
            adapters: () => [driver],
            daemonName: 'test',
            isOpenTodo: () => true,
            remote: { list: () => [], invoke: async () => ({}) },
          })
        );
        const result = await invokeOperation(
          registry,
          'work.send',
          {
            ref: { adapter: driver.id, id: 'thread-1' },
            message: 'Held worker input',
            todoId: 'open-todo',
          },
          { source: 'mcp', role: 'neo', sessionId: 'neo' }
        );
        expect(result).toMatchObject({
          kind: 'completed',
          value: {
            ok: true,
            value: {
              delivered: true,
              ...(delivery === 'steer'
                ? { steeredIntoTurnId: 'turn-1' }
                : { startedTurnId: 'turn-2' }),
            },
          },
        });
        const methods = f.seen.map((message) => message.method);
        expect(methods).toContain('thread-owner-discovery');
        expect(methods).toContain(
          delivery === 'steer' ? 'thread-follower-steer-turn' : 'thread-follower-start-turn'
        );
      }
    );

    test.each([true, false])(
      'explicit queue refuses only on confirmed Desktop ownership (owned: %s)',
      async (owned) => {
        const f = await fixture((message, _socket, send) => {
          if (message.method === 'thread-owner-discovery')
            return send(
              owned
                ? {
                    type: 'response',
                    requestId: message.requestId,
                    resultType: 'success',
                    handledByClientId: 'desktop-owner',
                  }
                : {
                    type: 'response',
                    requestId: message.requestId,
                    resultType: 'error',
                    error: 'no-client-found',
                  }
            );
          send({ type: 'response', requestId: message.requestId, resultType: 'success' });
        });
        const statePath = join(directory, 'queue-state.sqlite');
        const db = new Database(statePath);
        db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
        CREATE TABLE projects (id TEXT, name TEXT);
        CREATE TABLE project_roots (project_id TEXT, path TEXT);`);
        db.prepare(
          `INSERT INTO threads VALUES ('thread-1', 'Queued worker', '', '', '/tmp/verify', 'desktop', 0, 1, ?)`
        ).run(join(directory, 'queue-rollout.jsonl'));
        db.close();
        const calls: string[] = [];
        const driver = createCodexDesktopAdapter({
          statePath,
          desktopSocketPath: f.path,
          desktopRunning: async () => true,
          worktreesDir: directory,
          machine: 'test',
          now: Date.now,
          spawn: () => {
            throw new Error('Queue routing must not spawn processes');
          },
          appServer: async () => ({
            call: async (method) => {
              calls.push(method);
              if (method === 'thread/loaded/list') return { data: ['thread-1'], nextCursor: null };
              if (method === 'thread/queue/add')
                return { queuedSubmission: { id: 'native-queue' } };
              throw new Error(`Unexpected app-server call ${method}`);
            },
            close: () => {},
          }),
          bootstrapServer: async () => {
            throw new Error('Queued work must not bootstrap');
          },
          prepareDesktopProject: async () => {
            throw new Error('Queued work must not create a project');
          },
          startDesktopTurn: async () => {
            throw new Error('Queued work must not use new-thread handoff');
          },
          folderExists: () => true,
          makeFolder: () => {},
          homeDir: directory,
          gitCheckout: async () => null,
          newId: () => 'queue-input',
        });
        const registry = createOperationRegistry(
          createWorkVerbOperations({
            adapters: () => [driver],
            daemonName: 'test',
            isOpenTodo: () => true,
            remote: { list: () => [], invoke: async () => ({}) },
          })
        );
        const result = await invokeOperation(
          registry,
          'work.send',
          {
            ref: { adapter: driver.id, id: 'thread-1' },
            message: 'Next queued task',
            mode: 'queue',
            todoId: 'open-todo',
          },
          { source: 'mcp', role: 'neo', sessionId: 'neo' }
        );
        const methods = f.seen.map((message) => message.method);
        expect(methods).not.toContain('thread-follower-steer-turn');
        expect(methods).not.toContain('thread-follower-start-turn');
        if (owned) {
          expect(result).toMatchObject({
            kind: 'completed',
            value: { ok: false, reason: 'busy', notSent: true },
          });
          expect(calls).toEqual([]);
        } else {
          expect(result).toMatchObject({
            kind: 'completed',
            value: { ok: true, value: { delivered: false, queuedSubmissionId: 'native-queue' } },
          });
          expect(calls).toEqual(['thread/loaded/list', 'thread/queue/add']);
        }
      }
    );
  });

  test('an absolute IPC deadline prevents a delayed turn dispatch', async () => {
    const f = await fixture((message, _socket, send) =>
      send({ type: 'response', requestId: message.requestId, resultType: 'success' })
    );
    await expect(
      withCodexDesktopIpc(
        f.path,
        async ({ call }) => {
          await new Promise((done) => setTimeout(done, 100));
          return call('thread-follower-start-turn', {}, 2);
        },
        Date.now() + 25
      )
    ).rejects.toThrow('timed out');
    await f.closed;
    expect(f.seen.some((message) => message.method === 'thread-follower-start-turn')).toBe(false);
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
      expect(
        await steerCodexDesktopTurn(f.path, noDesktopOpen, 'thread-1', text, 'input-1')
      ).toEqual({
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

    test('explicit work.send steer returns the Desktop receipt through the operation result schema', async () => {
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
        desktopRunning: async () => true,
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
          isOpenTodo: (todoId) => todoId === 'open-todo',
          remote: { list: () => [], invoke: async () => ({}) },
        })
      );
      expect(
        await invokeOperation(
          registry,
          'work.send',
          {
            ref: { adapter: driver.id, id: 'thread-1' },
            message: 'use the parser',
            mode: 'steer',
            todoId: 'open-todo',
          },
          { source: 'mcp', role: 'neo', sessionId: 'neo' }
        )
      ).toEqual({
        kind: 'completed',
        value: { ok: true, value: { delivered: true, steeredIntoTurnId: 'desktop-turn' } },
      });
      expect(f.seen.at(-1)?.params?.restoreMessage).toMatchObject({
        text: 'use the parser\n\nMessage Neo only at milestones (PR opened, merged or closed; blocked; a question; done; failed), with no acknowledgments and no progress pings. Use: hyperneo send neo --kind <kind> "<text>" (not SendMessage). Choose kind done, blocked, question or failed; use done for a PR milestone. Keep working after you send.\n[HyperNeo agent input]',
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
          noDesktopOpen,
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

    test('refuses if running Desktop has no owner and its open fails', async () => {
      const f = await fixture((message, _socket, send) =>
        send({
          type: 'response',
          requestId: message.requestId,
          resultType: 'error',
          error: 'no-client-found',
        })
      );
      expect(
        await steerCodexDesktopTurn(f.path, noDesktopOpen, 'thread-1', 'hi', 'input-1')
      ).toMatchObject({
        reason: {
          ok: false,
          reason: 'not_delivered',
          detail: expect.stringContaining('Synthetic Desktop open refused'),
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
          await steerCodexDesktopTurn(f.path, noDesktopOpen, 'thread-1', 'hi', 'input-1')
        ).toMatchObject({
          reason: { ok: false, reason: 'not_delivered' },
        });
      }
    );
  });
});

describe('Desktop admission refusal diagnostics', () => {
  test.each(['socket-missing', 'process-probe-failed'])(
    'refuses with a route reason and no spawn: %s',
    async (failure) => {
      const events: Record<string, unknown>[] = [];
      const config = getLoggerConfig();
      configureLogger({ level: LogLevel.WARN, filter: ['*'], excludeFilter: [] });
      const off = subscribeToStructuredLogs((event) => {
        if (event.message.startsWith('work.send route'))
          events.push(JSON.parse(event.message.slice('work.send route '.length)));
      });
      try {
        const result = await steerCodexDesktopTurn(
          undefined,
          () => {
            throw new Error('Must not spawn');
          },
          'synthetic-thread',
          'synthetic message',
          'synthetic-message',
          'auto',
          async () => {
            if (failure === 'process-probe-failed') throw new Error('Synthetic probe failed');
            return true;
          }
        );
        expect(result).toMatchObject({ reason: { ok: false, reason: 'not_delivered' } });
        expect(events).toContainEqual(
          expect.objectContaining({
            threadId: 'synthetic-thread',
            messageId: 'synthetic-message',
            path: 'refused',
            reason:
              failure === 'socket-missing'
                ? 'desktop_socket_missing'
                : 'desktop_running_probe_failed',
          })
        );
      } finally {
        off();
        configureLogger(config);
      }
    }
  );
});
