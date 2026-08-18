import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { setTimeout as sleep } from 'timers/promises';

export interface DevProxyOptions {
  port?: number;

  configPath?: string;

  mocksPath?: string;

  startTimeout?: number;

  setEnvVars?: boolean;

  logLevel?: 'debug' | 'information' | 'warning' | 'error' | 'trace';
}

export interface DevProxyController {
  start(): Promise<void>;

  stop(): Promise<void>;

  isRunning(): boolean;

  waitForReady(timeout?: number): Promise<void>;

  loadMockFile(mockFilePath: string): void;

  readonly proxyUrl: string;

  readonly port: number;

  readonly pid: number | undefined;

  readonly isExternal: boolean;

  restoreEnv(): void;
}

function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.workspaces) {
          return dir;
        }
      } catch {
        // Continue searching
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function getCaCertPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(homeDir, '.proxy', 'rootCA.pem');
}

async function isDevProxyInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['devproxy'], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

export function createDevProxyController(options: DevProxyOptions = {}): DevProxyController {
  const {
    port = 8000,
    configPath: userConfigPath,
    mocksPath: userMocksPath,
    startTimeout = 10000,
    setEnvVars = true,
    logLevel = 'information',
  } = options;

  const repoRoot = findRepoRoot(__dirname);
  if (!repoRoot) {
    throw new Error('Could not find repository root directory');
  }

  const devProxyDir = path.join(repoRoot, '.devproxy');
  const configPath = userConfigPath || path.join(devProxyDir, 'devproxyrc.json');
  const mocksPath = userMocksPath || path.join(devProxyDir, 'mocks.json');
  const logPath = path.join(devProxyDir, 'devproxy.log');
  const captureLogsOnStop = process.env.HYPERNEO_DEV_PROXY_CAPTURE_LOGS === '1';

  if (!fs.existsSync(devProxyDir)) {
    fs.mkdirSync(devProxyDir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: [
            {
              name: 'MockResponsePlugin',
              enabled: true,
              pluginPath: '~appFolder/plugins/DevProxy.Plugins.dll',
              configSection: 'mockResponsePlugin',
            },
          ],
          urlsToWatch: [
            'http://127.0.0.1:8000/*',
            'http://localhost:8000/*',
            'https://api.anthropic.com/*',
          ],
          mockResponsePlugin: {
            mocksFile: 'mocks.json',
          },
          logLevel: 'information',
          port,
          labelMode: 'text',
        },
        null,
        2
      )
    );
  }

  const defaultMocksPath = path.join(devProxyDir, 'mocks.json');
  if (!fs.existsSync(defaultMocksPath)) {
    fs.writeFileSync(
      defaultMocksPath,
      JSON.stringify(
        {
          mocks: [
            {
              request: {
                url: `http://127.0.0.1:${port}/v1/messages?beta=true`,
                method: 'POST',
              },
              response: {
                statusCode: 200,
                headers: [
                  { name: 'content-type', value: 'application/json' },
                  {
                    name: 'anthropic-ratelimit-requests-limit',
                    value: '50',
                  },
                  {
                    name: 'anthropic-ratelimit-requests-remaining',
                    value: '49',
                  },
                ],
                body: {
                  id: 'msg_mock123',
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'text',
                      text: '[MOCKED BY DEV PROXY] Hello! This is a mocked response from Dev Proxy for testing purposes.',
                    },
                  ],
                  model: 'claude-sonnet-4-20250514',
                  stop_reason: 'end_turn',
                  stop_sequence: null,
                  usage: {
                    input_tokens: 12,
                    output_tokens: 48,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    service_tier: 'standard',
                  },
                },
              },
            },
          ],
        },
        null,
        2
      )
    );
  }

  let running = false;
  let external = false;
  let originalEnv: Record<string, string | undefined> = {};

  const runDevProxyCommand = async (
    args: string[],
    timeoutMs = 10000
  ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    return new Promise((resolve, reject) => {
      const proc = spawn('devproxy', args, {
        cwd: devProxyDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          // Ignore process termination errors
        }
        reject(new Error(`devproxy ${args.join(' ')} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      proc.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout, stderr });
      });
    });
  };

  const fetchRunningProxyConfigFile = async (): Promise<string | null> => {
    if (port !== 8000) return null;

    const apiPort = 8897 + (port - 8000);
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/proxy`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { configFile?: string };
      return data.configFile ?? null;
    } catch {
      return null;
    }
  };

  const checkProxyReady = async (): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = new net.Socket();

      socket.setTimeout(1000);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, '127.0.0.1');
    });
  };

  const saveEnvVar = (key: string) => {
    if (!(key in originalEnv)) {
      originalEnv[key] = globalThis.process.env[key];
    }
  };

  const setProxyEnvVars = () => {
    const proxyUrl = `http://127.0.0.1:${port}`;

    saveEnvVar('ANTHROPIC_BASE_URL');

    globalThis.process.env.ANTHROPIC_BASE_URL = proxyUrl;
  };

  const controller: DevProxyController = {
    get proxyUrl() {
      return `http://127.0.0.1:${port}`;
    },

    get port() {
      return port;
    },

    get pid() {
      return undefined;
    },

    get isExternal() {
      return external;
    },

    async start() {
      if (running) {
        throw new Error('Dev Proxy is already running');
      }

      if (await checkProxyReady()) {
        const runningConfig = await fetchRunningProxyConfigFile();
        if (runningConfig !== null && runningConfig !== configPath) {
          await runDevProxyCommand(['stop'], 5000);
          const stopStart = Date.now();
          while (Date.now() - stopStart < 5000) {
            if (!(await checkProxyReady())) break;
            await sleep(100);
          }
        } else {
          running = true;
          external = true;
          if (setEnvVars) {
            setProxyEnvVars();
          }
          return;
        }
      }

      if (!(await isDevProxyInstalled())) {
        throw new Error(
          'devproxy is not installed. Install with: brew tap dotnet/dev-proxy && brew install dev-proxy'
        );
      }

      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      fs.writeFileSync(logPath, '');

      const startResult = await runDevProxyCommand(
        [
          '--detach',
          '--no-first-run',
          '--as-system-proxy',
          'false',
          '--port',
          String(port),
          '--api-port',
          String(8897 + (port - 8000)),
          '--config-file',
          configPath,
          '--log-level',
          logLevel,
          '--record',
        ],
        startTimeout
      );

      if (startResult.code !== 0) {
        if (await checkProxyReady()) {
          const runningConfig = await fetchRunningProxyConfigFile();
          if (runningConfig !== null && runningConfig !== configPath) {
            throw new Error(
              `Dev Proxy started by a concurrent process has a different config. ` +
                `Expected: ${configPath}, Got: ${runningConfig}. ` +
                `Stop the running proxy and retry.`
            );
          }
          running = true;
          external = true;
          if (setEnvVars) {
            setProxyEnvVars();
          }
          return;
        }
        throw new Error(
          `Failed to start Dev Proxy (exit ${startResult.code ?? 'unknown'}): ` +
            (startResult.stderr || startResult.stdout || 'no output')
        );
      }

      const startTime = Date.now();
      while (Date.now() - startTime < startTimeout) {
        if (await checkProxyReady()) {
          running = true;
          external = false;
          if (setEnvVars) {
            setProxyEnvVars();
          }
          return;
        }
        await sleep(100);
      }

      throw new Error(`Dev Proxy failed to become ready within ${startTimeout}ms`);
    },

    async stop() {
      if (!running) {
        return;
      }

      if (external) {
        running = false;
        external = false;
        return;
      }

      if (captureLogsOnStop) {
        try {
          const logs = await runDevProxyCommand(
            ['logs', '--lines', '2000', '--output', 'text'],
            5000
          );
          const output = [logs.stdout.trim(), logs.stderr.trim()].filter(Boolean).join('\n');
          if (output) {
            fs.appendFileSync(logPath, `${output}\n`);
          }
        } catch {
          // Ignore log collection failures
        }
      }

      await runDevProxyCommand(['stop'], 5000);

      const stopStart = Date.now();
      while (Date.now() - stopStart < 5000) {
        if (!(await checkProxyReady())) {
          break;
        }
        await sleep(100);
      }

      running = false;
    },

    isRunning() {
      return running;
    },

    async waitForReady(timeout = 5000) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        if (await checkProxyReady()) {
          return;
        }
        await sleep(100);
      }
      throw new Error(`Dev Proxy not ready within ${timeout}ms`);
    },

    loadMockFile(mockFilePath: string) {
      const absoluteMockPath = path.isAbsolute(mockFilePath)
        ? mockFilePath
        : path.join(devProxyDir, mockFilePath);

      if (!fs.existsSync(absoluteMockPath)) {
        throw new Error(`Mock file not found: ${absoluteMockPath}`);
      }

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      const relativeMockPath = path.relative(devProxyDir, absoluteMockPath);
      config.mockResponsePlugin = config.mockResponsePlugin || {};
      config.mockResponsePlugin.mocksFile = relativeMockPath;

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    },

    restoreEnv() {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete globalThis.process.env[key];
        } else {
          globalThis.process.env[key] = value;
        }
      }
      originalEnv = {};
    },
  };

  return controller;
}

let globalController: DevProxyController | null = null;

export async function startGlobalDevProxy(options?: DevProxyOptions): Promise<DevProxyController> {
  if (globalController) {
    return globalController;
  }
  globalController = createDevProxyController(options);
  await globalController.start();
  return globalController;
}

export async function stopGlobalDevProxy(): Promise<void> {
  if (globalController) {
    await globalController.stop();
    globalController.restoreEnv();
    globalController = null;
  }
}

export function getGlobalDevProxy(): DevProxyController | null {
  return globalController;
}
