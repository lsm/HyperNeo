/**
 * Production server for compiled binary distribution.
 * Serves web assets from Bun-embedded files instead of the filesystem.
 */

import { getDataDir } from '@hyperneo/daemon/lib/data-dir';
import { createDaemonApp } from '@hyperneo/daemon/app';
import { warmupSDKCliBinary } from '@hyperneo/daemon/lib/agent/sdk-cli-resolver';
import type { Config } from '@hyperneo/daemon/config';
import { createLogger, emitStructuredLogEvent } from '@hyperneo/shared';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
  createCorsPreflightResponse,
  isWebSocketPath,
  createJsonErrorResponse,
  shouldHaveImmutableCache,
  isHtmlFile,
} from './cli-utils';
import { embeddedAssets, embeddedBuiltinSkills } from './embedded-assets';

const log = createLogger('hyperneo:cli:prod-server');

export async function startProdServer(config: Config) {
  log.info('Starting production server...');

  // Register signal handlers FIRST, before any async operations
  // This ensures Ctrl+C works even if startup hangs
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

    // Cancel pending SDK warmup if shutting down early
    if (typeof sdkWarmupTimer !== 'undefined') clearTimeout(sdkWarmupTimer);

    log.info(
      `\nReceived ${signal}, shutting down gracefully... (Press Ctrl+C again to force exit)`
    );

    try {
      if (server) {
        log.info('Stopping server...');
        server.stop();
      }

      if (daemonContext) {
        log.info('Cleaning up daemon...');
        await Promise.race([
          daemonContext.cleanup(),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              log.warn('Daemon cleanup timed out after 5s, continuing...');
              resolve();
            }, 5000);
          }),
        ]);
      }

      log.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Extract embedded built-in skill files to ~/.hyperneo/skills/.
  // Each key is a relative path like "playwright/SKILL.md"; the full directory
  // structure is preserved. Existing user-customized files are not overwritten.
  if (embeddedBuiltinSkills.size > 0) {
    const neoSkillsDir = join(getDataDir(), 'skills');
    for (const [relativePath, filePath] of embeddedBuiltinSkills) {
      const dest = join(neoSkillsDir, relativePath);
      const exists = await access(dest)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        await mkdir(dirname(dest), { recursive: true });
        const content = await Bun.file(filePath).text();
        await writeFile(dest, content);
      }
    }
    log.info(`Extracted ${embeddedBuiltinSkills.size} built-in skill files to ${neoSkillsDir}`);
  }

  // Create daemon app (returns Bun server). The sink-ready callback wires the
  // real flush before the factory's long-running init so a startup failure is
  // still persisted to the structured log file. (Codex P2, PR #2499.)
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
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[Server] Fatal: Failed to initialize daemon: ${message}`, error);
    // Persist the startup failure and drain the sink before this process
    // exits — nothing else will flush it on this path.
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

  // Get WebSocket handlers from daemon
  const { createWebSocketHandlers } = await import('@hyperneo/daemon/routes/setup-websocket');
  const wsHandlers = createWebSocketHandlers(daemonContext.transport, daemonContext.sessionManager);

  // Pre-load index.html for SPA fallback
  const indexAsset = embeddedAssets.get('/index.html');
  let indexHtmlContent: string | null = null;
  if (indexAsset) {
    indexHtmlContent = await Bun.file(indexAsset.filePath).text();
  }

  log.info(`Serving ${embeddedAssets.size} embedded web assets`);

  // Create unified server serving embedded assets + daemon WebSocket
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
          return;
        }

        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      // Serve embedded static assets
      const asset = embeddedAssets.get(url.pathname);
      if (asset) {
        const headers: Record<string, string> = {
          'Content-Type': asset.mimeType,
        };

        if (shouldHaveImmutableCache(url.pathname)) {
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        } else if (isHtmlFile(url.pathname)) {
          headers['Cache-Control'] = 'no-cache';
        }

        return new Response(Bun.file(asset.filePath), { headers });
      }

      // SPA fallback: serve index.html for unmatched routes
      if (indexHtmlContent) {
        return new Response(indexHtmlContent, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }

      return new Response('Not found', { status: 404 });
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

  log.info(`\nProduction server running!`);
  log.info(`   UI: http://localhost:${config.port}`);
  log.info(`   WebSocket: ws://localhost:${config.port}/ws`);
  log.info(`\nPress Ctrl+C to stop\n`);
}
