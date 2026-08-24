import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { createDaemonApp } from '@hyperneo/daemon/app';
import type { Config } from '@hyperneo/daemon/config';
import { warmupSDKCliBinary } from '@hyperneo/daemon/lib/agent/sdk-cli-resolver';
import { resolve } from 'path';
import { createLogger, emitStructuredLogEvent } from '@hyperneo/shared';
import {
  createCorsPreflightResponse,
  isWebSocketPath,
  createJsonErrorResponse,
  shouldHaveImmutableCache,
  isHtmlFile,
  printServerUrls,
} from './cli-utils.ts';

const log = createLogger('hyperneo:cli:prod-server');

export async function startProdServer(config: Config) {
  log.info('🚀 Starting production server...');

  let isShuttingDown = false;
  let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;
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
        log.info('🛑 Stopping server...');
        server.stop();
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
      module: 'cli:prod-server',
      metadata: { processEvent: 'startup' },
    });
    await Promise.race([
      flushStructuredLogs(),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]).catch(() => {});
    throw error;
  }

  daemonContext.server.stop();

  log.info('Room orchestration is handled by RoomAgentService');

  const distPath = resolve(import.meta.dir, '../../web/dist');
  log.info(`📦 Serving static files from: ${distPath}`);

  const { createWebSocketHandlers } = await import('@hyperneo/daemon/routes/setup-websocket');
  const wsHandlers = createWebSocketHandlers(daemonContext.transport, daemonContext.sessionManager);

  const app = new Hono();

  app.use(
    '/*',
    serveStatic({
      root: distPath,
      precompressed: true,
      onFound: (path, c) => {
        if (shouldHaveImmutableCache(path)) {
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (isHtmlFile(path)) {
          c.header('Cache-Control', 'no-cache');
        }
      },
    })
  );

  app.get('*', async (c) => {
    const html = await Bun.file(resolve(distPath, 'index.html')).text();
    return c.html(html, {
      headers: {
        'Cache-Control': 'no-cache',
      },
    });
  });

  server = Bun.serve({
    hostname: config.host,
    port: config.port,

    async fetch(req, server) {
      const url = new URL(req.url);

      if (req.method === 'OPTIONS') {
        return createCorsPreflightResponse();
      }

      if (isWebSocketPath(url.pathname)) {
        const upgraded = server.upgrade(req, {
          data: {
            connectionSessionId: 'global',
          },
        });

        if (upgraded) {
          return;
        }

        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      return app.fetch(req);
    },

    websocket: wsHandlers,

    error(error) {
      log.error('Server error:', error);
      return createJsonErrorResponse(error instanceof Error ? error.message : String(error));
    },
  });

  sdkWarmupTimer = setTimeout(warmupSDKCliBinary, 0);

  console.log(`\n✨ Production server running!`);
  printServerUrls(config.port, config.host);
  console.log(`\n📝 Press Ctrl+C to stop\n`);
}
