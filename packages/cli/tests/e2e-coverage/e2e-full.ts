#!/usr/bin/env bun

import { spawn } from 'child_process';
import { createServer } from 'net';
import { resolve } from 'path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

import { createDaemonApp } from '@hyperneo/daemon/app';
import { getConfig } from '@hyperneo/daemon/config';
import { createWebSocketHandlers } from '@hyperneo/daemon/routes/setup-websocket';

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

  console.log(`\n🚀 Starting in-process daemon server on port ${serverPort}...`);

  const workspace = `/tmp/e2e-full-cov-${Date.now()}`;
  await Bun.$`mkdir -p ${workspace}`;

  process.env.HYPERNEO_WORKSPACE_PATH = workspace;
  const config = getConfig();
  config.port = serverPort;
  config.dbPath = `${workspace}/daemon.db`;

  daemonContext = await createDaemonApp({ config, verbose: false, standalone: false });
  daemonContext.server.stop();

  const distPath = resolve(import.meta.dir, '../../../web/dist');
  const distExists = await Bun.file(resolve(distPath, 'index.html')).exists();
  if (!distExists) {
    throw new Error('Web dist not found. Run: cd packages/web && bun run build');
  }

  const wsHandlers = createWebSocketHandlers(daemonContext.transport, daemonContext.sessionManager);

  const app = new Hono();
  app.use('/*', serveStatic({ root: distPath }));
  app.get('*', async (c) => {
    const html = await Bun.file(resolve(distPath, 'index.html')).text();
    return c.html(html);
  });

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
  console.log('\n🛑 Stopping server and cleanup...');
  server?.stop();
  await daemonContext?.cleanup();
  console.log('✅ Cleanup complete');
}

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
        PLAYWRIGHT_BASE_URL: baseUrl,
        COVERAGE: 'true',
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

async function main(): Promise<void> {
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
    const { baseUrl } = await startServer();

    exitCode = await runPlaywrightTests(baseUrl, playwrightArgs);

    console.log(`\n📊 Playwright exited with code: ${exitCode}`);
  } catch (error) {
    console.error('\n❌ Error:', error);
    exitCode = 1;
  } finally {
    await stopServer();
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Coverage reports:');
  console.log('  - Server LCOV: packages/cli/coverage/lcov.info');
  console.log('  - Browser LCOV: packages/e2e/coverage/lcov.info');
  console.log('═══════════════════════════════════════════════════════════════');

  process.exit(exitCode);
}

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

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
