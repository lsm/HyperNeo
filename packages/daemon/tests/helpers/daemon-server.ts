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
  port?: number;

  env?: Record<string, string>;

  devProxy?: DevProxyOptions;

  useDevProxy?: boolean;

  workspacePath?: string;

  modelsReadyTimeoutMs?: number;
}

export interface DaemonServerContext {
  pid: number;

  messageHub: MessageHub;

  baseUrl: string;

  kill: (signal?: NodeJS.Signals) => boolean;

  waitForExit: () => Promise<void>;

  trackSession: (sessionId: string) => void;

  cleanup: () => Promise<void>;

  devProxy: DevProxyController | null;

  workspacePath?: string;

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
  return process.env.HYPERNEO_DEV_PROXY_REUSE !== '0';
}

function getSharedDevProxyIdleTtlMs(): number {
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
    setEnvVars: false,
    ...devProxyOptions,
  });

  try {
    await devProxy.start();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Dev Proxy is required for this test run but failed to start on ${devProxyBaseUrl}. ` +
        `Error: ${errorMessage}`
    );
  }

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
      await devProxy.stop();
      devProxy.restoreEnv();
    },
  };
}

async function spawnDaemonServer(options: DaemonServerOptions = {}): Promise<DaemonServerContext> {
  const {
    port: userPort = 0,
    env: customEnv = {},
    devProxy: devProxyOptions,
    useDevProxy = false,
  } = options;

  const shouldUseDevProxy = useDevProxy || process.env.HYPERNEO_USE_DEV_PROXY === '1';
  const devProxyPort = getDevProxyPort(devProxyOptions);
  const devProxyBaseUrl = `http://127.0.0.1:${devProxyPort}`;
  const devProxyLease = await acquireDevProxyLease(shouldUseDevProxy, devProxyOptions);
  const devProxy = devProxyLease.controller;

  const serverPath = path.join(__dirname, 'standalone-server.ts');

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

  const repoRoot = path.resolve(__dirname, '../../../..');
  const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const daemonProcess = spawn(process.execPath, [tsxBin, serverPath], {
    env: daemonEnv,
    stdio: 'pipe',
    detached: false,
  });

  let hasExited = false;
  daemonProcess.once('exit', () => {
    hasExited = true;
  });

  let stderrOutput = '';
  let stdoutOutput = '';
  let actualPort = userPort;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Daemon server startup timeout')), 20000);
    let portResolved = false;

    const onData = (data: Buffer) => {
      const output = data.toString();
      stderrOutput += output;
      stdoutOutput += output;
      if (process.env.TEST_VERBOSE) {
        console.error(`[DAEMON-PROCESS] ${output.trim()}`);
      }
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

  const wsUrl = `ws://127.0.0.1:${actualPort}/ws`;
  const transport = new WebSocketClientTransport({
    url: wsUrl,
    autoReconnect: false,
  });

  const messageHub = new MessageHub({
    defaultSessionId: 'global',
  });

  messageHub.registerTransport(transport);
  await transport.initialize();

  const trackedSessions: string[] = [];

  const cleanup = async () => {
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
    getCapturedOutput: () => stdoutOutput,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => daemonProcess.kill(signal),
    waitForExit: async () => {
      await cleanup();
      await new Promise<void>((resolve) => {
        if (hasExited) {
          resolve();
          return;
        }
        daemonProcess.once('exit', () => resolve());
      });
      await devProxyLease.release();
    },
    trackSession: (sessionId: string) => {
      trackedSessions.push(sessionId);
    },
    cleanup,
  };
}

async function createInProcessDaemonServer(
  options: DaemonServerOptions = {}
): Promise<DaemonServerContext & { daemonContext: DaemonAppContext }> {
  const {
    port: userPort = 0,
    env: customEnv = {},
    devProxy: devProxyOptions,
    useDevProxy = false,
    workspacePath: externalWorkspacePath,
  } = options;

  const shouldUseDevProxy = useDevProxy || process.env.HYPERNEO_USE_DEV_PROXY === '1';
  const devProxyPort = getDevProxyPort(devProxyOptions);
  const devProxyBaseUrl = `http://127.0.0.1:${devProxyPort}`;
  const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalClaudeCodeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const devProxyLease = await acquireDevProxyLease(shouldUseDevProxy, devProxyOptions);
  const devProxy = devProxyLease.controller;

  const originalCustomEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(customEnv)) {
    originalCustomEnv[key] = process.env[key];
  }

  for (const [key, value] of Object.entries(customEnv)) {
    process.env[key] = value;
  }
  if (shouldUseDevProxy) {
    process.env.ANTHROPIC_BASE_URL = devProxyBaseUrl;
    process.env.ANTHROPIC_API_KEY = 'sk-devproxy-test-key';
    process.env.ANTHROPIC_AUTH_TOKEN = '';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
  }

  process.env.NODE_ENV = 'test';
  if (!process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS) {
    process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = '30000';
  }

  const workspace =
    externalWorkspacePath ??
    `/tmp/daemon-online-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const isExternalWorkspace = !!externalWorkspacePath;
  if (!isExternalWorkspace) {
    mkdirSync(workspace, { recursive: true });
  }

  if (!process.env.TEST_WORKTREE_BASE_DIR) {
    process.env.TEST_WORKTREE_BASE_DIR = `/tmp/daemon-worktrees-${Date.now()}`;
  }

  process.env.HYPERNEO_WORKSPACE_PATH = workspace;
  const config = getConfig();
  config.port = userPort;
  config.dbPath = `${workspace}/daemon.db`;

  const daemonContext = await createDaemonApp({
    config,
    verbose: false,
    standalone: false,
  });

  if (process.env.HYPERNEO_TEST_DISABLE_SANDBOX === '1') {
    const current = daemonContext.settingsManager.getGlobalSettings();
    daemonContext.settingsManager.updateGlobalSettings({
      sandbox: {
        ...(current.sandbox ?? {}),
        enabled: false,
      },
    });
  }

  const actualPort = daemonContext.server.port;

  const wsUrl = `ws://127.0.0.1:${actualPort}/ws`;
  const transport = new WebSocketClientTransport({
    url: wsUrl,
    autoReconnect: false,
  });

  const messageHub = new MessageHub({
    defaultSessionId: 'global',
  });

  messageHub.registerTransport(transport);
  await transport.initialize();

  const trackedSessions: string[] = [];

  const cleanup = async () => {
    for (const sessionId of trackedSessions) {
      try {
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
    pid: process.pid,
    messageHub,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    daemonContext,
    devProxy,
    workspacePath: workspace,
    getCapturedOutput: () => '',
    kill: () => {
      return true;
    },
    waitForExit: async () => {
      const cleanupWithTimeout = async () => {
        await cleanup();
        try {
          await transport.close();
        } catch {
          // Transport may already be closed
        }
        await daemonContext.cleanup();
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
        if (!isExternalWorkspace) {
          rmSync(workspace, { recursive: true, force: true });
        }
      }

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
          clearModelsCache('global');
          reject(new Error('Timed out waiting for models cache to populate'));
        }, remainingMs);
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
