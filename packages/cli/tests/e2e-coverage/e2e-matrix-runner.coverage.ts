#!/usr/bin/env bun

import { beforeAll, afterAll, test, describe } from 'bun:test';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { resolve } from 'path';

import { createDaemonApp } from '@hyperneo/daemon/app';
import { getConfig } from '@hyperneo/daemon/config';
import { createWebSocketHandlers } from '@hyperneo/daemon/routes/setup-websocket';

const TEST_NAME = process.env.TEST_NAME || 'archive-menu-option';

let server: ReturnType<typeof Bun.serve> | null = null;
let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;
let serverPort: number;
let baseUrl: string;

describe(`E2E Matrix: ${TEST_NAME}`, () => {
  beforeAll(async () => {
    serverPort = await findAvailablePort();
    baseUrl = `http://localhost:${serverPort}`;
    console.log(`\n🚀 Starting E2E coverage server on port ${serverPort}...`);

    const workspace = `/tmp/e2e-matrix-${TEST_NAME}-${Date.now()}`;
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

    const wsHandlers = createWebSocketHandlers(
      daemonContext.transport,
      daemonContext.sessionManager
    );

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

    console.log(`✅ Server ready at ${baseUrl}\n`);
  }, 60000);

  afterAll(async () => {
    console.log('\n🛑 Cleanup...');

    if (server) {
      server.stop();
    }
    if (daemonContext) {
      await daemonContext.cleanup();
    }

    console.log('✅ Done');
  }, 30000);

  test(`runs ${TEST_NAME} E2E test`, async () => {
    const e2eDir = resolve(import.meta.dir, '../../../e2e');
    const testPath = await findTestFile(TEST_NAME, e2eDir);

    console.log(`🎭 Running Playwright test: ${testPath}`);

    const exitCode = await new Promise<number>((resolveCode) => {
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

    if (exitCode !== 0) {
      throw new Error(`Playwright test failed with exit code ${exitCode}`);
    }
  }, 300000);
});

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

async function findTestFile(testName: string, e2eDir: string): Promise<string> {
  const locations = [
    `tests/${testName}.e2e.ts`,
    `tests/serial/${testName}.e2e.ts`,
    `tests/read-only/${testName}.e2e.ts`,
  ];

  for (const location of locations) {
    const fullPath = resolve(e2eDir, location);
    const exists = await Bun.file(fullPath).exists();
    if (exists) {
      return location;
    }
  }

  return `tests/${testName}.e2e.ts`;
}
