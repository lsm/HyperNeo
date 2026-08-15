// IMPORTANT: Import config first to ensure credential discovery runs
// before any other modules (like provider-service) that depend on it.

import { createDaemonApp } from './src/app';
import { getConfig } from './src/config';
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

// Create daemon app in standalone mode
const app = await createDaemonApp({
  config,
  verbose: true,
  standalone: true, // Show root info route in standalone mode
});
const { server, cleanup } = app;
flushStructuredLogs = app.flushStructuredLogs;

// Server is already listening
console.log(`\n🚀 HyperNeo Daemon started!`);
console.log(`   Host: ${server.hostname}`);
console.log(`   Port: ${server.port}`);
console.log(`   Model: ${config.defaultModel}`);
console.log(`\n📡 WebSocket: ws://${server.hostname}:${server.port}/ws`);
console.log(`\n✨ MessageHub mode! Unified RPC + Pub/Sub over WebSocket.`);
console.log(`   Session routing via message.sessionId field.\n`);

// Graceful shutdown - second Ctrl+C exits immediately
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    // Second Ctrl+C - force exit immediately
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

// Register shutdown handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
