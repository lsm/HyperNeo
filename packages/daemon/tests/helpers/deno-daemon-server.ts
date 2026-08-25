import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';
import { createMockApiServer } from './mock-api-server.ts';
import type { DaemonServerContext } from './daemon-server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const daemonMainPath = resolve(here, '..', '..', 'main.ts');
const daemonDir = dirname(daemonMainPath);

const SETUP_TIMEOUT_MS = 120000;
const MODELS_READY_TIMEOUT_MS = 30000;
const WEBSOCKET_READY_TIMEOUT_MS = 10000;

function isDeno2Point9(): boolean {
  try {
    const result = spawnSync('deno', ['--version'], { encoding: 'utf-8' });
    if (result.status !== 0 || !result.stdout) {
      return false;
    }
    const firstLine = result.stdout.split('\n')[0] ?? '';
    return firstLine.startsWith('deno 2.9');
  } catch {
    return false;
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function waitForProcessExit(
  process: ChildProcess,
  hasExited: boolean,
  timeout: number
): Promise<void> {
  if (hasExited) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for process exit after ${timeout}ms`));
    }, timeout);
    process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForModelsReady(
  messageHub: MessageHub,
  timeout = MODELS_READY_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = (await messageHub.request('models.list', {}, { timeout: 5000 })) as {
        models: unknown[];
      };
      if (result.models.length > 0) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(
    `Timed out waiting for models after ${timeout}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

export async function createDenoDaemonServer(): Promise<DaemonServerContext> {
  if (!isDeno2Point9()) {
    throw new Error('Deno 2.9.x is not available on PATH');
  }

  const mockPort = await findFreePort();
  const mockServer = await createMockApiServer({ port: mockPort });
  await mockServer.start();

  const workDir = mkdtempSync(join(tmpdir(), 'hyperneo-deno-'));
  const dbPath = join(workDir, 'daemon.db');

  const daemonEnv: Record<string, string> = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    HYPERNEO_PORT: '0',
    DB_PATH: dbPath,
    TEST_WORKTREE_BASE_DIR: join(workDir, 'worktrees'),
    ANTHROPIC_API_KEY: 'sk-deno-test-key',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    GLM_API_KEY: '',
    OPENAI_API_KEY: '',
    COPILOT_GITHUB_TOKEN: '',
    MINIMAX_API_KEY: '',
    HYPERNEO_SDK_STARTUP_TIMEOUT_MS: '60000',
  };

  const daemonProcess = spawn('deno', ['run', '-A', daemonMainPath], {
    cwd: daemonDir,
    env: daemonEnv,
    stdio: 'pipe',
    detached: false,
  });

  let hasExited = false;
  daemonProcess.once('exit', () => {
    hasExited = true;
  });

  let stdoutOutput = '';
  let stderrOutput = '';
  let baseUrl = '';
  let transport: WebSocketClientTransport | undefined;

  async function dispose(reason?: string): Promise<void> {
    if (reason && process.env.TEST_VERBOSE) {
      console.error(`[DENO-DAEMON] cleaning up after error: ${reason}`);
    }
    if (daemonProcess && !hasExited) {
      try {
        daemonProcess.kill('SIGTERM');
      } catch {}
      try {
        await waitForProcessExit(daemonProcess, hasExited, 10000);
      } catch {
        try {
          daemonProcess.kill('SIGKILL');
        } catch {}
      }
    }
    if (transport) {
      try {
        await transport.close();
      } catch {}
    }
    try {
      await mockServer.stop();
    } catch {}
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {}
    try {
      mockServer.restoreEnv();
    } catch {}
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Deno daemon startup timeout')),
        SETUP_TIMEOUT_MS
      );
      let portResolved = false;

      const onData = (data: Buffer) => {
        const text = data.toString();
        stdoutOutput += text;
        stderrOutput += text;
        if (process.env.TEST_VERBOSE) {
          console.error(`[DENO-DAEMON] ${text.trim()}`);
        }
        if (!portResolved) {
          const match = text.match(/Port:\s*(\d+)/);
          if (match) {
            const port = Number.parseInt(match[1], 10);
            baseUrl = `http://127.0.0.1:${port}`;
            portResolved = true;
            clearTimeout(timeout);
            resolve();
          }
        }
      };

      daemonProcess.stdout?.on('data', onData);
      daemonProcess.stderr?.on('data', onData);

      daemonProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      daemonProcess.on('exit', (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Deno daemon exited with code ${code}\nStdout: ${stdoutOutput}\nStderr: ${stderrOutput}`
          )
        );
      });
    });

    transport = new WebSocketClientTransport({
      url: `${baseUrl}/ws`,
      autoReconnect: false,
    });
    const messageHub = new MessageHub({ defaultSessionId: 'global' });
    messageHub.registerTransport(transport!);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('WebSocket connection to Deno daemon timed out')),
        WEBSOCKET_READY_TIMEOUT_MS
      );
      transport!.onConnectionChange((state) => {
        if (state === 'connected') {
          clearTimeout(timer);
          resolve();
        }
      });
      transport!.initialize().catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    await waitForModelsReady(messageHub);

    const trackedSessions: string[] = [];

    const cleanup = async () => {
      for (const sessionId of trackedSessions) {
        try {
          await messageHub.request('session.delete', { sessionId });
        } catch {}
      }
      trackedSessions.length = 0;
    };

    return {
      pid: daemonProcess.pid ?? 0,
      messageHub,
      baseUrl,
      devProxy: null,
      getCapturedOutput: () => stdoutOutput,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => daemonProcess.kill(signal),
      waitForExit: async () => {
        await cleanup();
        if (!hasExited) {
          await new Promise<void>((resolve) => daemonProcess.once('exit', () => resolve()));
        }
        try {
          await transport?.close();
        } catch {}
        try {
          await mockServer.stop();
        } catch {}
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {}
        mockServer.restoreEnv();
      },
      trackSession: (sessionId: string) => {
        trackedSessions.push(sessionId);
      },
      cleanup,
    };
  } catch (error) {
    await dispose(String(error instanceof Error ? error.message : error));
    throw error;
  }
}
