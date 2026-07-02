#!/usr/bin/env bun
/**
 * Full E2E Coverage Runner
 *
 * This script runs the full 70+ E2E tests with an in-process server to collect
 * BOTH server-side and browser-side coverage.
 *
 * Server coverage: Bun's --coverage instruments daemon/shared code running in-process
 * Browser coverage: Playwright's monocart-reporter collects V8 coverage from browser
 *
 * Usage:
 *   bun --coverage --coverage-reporter=lcov --coverage-dir=coverage \
 *     packages/cli/tests/e2e-coverage/run-full-e2e.ts [playwright-args...]
 *
 * Examples:
 *   # Run all E2E tests with coverage
 *   bun --coverage run-full-e2e.ts
 *
 *   # Run specific test file
 *   bun --coverage run-full-e2e.ts -- tests/session-management.e2e.ts
 *
 *   # Run with headed mode
 *   bun --coverage run-full-e2e.ts -- --headed
 */

import { spawn } from 'child_process';
import { createServer } from 'net';
import { resolve } from 'path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

// Import daemon components - these will be covered by bun --coverage
import { createDaemonApp } from '@hyperneo/daemon/app';
import { getConfig } from '@hyperneo/daemon/config';
import { createWebSocketHandlers } from '@hyperneo/daemon/routes/setup-websocket';

// Server state
let server: ReturnType<typeof Bun.serve> | null = null;
let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;

/**
 * Find an available port dynamically
 */
async function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        srv.close(() => resolvePort(addr.port));
      } else {
        reject(new Error('Failed to get port'));
      }
    });
    srv.on('error', reject);
  });
}

/**
 * Start the in-process daemon server
 */
async function startServer(): Promise<{ port: number; baseUrl: string }> {
  const serverPort = await findAvailablePort();
  const baseUrl = `http://localhost:${serverPort}`;

  console.log(`\n🚀 Starting in-process daemon server on port ${serverPort}...`);

  // Setup workspace
  const workspace = `/tmp/e2e-full-cov-${Date.now()}`;
  await Bun.$`mkdir -p ${workspace}`;

  // Configure
  process.env.HYPERNEO_WORKSPACE_PATH = workspace;
  const config = getConfig();
  config.port = serverPort;
  config.dbPath = `${workspace}/daemon.db`;

  // Create daemon - this imports all daemon code for coverage
  daemonContext = await createDaemonApp({ config, verbose: false, standalone: false });
  daemonContext.server.stop(); // We'll use our own server

  // Web dist path
  const distPath = resolve(import.meta.dir, '../../../web/dist');
  const distExists = await Bun.file(resolve(distPath, 'index.html')).exists();
  if (!distExists) {
    throw new Error('Web dist not found. Run: cd packages/web && bun run build');
  }

  // WebSocket handlers
  const wsHandlers = createWebSocketHandlers(daemonContext.transport, daemonContext.sessionManager);

  // Hono for static files
  const app = new Hono();
  app.use('/*', serveStatic({ root: distPath }));
  app.get('*', async (c) => {
    const html = await Bun.file(resolve(distPath, 'index.html')).text();
    return c.html(html);
  });

  // Start server
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: serverPort,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (srv.upgrade(req, { data: { connectionSessionId: 'global' } })) return;
        return new Response('WebSocket upgrade failed', { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: wsHandlers,
  });

  // Wait for ready
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) break;
    } catch {
      await Bun.sleep(100);
    }
  }

  console.log(`✅ Server ready at ${baseUrl}`);
  return { port: serverPort, baseUrl };
}

/**
 * Stop the server and cleanup
 */
async function stopServer(): Promise<void> {
  console.log('\n🛑 Stopping server and cleanup...');
  server?.stop();
  await daemonContext?.cleanup();
  console.log('✅ Cleanup complete');
}

/**
 * Run Playwright tests
 */
async function runPlaywrightTests(baseUrl: string, args: string[]): Promise<number> {
  const e2eDir = resolve(import.meta.dir, '../../../e2e');

  console.log(`\n🎭 Running Playwright tests against ${baseUrl}...`);
  console.log(`   Working directory: ${e2eDir}`);
  if (args.length > 0) {
    console.log(`   Extra args: ${args.join(' ')}`);
  }

  return new Promise((resolveCode) => {
    const playwrightArgs = ['playwright', 'test', ...args];

    const child = spawn('npx', playwrightArgs, {
      cwd: e2eDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        // Override base URL to use our in-process server
        PLAYWRIGHT_BASE_URL: baseUrl,
        // Enable coverage collection via monocart-reporter
        COVERAGE: 'true',
        // Tell Playwright to reuse the existing server
        PW_TEST_REUSE_CONTEXT: '1',
      },
    });

    child.on('close', (code) => {
      resolveCode(code ?? 1);
    });

    child.on('error', (err) => {
      console.error('Failed to start Playwright:', err);
      resolveCode(1);
    });
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Get Playwright args (everything after --)
  const args = process.argv.slice(2);
  const dashDashIndex = args.indexOf('--');
  const playwrightArgs = dashDashIndex >= 0 ? args.slice(dashDashIndex + 1) : args;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Full E2E Coverage Runner');
  console.log('  Server coverage: Bun --coverage (daemon/shared)');
  console.log('  Browser coverage: Playwright monocart-reporter (web)');
  console.log('═══════════════════════════════════════════════════════════════');

  let exitCode = 1;

  try {
    // Start in-process server
    const { baseUrl } = await startServer();

    // Run Playwright tests
    exitCode = await runPlaywrightTests(baseUrl, playwrightArgs);

    console.log(`\n📊 Playwright exited with code: ${exitCode}`);
  } catch (error) {
    console.error('\n❌ Error:', error);
    exitCode = 1;
  } finally {
    // Cleanup
    await stopServer();
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Coverage reports:');
  console.log('  - Server LCOV: packages/cli/coverage/lcov.info');
  console.log('  - Browser LCOV: packages/e2e/coverage/lcov.info');
  console.log('═══════════════════════════════════════════════════════════════');

  process.exit(exitCode);
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⚠️  Received SIGINT, shutting down...');
  await stopServer();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️  Received SIGTERM, shutting down...');
  await stopServer();
  process.exit(143);
});

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
