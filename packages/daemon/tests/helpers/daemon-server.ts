/**
 * Test helper for running daemon server in tests
 *
 * Provides two modes:
 * 1. In-process (default): Runs daemon in same process for coverage collection
 * 2. Spawned process: Runs daemon as separate process for true isolation
 *
 * ## Dev Proxy Integration
 *
 * When HYPERNEO_USE_DEV_PROXY=1 is set, the helper will:
 * 1. Start Dev Proxy before creating the daemon server
 * 2. Set ANTHROPIC_BASE_URL to point to Dev Proxy (e.g., http://127.0.0.1:8000)
 * 3. Stop Dev Proxy and restore ANTHROPIC_BASE_URL when the daemon server is cleaned up
 *
 * This allows tests to run without making real API calls to Anthropic.
 *
 * The ANTHROPIC_BASE_URL approach is more reliable than proxy environment variables
 * because SDK subprocesses properly inherit it.
 */

import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { mkdirSync, rmSync } from 'node:fs';
import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';
import { createDaemonApp, type DaemonAppContext } from '../../src/app';
import { getConfig } from '../../src/config';
import {
  createDevProxyController,
  type DevProxyController,
  type DevProxyOptions,
} from './dev-proxy';

export interface DaemonServerOptions {
  /**
   * Port for the daemon server.
   * Default: 0 (OS-assigned). The actual port is read back from the server
   * after startup (via server.port for in-process, stdout parsing for spawned).
   */
  port?: number;

  /**
   * Environment variables to pass to the daemon process
   */
  env?: Record<string, string>;

  /**
   * Dev Proxy options for mocking HTTP requests
   * Only used when HYPERNEO_USE_DEV_PROXY=1 is set
   */
  devProxy?: DevProxyOptions;

  /**
   * Force enable Dev Proxy even without HYPERNEO_USE_DEV_PROXY=1
   * Default: false
   */
  useDevProxy?: boolean;

  /**
   * Reuse an existing workspace directory instead of creating a new temp one.
   * Used for daemon restart scenarios: pass the workspace path from a previous
   * daemon instance to share the same SQLite database across restarts.
   * When provided, the workspace is NOT deleted in waitForExit.
   */
  workspacePath?: string;

  /**
   * Budget (ms) for waitForModelsReady during startup. Defaults to 8000.
   * Tests that deliberately stress the daemon (e.g. an artificially short SDK
   * startup timeout that thrashes subprocess spawn) slow down the daemon's model
   * fetch and need a larger readiness budget to avoid flaking on startup.
   */
  modelsReadyTimeoutMs?: number;
}

export interface DaemonServerContext {
  /**
   * Child process PID for sending signals
   */
  pid: number;

  /**
   * MessageHub client for communicating with the daemon
   */
  messageHub: MessageHub;

  /**
   * Base URL for the daemon server
   */
  baseUrl: string;

  /**
   * Kill the daemon server
   */
  kill: (signal?: NodeJS.Signals) => boolean;

  /**
   * Wait for the daemon to exit
   */
  waitForExit: () => Promise<void>;

  /**
   * Track a session for cleanup
   */
  trackSession: (sessionId: string) => void;

  /**
   * Cleanup all tracked sessions using session.delete RPC
   */
  cleanup: () => Promise<void>;

  /**
   * Dev Proxy controller (only when HYPERNEO_USE_DEV_PROXY=1 or useDevProxy=true).
   * Sets ANTHROPIC_BASE_URL to point to Dev Proxy for API mocking.
   */
  devProxy: DevProxyController | null;

  /**
   * Workspace directory used by this daemon instance.
   * Set for in-process daemons; undefined for spawned-process daemons.
   * Exposed so restart helpers can spin up a new daemon on the same workspace/DB.
   */
  workspacePath?: string;

  /**
   * Combined captured stdout+stderr of the spawned daemon process. Returns ''
   * for in-process daemons (no child output to capture). Spawn the daemon with
   * LOG_LEVEL=warn to surface daemon log lines — both the error-level startup
   * timeout ("SDK startup timeout:") and the warn-level retry log ("Auto-retrying
   * query after startup timeout"); error alone suppresses the latter — so a test
   * can assert a code path was actually reached rather than passing vacuously on
   * timing.
   */
  getCapturedOutput?: () => string;
}

function getDevProxyPort(options?: DevProxyOptions): number {
  return options?.port ?? 8000;
}

interface DevProxyLease {
  controller: DevProxyController | null;
  release: () => Promise<void>;
}

let sharedDevProxyController: DevProxyController | null = null;
let sharedDevProxyPort: number | null = null;
let sharedDevProxyRefCount = 0;
let sharedDevProxyExitHookInstalled = false;
let sharedDevProxyStopTimer: ReturnType<typeof setTimeout> | null = null;
let sharedDevProxyStopPromise: Promise<void> | null = null;

function shouldReuseDevProxy(): boolean {
  // Reuse one Dev Proxy instance across tests in the same process by default.
  // Set HYPERNEO_DEV_PROXY_REUSE=0 to force per-test start/stop behavior.
  return process.env.HYPERNEO_DEV_PROXY_REUSE !== '0';
}

function getSharedDevProxyIdleTtlMs(): number {
  // Keep proxy warm between test transitions, then auto-stop when idle.
  const raw = process.env.HYPERNEO_DEV_PROXY_IDLE_TTL_MS;
  if (!raw) {
    return 2000;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
}

function clearSharedDevProxyStopTimer(): void {
  if (sharedDevProxyStopTimer) {
    clearTimeout(sharedDevProxyStopTimer);
    sharedDevProxyStopTimer = null;
  }
}

async function stopSharedDevProxyAsync(): Promise<void> {
  if (!sharedDevProxyController) {
    return;
  }
  if (sharedDevProxyStopPromise) {
    await sharedDevProxyStopPromise;
    return;
  }

  const controller = sharedDevProxyController;
  sharedDevProxyStopPromise = (async () => {
    try {
      await controller.stop();
    } catch {
      // Best-effort cleanup
    }
    try {
      controller.restoreEnv();
    } catch {
      // Best-effort env restoration
    }
    if (sharedDevProxyController === controller) {
      sharedDevProxyController = null;
      sharedDevProxyPort = null;
      sharedDevProxyRefCount = 0;
    }
  })();

  try {
    await sharedDevProxyStopPromise;
  } finally {
    sharedDevProxyStopPromise = null;
  }
}

function scheduleSharedDevProxyStopIfIdle(): void {
  clearSharedDevProxyStopTimer();
  sharedDevProxyStopTimer = setTimeout(() => {
    sharedDevProxyStopTimer = null;
    if (sharedDevProxyRefCount === 0) {
      void stopSharedDevProxyAsync();
    }
  }, getSharedDevProxyIdleTtlMs());
  // Don't keep test process alive solely for deferred proxy shutdown.
  sharedDevProxyStopTimer.unref?.();
}

function installSharedDevProxyExitHook(): void {
  if (sharedDevProxyExitHookInstalled) {
    return;
  }
  sharedDevProxyExitHookInstalled = true;

  process.once('exit', () => {
    clearSharedDevProxyStopTimer();
    if (!sharedDevProxyController) {
      return;
    }
    try {
      // Detached Dev Proxy should be stopped explicitly to avoid local process leaks.
      spawnSync('devproxy', ['stop'], { stdio: 'ignore' });
    } catch {
      // Best-effort cleanup
    }
    try {
      sharedDevProxyController.restoreEnv();
    } catch {
      // Best-effort env restoration
    }
    sharedDevProxyController = null;
    sharedDevProxyPort = null;
    sharedDevProxyRefCount = 0;
    sharedDevProxyStopPromise = null;
  });
}

async function acquireDevProxyLease(
  shouldUseDevProxy: boolean,
  devProxyOptions?: DevProxyOptions
): Promise<DevProxyLease> {
  if (!shouldUseDevProxy) {
    return {
      controller: null,
      release: async () => {},
    };
  }

  const devProxyPort = getDevProxyPort(devProxyOptions);
  const devProxyBaseUrl = `http://127.0.0.1:${devProxyPort}`;
  const reuse = shouldReuseDevProxy();

  if (reuse && sharedDevProxyStopPromise) {
    await sharedDevProxyStopPromise;
  }
  if (reuse) {
    clearSharedDevProxyStopTimer();
  }

  if (reuse && sharedDevProxyController) {
    if (sharedDevProxyPort !== null && sharedDevProxyPort !== devProxyPort) {
      throw new Error(
        `Dev Proxy reuse conflict: existing shared port ${sharedDevProxyPort}, requested ${devProxyPort}`
      );
    }
    sharedDevProxyRefCount++;
    return {
      controller: sharedDevProxyController,
      release: async () => {
        sharedDevProxyRefCount = Math.max(0, sharedDevProxyRefCount - 1);
        if (sharedDevProxyRefCount === 0) {
          scheduleSharedDevProxyStopIfIdle();
        }
      },
    };
  }

  const devProxy: DevProxyController = createDevProxyController({
    // Daemon helper explicitly sets env vars for both in-process and spawned modes.
    // Keep proxy lifecycle independent from parent-process env mutation.
    setEnvVars: false,
    ...devProxyOptions,
  });

  try {
    // start() will adopt an existing proxy (isExternal=true) rather than failing
    // when a devproxy instance is already listening on the port.
    await devProxy.start();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Dev Proxy is required for this test run but failed to start on ${devProxyBaseUrl}. ` +
        `Error: ${errorMessage}`
    );
  }

  // For reuse mode, only register as shared controller when we own the proxy
  // process.  External instances are intentionally not pooled in
  // sharedDevProxyController: the exit hook (installSharedDevProxyExitHook)
  // unconditionally runs `devproxy stop` on process exit, which would kill a
  // proxy that belongs to another session.  With external instances each
  // acquireDevProxyLease call creates a lightweight controller that performs a
  // TCP probe on start and a no-op on stop — cheap enough that skipping the
  // pool is acceptable.
  if (reuse && !devProxy.isExternal) {
    sharedDevProxyController = devProxy;
    sharedDevProxyPort = devProxyPort;
    sharedDevProxyRefCount = 1;
    installSharedDevProxyExitHook();
    return {
      controller: devProxy,
      release: async () => {
        sharedDevProxyRefCount = Math.max(0, sharedDevProxyRefCount - 1);
        if (sharedDevProxyRefCount === 0) {
          scheduleSharedDevProxyStopIfIdle();
        }
      },
    };
  }

  return {
    controller: devProxy,
    release: async () => {
      // stop() is a no-op for external instances, so it's always safe to call.
      await devProxy.stop();
      devProxy.restoreEnv();
    },
  };
}

/**
 * Spawn a daemon server as a child process
 *
 * This creates a real daemon server running in a separate process,
 * allowing true process isolation and proper WebSocket testing.
 */
async function spawnDaemonServer(options: DaemonServerOptions = {}): Promise<DaemonServerContext> {
  const {
    port: userPort = 0, // Use port 0 for OS-assigned port; actual port parsed from stdout
    env: customEnv = {},
    devProxy: devProxyOptions,
    useDevProxy = false,
  } = options;

  // Start Dev Proxy if requested
  // Sets ANTHROPIC_BASE_URL to Dev Proxy URL for SDK to use mocked responses
  const shouldUseDevProxy = useDevProxy || process.env.HYPERNEO_USE_DEV_PROXY === '1';
  const devProxyPort = getDevProxyPort(devProxyOptions);
  const devProxyBaseUrl = `http://127.0.0.1:${devProxyPort}`;
  const devProxyLease = await acquireDevProxyLease(shouldUseDevProxy, devProxyOptions);
  const devProxy = devProxyLease.controller;

  // Create a standalone daemon server entry point
  const serverPath = path.join(__dirname, 'standalone-server.ts');

  // Build environment for daemon process
  const daemonEnv: Record<string, string> = {
    ...process.env,
    ...customEnv,
    HYPERNEO_USE_DEV_PROXY: shouldUseDevProxy ? '1' : process.env.HYPERNEO_USE_DEV_PROXY,
    ANTHROPIC_BASE_URL: shouldUseDevProxy ? devProxyBaseUrl : process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: shouldUseDevProxy ? 'sk-devproxy-test-key' : process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: shouldUseDevProxy ? '' : process.env.ANTHROPIC_AUTH_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN: shouldUseDevProxy ? '' : process.env.CLAUDE_CODE_OAUTH_TOKEN,
    PORT: userPort.toString(),
    NODE_ENV: 'test',
    HYPERNEO_SDK_STARTUP_TIMEOUT_MS: process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS || '30000',
  };

  // Note: Proxy env vars are inherited from parent process via ...process.env
  // Dev Proxy will intercept requests to api.anthropic.com

  // Spawn the daemon server under Node via tsx. The daemon's storage layer now
  // targets node:sqlite (runtime-agnostic), so it must run under Node, not Bun.
  // Resolve tsx explicitly relative to this file (repo root is 4 levels up from
  // packages/daemon/tests/helpers/) so the spawn doesn't depend on PATH or on
  // `import.meta.url` (which is a virtual URL under Vitest's SSR transform).
  const repoRoot = path.resolve(__dirname, '../../../..');
  const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const daemonProcess = spawn(process.execPath, [tsxBin, serverPath], {
    env: daemonEnv,
    stdio: 'pipe',
    // Don't use detached: true - we want to be able to track and kill the process
    detached: false,
  });

  // Track whether the child has actually exited so waitForExit() can wait
  // reliably instead of relying on daemonProcess.killed, which becomes true
  // immediately after kill() is called.
  let hasExited = false;
  daemonProcess.once('exit', () => {
    hasExited = true;
  });

  // Wait for the server to be ready and parse the actual port from stdout
  let stderrOutput = '';
  let stdoutOutput = '';
  let actualPort = userPort;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Daemon server startup timeout')), 20000);
    let portResolved = false;

    // Continuously buffer the child's stdout/stderr for the daemon's full
    // lifetime (NOT just startup) so tests can assert on log lines emitted later
    // — e.g. "SDK startup timeout" during a query. The handler is intentionally
    // kept attached; only the one-shot port parse is gated.
    const onData = (data: Buffer) => {
      const output = data.toString();
      stderrOutput += output;
      stdoutOutput += output;
      if (process.env.TEST_VERBOSE) {
        console.error(`[DAEMON-PROCESS] ${output.trim()}`);
      }
      // Parse actual port from "Running on port XXXX" output (one-shot).
      if (!portResolved) {
        const portMatch = output.match(/Running on port (\d+)/);
        if (portMatch) {
          actualPort = Number.parseInt(portMatch[1], 10);
          portResolved = true;
          clearTimeout(timeout);
          resolve();
        }
      }
    };

    daemonProcess.stdout!.on('data', onData);
    daemonProcess.stderr!.on('data', onData);

    daemonProcess.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    daemonProcess.on('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Daemon server exited with code ${code}\nStderr: ${stderrOutput}\nStdout: ${stdoutOutput}`
        )
      );
    });
  });

  // Create WebSocket client to communicate with the daemon
  const wsUrl = `ws://127.0.0.1:${actualPort}/ws`;
  const transport = new WebSocketClientTransport({
    url: wsUrl,
    autoReconnect: false, // Don't auto-reconnect in tests
  });

  const messageHub = new MessageHub({
    defaultSessionId: 'global',
  });

  messageHub.registerTransport(transport);
  await transport.initialize();

  // Track sessions for cleanup
  const trackedSessions: string[] = [];

  const cleanup = async () => {
    // Delete all tracked sessions via RPC
    for (const sessionId of trackedSessions) {
      try {
        await messageHub.request('session.delete', { sessionId });
      } catch {
        // Session may already be deleted, ignore errors
      }
    }
    trackedSessions.length = 0;
  };

  return {
    pid: daemonProcess.pid!,
    messageHub,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    devProxy,
    // Combined stdout+stderr buffered by the startup onData handler. Both
    // streams append to the same buffers, so either is the full transcript.
    getCapturedOutput: () => stdoutOutput,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => daemonProcess.kill(signal),
    waitForExit: async () => {
      // Cleanup tracked sessions before exiting
      await cleanup();
      await new Promise<void>((resolve) => {
        if (hasExited) {
          resolve();
          return;
        }
        daemonProcess.once('exit', () => resolve());
      });
      // Stop Dev Proxy (no need to restore env in spawned mode)
      await devProxyLease.release();
    },
    trackSession: (sessionId: string) => {
      trackedSessions.push(sessionId);
    },
    cleanup,
  };
}

/**
 * Create an in-process daemon server for tests
 *
 * This runs the daemon in the same process as the tests, enabling:
 * - Coverage collection for daemon code
 * - Faster startup/shutdown
 * - Simpler debugging
 *
 * The daemon starts its own HTTP/WebSocket server. We connect to it
 * using WebSocketClientTransport, just like a real client.
 */
async function createInProcessDaemonServer(
  options: DaemonServerOptions = {}
): Promise<DaemonServerContext & { daemonContext: DaemonAppContext }> {
  const {
    port: userPort = 0, // Use port 0 for OS-assigned port to avoid collisions in CI
    env: customEnv = {},
    devProxy: devProxyOptions,
    useDevProxy = false,
    workspacePath: externalWorkspacePath,
  } = options;

  // Start Dev Proxy if requested
  // Sets ANTHROPIC_BASE_URL to Dev Proxy URL for SDK to use mocked responses
  const shouldUseDevProxy = useDevProxy || process.env.HYPERNEO_USE_DEV_PROXY === '1';
  const devProxyPort = getDevProxyPort(devProxyOptions);
  const devProxyBaseUrl = `http://127.0.0.1:${devProxyPort}`;
  const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalClaudeCodeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const devProxyLease = await acquireDevProxyLease(shouldUseDevProxy, devProxyOptions);
  const devProxy = devProxyLease.controller;

  // Save originals for all custom env keys so they can be restored on teardown
  const originalCustomEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(customEnv)) {
    originalCustomEnv[key] = process.env[key];
  }

  // Apply custom env vars
  for (const [key, value] of Object.entries(customEnv)) {
    process.env[key] = value;
  }
  if (shouldUseDevProxy) {
    process.env.ANTHROPIC_BASE_URL = devProxyBaseUrl;
    process.env.ANTHROPIC_API_KEY = 'sk-devproxy-test-key';
    process.env.ANTHROPIC_AUTH_TOKEN = '';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
  }

  // Cap online daemons at 30s (half the 60s production default) so CI
  // startup-hang paths stay bounded; tests needing a specific window set the
  // env before createDaemonServer.
  process.env.NODE_ENV = 'test';
  if (!process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS) {
    process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '30000';
  }

  // Create temp workspace for this test (or reuse an existing one for restart scenarios)
  const workspace =
    externalWorkspacePath ??
    `/tmp/daemon-online-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const isExternalWorkspace = !!externalWorkspacePath;
  if (!isExternalWorkspace) {
    mkdirSync(workspace, { recursive: true });
  }

  // Set worktree base dir to keep worktrees under /tmp (avoids ~/.hyperneo path issues in CI)
  if (!process.env.TEST_WORKTREE_BASE_DIR) {
    process.env.TEST_WORKTREE_BASE_DIR = `/tmp/daemon-worktrees-${Date.now()}`;
  }

  // Configure daemon
  process.env.HYPERNEO_WORKSPACE_PATH = workspace;
  const config = getConfig();
  config.port = userPort;
  config.dbPath = `${workspace}/daemon.db`;

  // Create daemon app in-process (starts its own server)
  const daemonContext = await createDaemonApp({
    config,
    verbose: false,
    standalone: false,
  });

  // Optional CI/test optimization: disable sandbox by default for sessions created
  // in online tests. This avoids requiring bubblewrap/socat on Linux runners for
  // test shards that only exercise message/query flows, not sandbox enforcement.
  if (process.env.HYPERNEO_TEST_DISABLE_SANDBOX === '1') {
    const current = daemonContext.settingsManager.getGlobalSettings();
    daemonContext.settingsManager.updateGlobalSettings({
      sandbox: {
        ...(current.sandbox ?? {}),
        enabled: false,
      },
    });
  }

  // Read back the actual port from the server (handles port 0 / OS-assigned ports)
  const actualPort = daemonContext.server.port;

  // Connect to the daemon's WebSocket server (just like a real client)
  const wsUrl = `ws://127.0.0.1:${actualPort}/ws`;
  const transport = new WebSocketClientTransport({
    url: wsUrl,
    autoReconnect: false, // Don't auto-reconnect in tests
  });

  const messageHub = new MessageHub({
    defaultSessionId: 'global',
  });

  messageHub.registerTransport(transport);
  await transport.initialize();

  // Track sessions for cleanup
  const trackedSessions: string[] = [];

  const cleanup = async () => {
    // Delete all tracked sessions via RPC with timeout
    for (const sessionId of trackedSessions) {
      try {
        // Use Promise.race to add timeout - session.delete may hang if SDK is busy
        await Promise.race([
          messageHub.request('session.delete', { sessionId }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('session.delete timeout')), 5000)
          ),
        ]);
      } catch {
        // Session may already be deleted or timeout, ignore errors
      }
    }
    trackedSessions.length = 0;
  };

  return {
    pid: process.pid, // Same process
    messageHub,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    daemonContext, // Expose for advanced usage
    devProxy,
    workspacePath: workspace,
    // In-process daemon shares the test process — no child output to capture.
    getCapturedOutput: () => '',
    kill: () => {
      // For in-process, cleanup happens in waitForExit - just return true
      return true;
    },
    waitForExit: async () => {
      // Wrap entire cleanup in timeout to prevent test hangs
      const cleanupWithTimeout = async () => {
        // Cleanup tracked sessions before exiting (with timeout protection)
        await cleanup();
        // Close client transport
        try {
          await transport.close();
        } catch {
          // Transport may already be closed
        }
        // Then cleanup daemon (stops server, closes DB, etc.)
        await daemonContext.cleanup();
        // Cleanup temp workspace (skip if workspace was provided externally)
        if (!isExternalWorkspace) {
          rmSync(workspace, { recursive: true, force: true });
        }
      };

      try {
        await Promise.race([
          cleanupWithTimeout(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('waitForExit timeout')), 10000)
          ),
        ]);
      } catch {
        // Timeout or error - force cleanup workspace anyway (skip if external)
        if (!isExternalWorkspace) {
          rmSync(workspace, { recursive: true, force: true });
        }
      }

      // Stop Dev Proxy and restore environment variables if Dev Proxy was started
      await devProxyLease.release();
      if (shouldUseDevProxy) {
        if (originalAnthropicBaseUrl === undefined) {
          delete process.env.ANTHROPIC_BASE_URL;
        } else {
          process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
        }
        if (originalAnthropicApiKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
        }
        if (originalAnthropicAuthToken === undefined) {
          delete process.env.ANTHROPIC_AUTH_TOKEN;
        } else {
          process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
        }
        if (originalClaudeCodeOauthToken === undefined) {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        } else {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeCodeOauthToken;
        }
      }

      // Restore custom env vars (always, not just in dev proxy mode)
      for (const [key, original] of Object.entries(originalCustomEnv)) {
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      }
    },
    trackSession: (sessionId: string) => {
      trackedSessions.push(sessionId);
    },
    cleanup,
  };
}

/**
 * Wait until the daemon's model catalog is ready for sessions.
 *
 * Readiness means the cache is non-empty and reflects every provider that is
 * actually available. createDaemonApp starts model loading in the background
 * only when Anthropic auth is present, so tests that create sessions
 * immediately can race with the cache population. This helper probes provider
 * availability, clears stale cache, runs a foreground refresh when needed, and
 * verifies the result includes the expected providers. If an available
 * provider fails to return models after refresh, a non-empty cache is accepted
 * so optional/bridge providers do not block tests that do not use them.
 */
async function waitForModelsReady(
  context: DaemonServerContext & { daemonContext?: DaemonAppContext },
  timeoutMs = 8000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  if (context.daemonContext) {
    const { getModelsCache, refreshModels, clearModelsCache } = await import(
      '../../src/lib/model-service'
    );
    const { getProviderRegistry } = await import('../../src/lib/providers/registry.js');

    const cache = getModelsCache().get('global') ?? [];
    const registry = getProviderRegistry();

    // Determine which providers are expected to be represented in the cache by
    // probing every registered provider's availability. We include Anthropic
    // bridge providers such as 'anthropic-copilot' and 'anthropic-codex' so
    // Copilot-only runs are not misclassified as non-Anthropic-only runs.
    // Built-in optional providers such as Ollama or custom endpoints are
    // registered but may not be configured; refreshing them when the catalog is
    // already usable can hit the readiness timeout on a slow probe. Bound each
    // availability probe to 1s (or the remaining readiness budget).
    const providerAvailable = new Map<string, boolean>();
    const availabilityResults = await Promise.allSettled(
      registry.getAll().map(async (provider) => {
        const probeMs = Math.min(1000, Math.max(0, deadline - Date.now()));
        if (probeMs <= 0) return { id: provider.id, available: false };
        try {
          const available = await Promise.race([
            provider.isAvailable(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('provider availability probe timeout')), probeMs)
            ),
          ]);
          return { id: provider.id, available };
        } catch {
          return { id: provider.id, available: false };
        }
      })
    );
    for (const result of availabilityResults) {
      if (result.status === 'fulfilled') {
        providerAvailable.set(result.value.id, result.value.available);
      }
    }

    const expectedProviderIds = new Set<string>();
    for (const [id, available] of providerAvailable) {
      if (available) {
        expectedProviderIds.add(id);
      }
    }

    const fallbackAnthropicIds = new Set(['sonnet', 'opus', 'haiku']);
    const anthropicAvailable = providerAvailable.get('anthropic') ?? false;

    // A catalog is ready when it is non-empty, every provider that is actually
    // available is represented, and Anthropic availability is not satisfied by
    // stale fallback aliases left over from a previous daemon.
    const isCatalogReady = (models: typeof cache) => {
      if (models.length === 0) return false;
      const providerIds = new Set(models.map((m) => m.provider));
      const hasAllExpectedProviders =
        expectedProviderIds.size === 0 ||
        Array.from(expectedProviderIds).every((id) => providerIds.has(id));
      if (!hasAllExpectedProviders) return false;
      const anthropicModels = models.filter((m) => m.provider === 'anthropic');
      const cacheHasOnlyFallbackAnthropic =
        anthropicAvailable &&
        anthropicModels.length > 0 &&
        anthropicModels.every((m) => fallbackAnthropicIds.has(m.id));
      return !cacheHasOnlyFallbackAnthropic;
    };

    let refreshed = false;

    if (!isCatalogReady(cache)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error('Timed out waiting for models cache to populate');
      }

      // Clear the cache before refreshing. model-service intentionally preserves
      // a larger previous cache when the newly fetched catalog is smaller, which
      // can hide newly available providers in tests that change credentials
      // between daemons. Clearing also cancels any background refresh from
      // createDaemonApp and lets the foreground refresh start immediately.
      clearModelsCache('global');

      const abortController = new AbortController();
      let refreshDone = false;
      const refreshPromise = refreshModels(abortController.signal).finally(() => {
        refreshDone = true;
      });
      const timeoutPromise = new Promise<void>((_, reject) => {
        const id = setTimeout(() => {
          if (refreshDone) return;
          abortController.abort();
          // Bump the cache generation so the in-flight refresh drops its result
          // instead of overwriting the cleared cache after teardown.
          clearModelsCache('global');
          reject(new Error('Timed out waiting for models cache to populate'));
        }, remainingMs);
        // Don't keep the test process alive for a deferred timeout.
        id.unref?.();
      });

      await Promise.race([refreshPromise, timeoutPromise]);
      refreshed = true;
    }

    while (Date.now() < deadline) {
      const currentCache = getModelsCache().get('global') ?? [];
      if (isCatalogReady(currentCache) || (refreshed && currentCache.length > 0)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error('Timed out waiting for models cache to populate');
  }

  // Spawned mode: use RPC models.list, which refreshes if the cache is empty.
  // Bound each request to the remaining readiness budget so MessageHub's
  // default 10s timeout cannot overrun the helper's deadline.
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const remainingMs = deadline - Date.now();
      const result = (await context.messageHub.request(
        'models.list',
        {},
        {
          timeout: remainingMs,
        }
      )) as {
        models: unknown[];
      };
      if (result.models.length > 0) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for models to become available` +
      (lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : '')
  );
}

/**
 * Default function to create daemon server for tests
 *
 * Uses in-process mode by default for coverage collection.
 * Set DAEMON_TEST_SPAWN=true to use spawned process mode for true isolation.
 */
export async function createDaemonServer(
  options: DaemonServerOptions = {}
): Promise<DaemonServerContext> {
  const context =
    process.env.DAEMON_TEST_SPAWN === 'true'
      ? await spawnDaemonServer(options)
      : await createInProcessDaemonServer(options);

  try {
    await waitForModelsReady(context, options.modelsReadyTimeoutMs);
  } catch (error) {
    // Clean up the daemon so partial startup (transport, dev-proxy lease,
    // in-process server/workspace/env mutations) does not leak into later tests.
    // For spawned daemons we must signal the child before waitForExit() will
    // resolve; for in-process daemons kill() is a no-op and cleanup runs in
    // waitForExit().
    try {
      context.kill('SIGTERM');
    } catch {
      // Best-effort kill.
    }
    try {
      await context.waitForExit();
    } catch {
      // Best-effort cleanup; preserve the original readiness error.
    }
    throw error;
  }
  return context;
}
