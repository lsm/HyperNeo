import { getDataDir } from '@hyperneo/daemon/lib/data-dir';
import { createDaemonApp } from '@hyperneo/daemon/app';
import { warmupSDKCliBinary } from '@hyperneo/daemon/lib/agent/sdk-cli-resolver';
import type { Config } from '@hyperneo/daemon/config';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'path';
import { join } from 'node:path';
import { createLogger, emitStructuredLogEvent } from '@hyperneo/shared';
import {
  findAvailablePort,
  createCorsPreflightResponse,
  isWebSocketPath,
  createJsonErrorResponse,
  printServerUrls,
} from './cli-utils.ts';
import { ensureBuiltinSkills } from './skill-utils.ts';

const log = createLogger('hyperneo:cli:dev-server');

const VITE_CLIENT_SCRIPT_RE =
  /<script\b(?=[^>]*\btype=(["'])module\1)(?=[^>]*\bsrc=(["'])\/@vite\/client\2)[^>]*>\s*<\/script>\s*/i;

function stripViteClientScript(html: string): string {
  return html.replace(VITE_CLIENT_SCRIPT_RE, '');
}

function responseHeadersWithoutContentLength(headers: Headers): Headers {
  const nextHeaders = new Headers(headers);
  nextHeaders.delete('content-length');
  return nextHeaders;
}

const VITE_CLIENT_SHIM = [
  "import '/@vite/env';",
  'const hotData = new Map();',
  'const styleElements = new Map();',
  'export function createHotContext(ownerPath) {',
  '  const data = hotData.get(ownerPath) ?? {};',
  '  hotData.set(ownerPath, data);',
  '  return {',
  '    data,',
  '    accept() {},',
  '    acceptExports() {},',
  '    dispose() {},',
  '    prune() {},',
  '    decline() {},',
  '    invalidate() {},',
  '    on() {},',
  '    off() {},',
  '    send() {},',
  '  };',
  '}',
  'export function updateStyle(id, content) {',
  '  let style = styleElements.get(id);',
  '  if (!style) {',
  '    style = document.querySelector(`style[data-vite-dev-id="${id}"]`);',
  '  }',
  '  if (!style) {',
  "    style = document.createElement('style');",
  "    style.setAttribute('type', 'text/css');",
  "    style.setAttribute('data-vite-dev-id', id);",
  '    document.head.appendChild(style);',
  '  }',
  '  style.textContent = content;',
  '  styleElements.set(id, style);',
  '}',
  'export function removeStyle(id) {',
  '  styleElements.get(id)?.remove();',
  '  styleElements.delete(id);',
  '}',
  'export function injectQuery(url, queryToInject) {',
  "  if (url[0] !== '.' && url[0] !== '/') return url;",
  "  const pathname = url.replace(/[?#].*$/, '');",
  "  const { search, hash } = new URL(url, 'http://vite.dev');",
  "  return `${pathname}${search ? `${search}&${queryToInject.slice(1)}` : queryToInject}${hash || ''}`;",
  '}',
].join('\n');

export async function startDevServer(config: Config) {
  log.info('🔧 Starting unified development server...');

  let isShuttingDown = false;
  let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;
  let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let sdkWarmupTimer: ReturnType<typeof setTimeout> | undefined;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      log.warn('Forcing exit...');
      process.exit(1);
    }
    isShuttingDown = true;

    if (typeof sdkWarmupTimer !== 'undefined') clearTimeout(sdkWarmupTimer);

    log.info(
      `\n👋 Received ${signal}, shutting down gracefully... (Press Ctrl+C again to force exit)`
    );

    try {
      if (server) {
        log.info('🛑 Stopping unified server...');
        server.stop();
      }

      if (vite) {
        log.info('🛑 Stopping Vite dev server...');
        await Promise.race([
          vite.close(),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              log.warn('⚠️  Vite close timed out after 3s, continuing...');
              resolve();
            }, 3000);
          }),
        ]);
      }

      if (daemonContext) {
        log.info('🛑 Cleaning up daemon...');
        await Promise.race([
          daemonContext.cleanup(),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              log.warn('⚠️  Daemon cleanup timed out after 5s, continuing...');
              resolve();
            }, 5000);
          }),
        ]);
      }

      log.info('✨ Shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const skillsSourceDir = resolve(import.meta.dir, '../../skills');
  const skillsDestDir = join(getDataDir(), 'skills');
  await ensureBuiltinSkills(skillsSourceDir, skillsDestDir);

  let flushStructuredLogs: () => Promise<void> = () => Promise.resolve();
  try {
    daemonContext = await createDaemonApp({
      config,
      verbose: true,
      standalone: false,
      onStructuredLogSinkReady: (flush) => {
        flushStructuredLogs = flush;
      },
    });
  } catch (error) {
    emitStructuredLogEvent({
      level: 'fatal',
      args: ['[cli] Daemon startup failed:', error],
      source: 'process',
      module: 'cli:dev-server',
      metadata: { processEvent: 'startup' },
    });
    await Promise.race([
      flushStructuredLogs(),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]).catch(() => {});
    throw error;
  }

  log.info('Room orchestration is handled by RoomAgentService');

  daemonContext.server.stop();

  log.info('📦 Starting Vite dev server...');
  const vitePort = await findAvailablePort();
  log.info(`   Found available Vite port: ${vitePort}`);

  vite = await createViteServer({
    configFile: resolve(import.meta.dir, '../../web/vite.config.ts'),
    root: resolve(import.meta.dir, '../../web/src'),
    server: {
      host: '0.0.0.0',
      port: vitePort,
      strictPort: false,
      hmr: false,
    },
  });
  await vite.listen();
  log.info(`✅ Vite dev server running on port ${vitePort}`);

  const { createWebSocketHandlers } = await import('@hyperneo/daemon/routes/setup-websocket');
  const wsHandlers = createWebSocketHandlers(daemonContext.transport, daemonContext.sessionManager);

  server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 255,

    async fetch(req, server) {
      const url = new URL(req.url);

      if (req.method === 'OPTIONS') {
        return createCorsPreflightResponse();
      }

      if (isWebSocketPath(url.pathname)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const upgraded = (server as any).upgrade(req, {
          data: {
            connectionSessionId: 'global',
          },
        });

        if (upgraded) {
          return;
        }

        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      try {
        if (url.pathname === '/@vite/client') {
          return new Response(VITE_CLIENT_SHIM, {
            headers: {
              'content-type': 'text/javascript',
              'cache-control': 'no-cache',
            },
          });
        }

        const viteUrl = `http://localhost:${vitePort}${url.pathname}${url.search}`;

        const fetchOptions: RequestInit = {
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
        };

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          fetchOptions.body = req.body;
          (fetchOptions as Record<string, unknown>).duplex = 'half';
        }

        const viteResponse = await fetch(viteUrl, fetchOptions);
        const contentType = viteResponse.headers.get('content-type') ?? '';

        if (contentType.includes('text/html')) {
          const html = await viteResponse.text();
          return new Response(stripViteClientScript(html), {
            status: viteResponse.status,
            headers: responseHeadersWithoutContentLength(viteResponse.headers),
          });
        }

        return new Response(viteResponse.body, {
          status: viteResponse.status,
          headers: viteResponse.headers,
        });
      } catch (error) {
        log.error('Vite proxy error:', error);
        return new Response('Failed to proxy to Vite', { status: 502 });
      }
    },

    websocket: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bun's WebSocket data is shaped by upgrade()
      open(ws: any) {
        wsHandlers.open(ws);
      },
      message(ws: any, msg: string | Buffer) {
        wsHandlers.message(ws, msg);
      },
      close(ws: any) {
        wsHandlers.close(ws);
      },
    },

    error(error) {
      log.error('Server error:', error);
      return createJsonErrorResponse(error instanceof Error ? error.message : String(error));
    },
  });

  console.log(`\n✨ Unified development server running!`);
  printServerUrls(config.port, config.host);
  console.log(`   🔄 Vite dev transforms enabled; refresh the browser after UI changes`);
  console.log(`\n📝 Press Ctrl+C to stop\n`);
}
