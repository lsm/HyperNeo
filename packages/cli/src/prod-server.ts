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
} from './cli-utils';

const log = createLogger('hyperneo:cli:prod-server');

export async function startProdServer(config: Config) {
  log.info('🚀 Starting production server...');

  // Register signal handlers FIRST, before any async operations
  // This ensures Ctrl+C works even if startup hangs
  let isShuttingDown = false;
  let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let sdkWarmupTimer: ReturnType<typeof setTimeout> | undefined;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      // Second Ctrl+C - force exit immediately
      log.warn('Forcing exit...');
      process.exit(1);
    }
    isShuttingDown = true;

    // Cancel pending SDK warmup if shutting down early
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
        // Add timeout for daemon cleanup
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

  // Create daemon app (returns Bun server)
  // Sink-ready wiring + startup-failure flush mirror packages/daemon/main.ts
  // and prod-server-embedded.ts so a CLI startup rejection persists to the
  // structured log file before the process exits. (Codex P2, PR #2499.)
  let flushStructuredLogs: () => Promise<void> = () => Promise.resolve();
  try {
    daemonContext = await createDaemonApp({
      config,
      verbose: true,
      standalone: false, // Skip root info route in embedded mode
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

  // Stop the daemon's internal server (we'll create a unified one)
  daemonContext.server.stop();

  log.info('Room orchestration is handled by RoomAgentService');

  // Get path to web dist folder
  const distPath = resolve(import.meta.dir, '../../web/dist');
  log.info(`📦 Serving static files from: ${distPath}`);

  // Get WebSocket handlers from daemon
  const { createWebSocketHandlers } = await import('@hyperneo/daemon/routes/setup-websocket');
  const wsHandlers = createWebSocketHandlers(daemonContext.transport, daemonContext.sessionManager);

  // Create Hono app for static file serving
  const app = new Hono();

  // Serve static files with compression and caching
  app.use(
    '/*',
    serveStatic({
      root: distPath,
      // Pre-compressed file support (serves .br, .gz based on Accept-Encoding)
      precompressed: true,
      // Cache headers for production assets
      onFound: (path, c) => {
        // Cache static assets aggressively (immutable files with content hashes)
        if (shouldHaveImmutableCache(path)) {
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
        // Don't cache HTML (for SPA updates)
        else if (isHtmlFile(path)) {
          c.header('Cache-Control', 'no-cache');
        }
      },
    })
  );

  // SPA fallback - serve index.html for client-side routes
  app.get('*', async (c) => {
    const html = await Bun.file(resolve(distPath, 'index.html')).text();
    return c.html(html, {
      headers: {
        'Cache-Control': 'no-cache',
      },
    });
  });

  // Create unified server with daemon + Hono static files
  server = Bun.serve({
    hostname: config.host,
    port: config.port,

    async fetch(req, server) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return createCorsPreflightResponse();
      }

      // WebSocket upgrade at /ws (daemon WebSocket)
      if (isWebSocketPath(url.pathname)) {
        const upgraded = server.upgrade(req, {
          data: {
            connectionSessionId: 'global',
          },
        });

        if (upgraded) {
          return; // WebSocket upgrade successful
        }

        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      // Delegate all other requests to Hono for static file serving
      return app.fetch(req);
    },

    websocket: wsHandlers,

    error(error) {
      log.error('Server error:', error);
      return createJsonErrorResponse(error instanceof Error ? error.message : String(error));
    },
  });

  // Warm up SDK CLI binary after unified server is bound.
  // Non-fatal: download failure only means first query retries resolution.
  sdkWarmupTimer = setTimeout(warmupSDKCliBinary, 0);

  console.log(`\n✨ Production server running!`);
  printServerUrls(config.port, config.host);
  console.log(`\n📝 Press Ctrl+C to stop\n`);
}
