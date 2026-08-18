import { getConfig } from './src/config';
import { createDaemonApp } from './src/app';
import { emitStructuredLogEvent, withConsoleLogCaptureSuppressed } from './src/lib/logger';

let flushStructuredLogs: () => Promise<void> = () => Promise.resolve();
let fatalExitStarted = false;

async function flushFatalLogs(): Promise<void> {
  await Promise.race([
    flushStructuredLogs(),
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]).catch(() => {});
}

process.on('uncaughtException', async (error) => {
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  emitStructuredLogEvent({
    level: 'fatal',
    args: ['[Daemon] Uncaught exception:', error],
    source: 'process',
    module: 'daemon:main',
    metadata: { processEvent: 'uncaughtException' },
  });
  withConsoleLogCaptureSuppressed(() => console.error('[Daemon] Uncaught exception:', error));
  await flushFatalLogs();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  emitStructuredLogEvent({
    level: 'fatal',
    args: ['[Daemon] Unhandled promise rejection:', reason],
    source: 'process',
    module: 'daemon:main',
    metadata: { processEvent: 'unhandledRejection' },
  });
  withConsoleLogCaptureSuppressed(() =>
    console.error('[Daemon] Unhandled promise rejection:', reason)
  );
  await flushFatalLogs();
  process.exit(1);
});

const config = getConfig();

let app: Awaited<ReturnType<typeof createDaemonApp>>;
try {
  app = await createDaemonApp({
    config,
    verbose: true,
    standalone: true,
    onStructuredLogSinkReady: (flush) => {
      flushStructuredLogs = flush;
    },
  });
} catch (error) {
  emitStructuredLogEvent({
    level: 'fatal',
    args: ['[Daemon] Startup failed:', error],
    source: 'process',
    module: 'daemon:main',
    metadata: { processEvent: 'startup' },
  });
  withConsoleLogCaptureSuppressed(() => console.error('[Daemon] Startup failed:', error));
  await flushFatalLogs();
  process.exit(1);
}
const { server, cleanup } = app;

console.log(`\n🚀 HyperNeo Daemon started!`);
console.log(`   Host: ${server.hostname}`);
console.log(`   Port: ${server.port}`);
console.log(`   Model: ${config.defaultModel}`);
console.log(`\n📡 WebSocket: ws://${server.hostname}:${server.port}/ws`);
console.log(`\n✨ MessageHub mode! Unified RPC + Pub/Sub over WebSocket.`);
console.log(`   Session routing via message.sessionId field.\n`);

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.warn('⚠️  Forcing exit...');
    process.exit(1);
  }
  isShuttingDown = true;

  console.log(
    `\n👋 Received ${signal}, shutting down gracefully... (Press Ctrl+C again to force exit)`
  );

  try {
    await cleanup();
    console.log('\n✅ Graceful shutdown complete\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
