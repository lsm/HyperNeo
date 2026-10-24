import WebSocket from 'ws';
import { Logger } from '../logger.ts';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AcpTransport } from '../acp/acp-transport.ts';
import { selectCodexConfiguration } from './codex-start-configuration.ts';

const log = new Logger('codex-send');
const CALL_TIMEOUT_MS = 30_000;
const CLOSE_RETENTION_MS = 30 * 60_000;

export interface CodexAppServer {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void | Promise<void>;
  selectConfiguration?: (
    request: Parameters<typeof selectCodexConfiguration>[0]
  ) => ReturnType<typeof selectCodexConfiguration>;
}

export async function startCodexBootstrapServer(
  command = process.env.CODEX_CLI_PATH ??
    [homedir(), '']
      .flatMap((root) => [
        join(root, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
        join(root, '/Applications/Codex.app/Contents/Resources/codex'),
      ])
      .find(existsSync) ??
    'codex'
): Promise<CodexAppServer> {
  let endInput = () => {};
  let resolveExit = () => {};
  let closing: Promise<void> | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const transport = new AcpTransport({
    command,
    args: ['app-server', '--listen', 'stdio://'],
    requestTimeoutMs: CALL_TIMEOUT_MS,
    onProcessSpawn: (child) => {
      endInput = () => child.stdin?.end();
    },
    onExit: () => resolveExit(),
  });
  const server: CodexAppServer = {
    call: async (method, params) => {
      const response = await transport.sendRequest(method, params);
      if ('error' in response) throw new Error(`${method}: ${response.error.message}`);
      return response.result;
    },
    close: () =>
      (closing ??= (async () => {
        const timer = setTimeout(() => {
          void transport.close();
        }, 5_000);
        try {
          endInput();
          await exited;
          await transport.close();
        } finally {
          clearTimeout(timer);
        }
      })()),
  };
  try {
    await server.call('initialize', {
      clientInfo: { name: 'hyperneo', title: 'HyperNeo', version: '1' },
      capabilities: { experimentalApi: true },
    });
    transport.sendNotification('initialized', {});
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function connectCodexAppServer(
  socketPath: string,
  maxCloseRetentionMs = CLOSE_RETENTION_MS
): Promise<CodexAppServer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws+unix://${socketPath}:/`);
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let closing = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const turns = new Map<string, { id: string; releasing: boolean }>();
    const completed = new Set<string>();
    const closeIfReleased = () => {
      if (closing && !turns.size) {
        clearTimeout(closeTimer);
        socket.close();
      }
    };
    const release = (threadId: string, expired = false) => {
      const turn = turns.get(threadId);
      if (!turn || turn.releasing || (!expired && !completed.has(`${threadId}/${turn.id}`))) return;
      turn.releasing = true;
      void call('thread/unsubscribe', { threadId })
        .then(
          (result) =>
            log.warn('work.send app-server unsubscribed', {
              threadId,
              turnId: turn.id,
              result,
              idleGraceMinutes: 30,
              reason: expired ? 'close-retention-expired' : 'turn-completed',
            }),
          (error) =>
            log.warn('work.send app-server unsubscribe failed', {
              threadId,
              turnId: turn.id,
              reason: String(error),
            })
        )
        .finally(() => {
          turns.delete(threadId);
          closeIfReleased();
        });
    };
    const call = async (method: string, params: Record<string, unknown>) => {
      const result = await new Promise<unknown>((resolveCall, rejectCall) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error(`${method} got no answer from the Codex app-server.`));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { method, resolve: resolveCall, reject: rejectCall, timer });
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
      const turn = result as { turn?: { id?: string } } | null;
      if (
        method === 'turn/start' &&
        typeof params.threadId === 'string' &&
        typeof turn?.turn?.id === 'string'
      ) {
        turns.set(params.threadId, { id: turn.turn.id, releasing: false });
        release(params.threadId);
      }
      return result;
    };
    socket.on('message', (data) => {
      let message: {
        id?: unknown;
        result?: unknown;
        error?: unknown;
        method?: string;
        params?: { threadId?: string; turn?: { id?: string } };
      };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (
        message.method === 'turn/completed' &&
        typeof message.params?.threadId === 'string' &&
        typeof message.params.turn?.id === 'string'
      ) {
        completed.add(`${message.params.threadId}/${message.params.turn.id}`);
        release(message.params.threadId);
      } else if (message.method === 'turn/completed') {
        log.warn('work.send app-server completion unrecognized', {
          hasThreadId: typeof message.params?.threadId === 'string',
          hasTurnId: typeof message.params?.turn?.id === 'string',
          trackedTurns: turns.size,
        });
      }
      const waiting = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (!waiting || typeof message.id !== 'number') return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error !== undefined) {
        waiting.reject(new Error(`${waiting.method}: ${JSON.stringify(message.error)}`));
      } else {
        waiting.resolve(message.result);
      }
    });
    socket.on('close', () => {
      clearTimeout(closeTimer);
      turns.clear();
      completed.clear();
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error('The Codex app-server closed the connection.'));
      }
      pending.clear();
    });
    socket.on('error', reject);
    socket.on('open', async () => {
      try {
        await call('initialize', {
          clientInfo: { name: 'hyperneo', title: 'HyperNeo', version: '1' },
          capabilities: { experimentalApi: true },
        });
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
        resolve({
          call,
          close: () => {
            if (!closing && turns.size) {
              closeTimer = setTimeout(() => {
                log.warn('work.send app-server close retention expired', {
                  maxCloseRetentionMs,
                  threadIds: [...turns.keys()],
                });
                for (const threadId of turns.keys()) release(threadId, true);
              }, maxCloseRetentionMs);
              closeTimer.unref?.();
            }
            closing = true;
            closeIfReleased();
          },
          selectConfiguration: (request) => selectCodexConfiguration(request, { call }),
        });
      } catch (error) {
        socket.close();
        reject(error);
      }
    });
  });
}
