import { getDataDir } from '@hyperneo/daemon/lib/data-dir';
import { createDaemonApp } from '@hyperneo/daemon/app';
import { warmupSDKCliBinary } from '@hyperneo/daemon/lib/agent/sdk-cli-resolver';
import type { Config } from '@hyperneo/daemon/config';
import { createHttpWsServer, type ServerHandle } from '@hyperneo/daemon/lib/runtime-server';
import { createLogger, emitStructuredLogEvent } from '@hyperneo/shared';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import {
  createCorsPreflightResponse,
  isWebSocketPath,
  createJsonErrorResponse,
  shouldHaveImmutableCache,
  isHtmlFile,
} from './cli-utils.ts';
import { embeddedAssets, embeddedBuiltinSkills } from './embedded-assets';

const log = createLogger('hyperneo:cli:prod-server');

export async function startProdServer(config: Config) {
  log.info('Starting production server...');

  let isShuttingDown = false;
  let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;
  let server: ServerHandle | null = null;
  let sdkWarmupTimer: ReturnType<typeof setTimeout> | undefined;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      log.warn('Forcing exit...');
      process.exit(1);
    }
    isShuttingDown = true;

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

  if (embeddedBuiltinSkills.size > 0) {
    const neoSkillsDir = join(getDataDir(), 'skills');
    for (const [relativePath, filePath] of embeddedBuiltinSkills) {
      const dest = join(neoSkillsDir, relativePath);
      const exists = await access(dest)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        await mkdir(dirname(dest), { recursive: true });
        const content = await readFile(filePath, 'utf8');
        await writeFile(dest, content);
      }
    }
    log.info(`Extracted ${embeddedBuiltinSkills.size} built-in skill files to ${neoSkillsDir}`);
  }

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

  const { createWebSocketHandlers } = await import('@hyperneo/daemon/routes/setup-websocket');
  const wsHandlers = createWebSocketHandlers(daemonContext.transport, daemonContext.sessionManager);

  const indexAsset = embeddedAssets.get('/index.html');
  let indexHtmlContent: string | null = null;
  if (indexAsset) {
    indexHtmlContent = await readFile(indexAsset.filePath, 'utf8');
  }

  log.info(`Serving ${embeddedAssets.size} embedded web assets`);

  server = await createHttpWsServer({
    hostname: config.host,
    port: config.port,

    async fetch(req, upgrade) {
      const url = new URL(req.url);

      if (req.method === 'OPTIONS') {
        return createCorsPreflightResponse();
      }

      if (isWebSocketPath(url.pathname)) {
        const upgradeResponse = upgrade(req, {
          connectionSessionId: 'global',
        });

        if (upgradeResponse) {
          return upgradeResponse;
        }

        return new Response('WebSocket upgrade failed', { status: 500 });
      }

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

        return new Response(
          Readable.toWeb(createReadStream(asset.filePath)) as unknown as ReadableStream,
          { headers }
        );
      }

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

    onError(error) {
      log.error('Server error:', error);
      return createJsonErrorResponse(error instanceof Error ? error.message : String(error));
    },
  });

  sdkWarmupTimer = setTimeout(warmupSDKCliBinary, 0);

  log.info(`\nProduction server running!`);
  log.info(`   UI: http://localhost:${config.port}`);
  log.info(`   WebSocket: ws://localhost:${config.port}/ws`);
  log.info(`\nPress Ctrl+C to stop\n`);
}
