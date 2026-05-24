#!/usr/bin/env bun
/**
 * E2E Test Runner with In-Process Server
 *
 * Runs a single Playwright test file with an in-process daemon server
 * to collect both server-side and browser-side coverage.
 *
 * Usage: bun --coverage ./tests/e2e-coverage/e2e-runner.ts <test-file>
 * Example: bun --coverage ./tests/e2e-coverage/e2e-runner.ts session-routing
 */
import { spawn } from 'child_process';
import { createServer } from 'net';
import { resolve } from 'path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

// Import daemon components - instrumented by bun --coverage
import { createDaemonApp } from '@neokai/daemon/app';
import { getConfig } from '@neokai/daemon/config';
import { createWebSocketHandlers } from '@neokai/daemon/routes/setup-websocket';

// Server state
let server: ReturnType<typeof Bun.serve> | null = null;
let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;

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

async function startServer(): Promise<{ port: number; baseUrl: string }> {
  const serverPort = await findAvailablePort();
  const baseUrl = `http://localhost:${serverPort}`;

  console.log(`\n🚀 Starting in-process server on port ${serverPort}...`);

  // Setup workspace
  const workspace = `/tmp/e2e-runner-${Date.now()}`;
  await Bun.$`mkdir -p ${workspace}`;

  // Configure
  process.env.NEOKAI_WORKSPACE_PATH = workspace;
  const config = getConfig();
  config.port = serverPort;
  config.dbPath = `${workspace}/daemon.db`;

  // Create daemon
  daemonContext = await createDaemonApp({ config, verbose: false, standalone: false });
  daemonContext.server.stop();

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

async function stopServer(): Promise<void> {
  console.log('\n🛑 Stopping server...');
  server?.stop();
  await daemonContext?.cleanup();
  console.log('✅ Cleanup complete');
}

async function findTestFile(testFile: string, e2eDir: string): Promise<string> {
  // Check possible locations for the test file
  const locations = [
    `tests/${testFile}.e2e.ts`,
    `tests/serial/${testFile}.e2e.ts`,
    `tests/read-only/${testFile}.e2e.ts`,
  ];

  for (const location of locations) {
    const fullPath = resolve(e2eDir, location);
    const exists = await Bun.file(fullPath).exists();
    if (exists) {
      return location;
    }
  }

  // Default to main tests directory if not found
  return `tests/${testFile}.e2e.ts`;
}

async function runPlaywrightTest(baseUrl: string, testFile: string): Promise<number> {
  const e2eDir = resolve(import.meta.dir, '../../../e2e');
  const testPath = await findTestFile(testFile, e2eDir);

  console.log(`\n🎭 Running Playwright test: ${testPath}`);

  return new Promise((resolveCode) => {
    const child = spawn('npx', ['playwright', 'test', testPath], {
      cwd: e2eDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: baseUrl,
        COVERAGE: 'true',
        PW_TEST_REUSE_CONTEXT: '1',
      },
    });

    child.on('close', (code) => resolveCode(code ?? 1));
    child.on('error', (err) => {
      console.error('Failed to start Playwright:', err);
      resolveCode(1);
    });
  });
}

async function main(): Promise<number> {
  const testFile = process.argv[2];
  if (!testFile) {
    console.error('Usage: bun ./tests/e2e-coverage/e2e-runner.ts <test-file>');
    console.error('Example: bun ./tests/e2e-coverage/e2e-runner.ts session-routing');
    return 1;
  }

  let exitCode = 1;

  try {
    const { baseUrl } = await startServer();
    exitCode = await runPlaywrightTest(baseUrl, testFile);
  } catch (error) {
    console.error('\n❌ Error:', error);
    exitCode = 1;
  } finally {
    await stopServer();
  }

  return exitCode;
}

process.on('SIGINT', async () => {
  await stopServer();
  // Use exitCode to allow coverage to be written
  process.exitCode = 130;
});

process.on('SIGTERM', async () => {
  await stopServer();
  // Use exitCode to allow coverage to be written
  process.exitCode = 143;
});

// Use process.exitCode instead of process.exit() to allow Bun to write coverage
// Then force exit after a short delay to prevent hanging from open handles
main()
  .then((code) => {
    process.exitCode = code;
    // Give Bun time to write coverage, then force exit
    setTimeout(() => {
      console.log('⏱️ Force exiting to prevent hang...');
      process.exit(code);
    }, 2000);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 2000);
  });
