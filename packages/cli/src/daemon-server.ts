import { getDataDir } from '@hyperneo/daemon/lib/data-dir';
import { createDaemonApp } from '@hyperneo/daemon/app';
import { warmupSDKCliBinary } from '@hyperneo/daemon/lib/agent/sdk-cli-resolver';
import type { Config } from '@hyperneo/daemon/config';
import { createLogger, emitStructuredLogEvent } from '@hyperneo/shared';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { embeddedBuiltinSkills } from './embedded-skills';

const log = createLogger('hyperneo:cli:daemon-server');

export async function startDaemonServer(config: Config) {
  log.info('Starting standalone daemon...');

  let isShuttingDown = false;
  let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;
  let sdkWarmupTimer: ReturnType<typeof setTimeout> | undefined;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      log.warn('Forcing exit...');
      process.exit(1);
    }
    isShuttingDown = true;

    daemonContext?.armShutdownFuse();

    if (typeof sdkWarmupTimer !== 'undefined') clearTimeout(sdkWarmupTimer);

    log.info(
      `\nReceived ${signal}, shutting down gracefully... (Press Ctrl+C again to force exit)`
    );

    try {
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
      standalone: true,
      onStructuredLogSinkReady: (flush) => {
        flushStructuredLogs = flush;
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[Daemon] Fatal: Failed to initialize daemon: ${message}`, error);
    emitStructuredLogEvent({
      level: 'fatal',
      args: ['[cli] Daemon startup failed:', error],
      source: 'process',
      module: 'cli:daemon-server',
      metadata: { processEvent: 'startup' },
    });
    await Promise.race([
      flushStructuredLogs(),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]).catch(() => {});
    throw error;
  }

  sdkWarmupTimer = setTimeout(warmupSDKCliBinary, 0);

  log.info(`\nStandalone daemon running!`);
  log.info(`   Host: ${daemonContext.server.hostname}`);
  log.info(`   Port: ${daemonContext.server.port}`);
  log.info(`   WebSocket: ws://${daemonContext.server.hostname}:${daemonContext.server.port}/ws`);
  log.info(`\nPress Ctrl+C to stop\n`);
}
