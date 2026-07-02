/**
 * Dev Proxy Test Helper
 *
 * Manages Dev Proxy lifecycle for integration tests that need to mock
 * HTTP requests to external APIs (like Anthropic API).
 *
 * ## Usage
 *
 * ```ts
 * import { createDevProxyController, type DevProxyController } from './dev-proxy';
 *
 * describe('My API tests', () => {
 *   let proxy: DevProxyController;
 *
 *   beforeEach(async () => {
 *     proxy = createDevProxyController();
 *     await proxy.start();
 *   });
 *
 *   afterEach(async () => {
 *     await proxy.stop();
 *   });
 *
 *   it('should mock API response', async () => {
 *     // ANTHROPIC_BASE_URL is automatically set to proxy URL
 *     // ... test code
 *   });
 * });
 * ```
 *
 * ## Environment Variables
 *
 * The helper automatically sets ANTHROPIC_BASE_URL on start:
 * - ANTHROPIC_BASE_URL: The proxy URL (http://127.0.0.1:8000)
 *
 * This approach is more reliable than proxy environment variables because:
 * - SDK subprocesses properly inherit ANTHROPIC_BASE_URL
 * - No TLS interception issues (Dev Proxy uses HTTP, not HTTPS)
 * - No need for NODE_TLS_REJECT_UNAUTHORIZED or certificate handling
 *
 * ## Prerequisites
 *
 * Dev Proxy must be installed. See:
 * https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/get-started/set-up
 */

import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { setTimeout as sleep } from 'timers/promises';

/**
 * Configuration options for Dev Proxy controller
 */
export interface DevProxyOptions {
  /**
   * Port to run Dev Proxy on
   * Default: 8000
   */
  port?: number;

  /**
   * Path to devproxyrc.json configuration file
   * Default: <repo-root>/.devproxy/devproxyrc.json
   */
  configPath?: string;

  /**
   * Path to mocks.json file
   * Default: <repo-root>/.devproxy/mocks.json
   */
  mocksPath?: string;

  /**
   * Timeout in ms to wait for proxy to start
   * Default: 10000
   */
  startTimeout?: number;

  /**
   * Whether to automatically set environment variables on start
   * Default: true
   */
  setEnvVars?: boolean;

  /**
   * Log level for Dev Proxy
   * Default: 'information'
   */
  logLevel?: 'debug' | 'information' | 'warning' | 'error' | 'trace';
}

/**
 * Controller interface for managing Dev Proxy lifecycle
 */
export interface DevProxyController {
  /**
   * Start Dev Proxy process.
   * If a proxy is already listening on the configured port, it is adopted as an
   * external instance (isExternal becomes true) and no new process is started.
   * @throws Error if proxy fails to start within timeout
   */
  start(): Promise<void>;

  /**
   * Stop Dev Proxy process gracefully.
   * Has no effect when the proxy was adopted as an external instance (isExternal === true).
   */
  stop(): Promise<void>;

  /**
   * Check if Dev Proxy is currently running
   */
  isRunning(): boolean;

  /**
   * Wait for proxy to be ready (health check)
   * @param timeout - Timeout in ms
   */
  waitForReady(timeout?: number): Promise<void>;

  /**
   * Load a different mock file by updating devproxyrc.json
   * @param mockFilePath - Path to the new mock file (relative to .devproxy dir or absolute)
   */
  loadMockFile(mockFilePath: string): void;

  /**
   * Get the proxy URL (e.g., http://127.0.0.1:8000)
   */
  readonly proxyUrl: string;

  /**
   * Get the proxy port
   */
  readonly port: number;

  /**
   * Get the process PID (if running)
   */
  readonly pid: number | undefined;

  /**
   * Whether this controller adopted a pre-existing proxy instance rather than
   * starting one itself.  When true, stop() is a no-op so we don't terminate a
   * proxy that belongs to another process.
   */
  readonly isExternal: boolean;

  /**
   * Restore original environment variables that were modified
   */
  restoreEnv(): void;
}

/**
 * Find the repository root directory by looking for package.json with workspaces
 */
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

/**
 * Get the path to Dev Proxy's root CA certificate
 */
function getCaCertPath(): string {
  // Dev Proxy stores CA cert in ~/.proxy/rootCA.pem on macOS/Linux
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(homeDir, '.proxy', 'rootCA.pem');
}

/**
 * Check if devproxy command is available
 */
async function isDevProxyInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['devproxy'], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Create a Dev Proxy controller instance
 */
export function createDevProxyController(options: DevProxyOptions = {}): DevProxyController {
  const {
    port = 8000,
    configPath: userConfigPath,
    mocksPath: userMocksPath,
    startTimeout = 10000,
    setEnvVars = true,
    logLevel = 'information',
  } = options;

  // Resolve paths
  const repoRoot = findRepoRoot(__dirname);
  if (!repoRoot) {
    throw new Error('Could not find repository root directory');
  }

  const devProxyDir = path.join(repoRoot, '.devproxy');
  const configPath = userConfigPath || path.join(devProxyDir, 'devproxyrc.json');
  const mocksPath = userMocksPath || path.join(devProxyDir, 'mocks.json');
  const logPath = path.join(devProxyDir, 'devproxy.log');
  const captureLogsOnStop = process.env.HYPERNEO_DEV_PROXY_CAPTURE_LOGS === '1';

  // Ensure .devproxy directory exists (may not exist in git worktrees)
  if (!fs.existsSync(devProxyDir)) {
    fs.mkdirSync(devProxyDir, { recursive: true });
  }

  // Create devproxyrc.json at the requested config path if it doesn't exist.
  // This lets callers supply a custom configPath (e.g. to load a different mock
  // file) without having to create the file themselves. Only creates a new file
  // when one does not already exist — we never mutate a tracked/existing config
  // to avoid dirtying the checkout.
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

  // Create default mocks.json if it doesn't exist
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

  // State
  let running = false;
  let external = false; // true when we adopted a pre-existing proxy
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

  // Helper to get the running proxy's config file path via the devproxy REST API.
  // Only applicable when the proxy is listening on the default port (8000), since that
  // is the only port on which the devproxy API (port 8897) is meaningful. For non-default
  // ports (e.g., unit-test fake TCP servers), this returns null to skip the check.
  const fetchRunningProxyConfigFile = async (): Promise<string | null> => {
    // Only check config for the default devproxy port. Non-default ports are used in unit
    // tests with fake TCP servers; they should always be adopted as-is.
    if (port !== 8000) return null;

    // The devproxy REST API listens on a port derived from the proxy port.
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

  // Helper to check if proxy is responding
  const checkProxyReady = async (): Promise<boolean> => {
    // Try to connect to the proxy port using a TCP connection check
    // This is more reliable than fetch() for HTTPS proxies
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

  // Store original env var
  const saveEnvVar = (key: string) => {
    if (!(key in originalEnv)) {
      originalEnv[key] = globalThis.process.env[key];
    }
  };

  // Set environment variables for proxy
  // Use ANTHROPIC_BASE_URL instead of proxy env vars - this is more reliable
  // because SDK subprocesses properly inherit it without TLS issues
  const setProxyEnvVars = () => {
    const proxyUrl = `http://127.0.0.1:${port}`;

    saveEnvVar('ANTHROPIC_BASE_URL');

    // Set ANTHROPIC_BASE_URL to Dev Proxy - SDK will use this URL for API calls
    // Dev Proxy will intercept and return mocked responses
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

      // Proactively check if a proxy is already listening on the port.
      // If so, adopt it as an external instance instead of trying to start a new
      // one (which would fail with "already running" and cause test failures).
      if (await checkProxyReady()) {
        // Before adopting the running proxy, verify it was started with the same
        // config file as we expect. When running across multiple git worktrees
        // (e.g., concurrent coder agents), each worktree has its own mocks.json.
        // If the running proxy was started from a different worktree, its mocks
        // will be stale — stop it so we can restart with the correct config.
        const runningConfig = await fetchRunningProxyConfigFile();
        if (runningConfig !== null && runningConfig !== configPath) {
          // Stale proxy from a different context — stop it and restart below.
          await runDevProxyCommand(['stop'], 5000);
          const stopStart = Date.now();
          while (Date.now() - stopStart < 5000) {
            if (!(await checkProxyReady())) break;
            await sleep(100);
          }
          // Fall through to start a fresh proxy with our config.
        } else {
          // Same config (or couldn't determine) — adopt as external.
          running = true;
          external = true;
          if (setEnvVars) {
            setProxyEnvVars();
          }
          return;
        }
      }

      // Check if devproxy is installed
      if (!(await isDevProxyInstalled())) {
        throw new Error(
          'devproxy is not installed. Install with: brew tap dotnet/dev-proxy && brew install dev-proxy'
        );
      }

      // Ensure log directory exists
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
        // Even when `devproxy --detach` exits non-zero (e.g. because it races
        // with another process starting the proxy simultaneously), the proxy may
        // already be up.  Do one final port check before giving up.
        if (await checkProxyReady()) {
          // Verify the proxy that won the race is using our config before
          // adopting it. If it's from a different worktree, throw so the
          // caller gets a clear failure rather than silently using wrong mocks.
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

      // Don't stop a proxy we didn't start — it belongs to another process.
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
      // Resolve relative paths to absolute
      const absoluteMockPath = path.isAbsolute(mockFilePath)
        ? mockFilePath
        : path.join(devProxyDir, mockFilePath);

      if (!fs.existsSync(absoluteMockPath)) {
        throw new Error(`Mock file not found: ${absoluteMockPath}`);
      }

      // Read and update devproxyrc.json
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // Update the mocks file path (relative to .devproxy dir)
      const relativeMockPath = path.relative(devProxyDir, absoluteMockPath);
      config.mockResponsePlugin = config.mockResponsePlugin || {};
      config.mockResponsePlugin.mocksFile = relativeMockPath;

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Note: Dev Proxy needs to be restarted for changes to take effect
      // This is a known limitation
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

/**
 * Global Dev Proxy controller for shared use across tests
 *
 * Use this when you want a single proxy instance for all tests.
 * Call startGlobalDevProxy() in beforeAll and stopGlobalDevProxy() in afterAll.
 */
let globalController: DevProxyController | null = null;

/**
 * Start a global Dev Proxy instance
 *
 * This is useful for test suites that share a single proxy instance.
 */
export async function startGlobalDevProxy(options?: DevProxyOptions): Promise<DevProxyController> {
  if (globalController) {
    return globalController;
  }
  globalController = createDevProxyController(options);
  await globalController.start();
  return globalController;
}

/**
 * Stop the global Dev Proxy instance
 */
export async function stopGlobalDevProxy(): Promise<void> {
  if (globalController) {
    await globalController.stop();
    globalController.restoreEnv();
    globalController = null;
  }
}

/**
 * Get the global Dev Proxy controller (if started)
 */
export function getGlobalDevProxy(): DevProxyController | null {
  return globalController;
}
