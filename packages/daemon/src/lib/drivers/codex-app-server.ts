import WebSocket from 'ws';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AcpTransport } from '../acp/acp-transport.ts';
import { selectCodexConfiguration } from './codex-start-configuration.ts';

const CALL_TIMEOUT_MS = 30_000;

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
  let exit: { code: number | null; signal: string | null } | undefined;
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
    onExit: (code, signal) => {
      exit = { code, signal };
      resolveExit();
    },
  });
  const server: CodexAppServer = {
    call: async (method, params) => {
      const response = await transport.sendRequest(method, params);
      if ('error' in response) throw new Error(`${method}: ${response.error.message}`);
      return response.result;
    },
    close: () =>
      (closing ??= (async () => {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          void transport.close();
        }, 5_000);
        try {
          endInput();
          await exited;
          await transport.close();
          if (exit?.code !== 0)
            throw new Error(
              timedOut
                ? 'Codex bootstrap did not exit within 5 seconds; Desktop handoff aborted.'
                : `Codex bootstrap exited with ${exit?.signal ?? exit?.code ?? 'unknown status'}.`
            );
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
    await Promise.resolve(server.close()).catch(() => {});
    throw error;
  }
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function connectCodexAppServer(socketPath: string): Promise<CodexAppServer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws+unix://${socketPath}:/`);
    const pending = new Map<number, Pending>();
    let nextId = 1;
    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<unknown>((resolveCall, rejectCall) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error(`${method} got no answer from the Codex app-server.`));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { method, resolve: resolveCall, reject: rejectCall, timer });
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    socket.on('message', (data) => {
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
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
          close: () => socket.close(),
          selectConfiguration: (request) => selectCodexConfiguration(request, { call }),
        });
      } catch (error) {
        socket.close();
        reject(error);
      }
    });
  });
}
