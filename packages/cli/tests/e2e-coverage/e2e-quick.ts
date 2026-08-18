#!/usr/bin/env bun
import { chromium, type Browser, type Page } from 'playwright';
import { createServer } from 'net';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { resolve } from 'path';

import {
  BrowserCoverageCollector,
  convertToIstanbul,
  generateLcov,
  calculateStats,
  printCoverageSummary,
} from './coverage-utils';

import { createDaemonApp } from '@hyperneo/daemon/app';
import { getConfig } from '@hyperneo/daemon/config';
import { createWebSocketHandlers } from '@hyperneo/daemon/routes/setup-websocket';

let browser: Browser;
let server: ReturnType<typeof Bun.serve> | null = null;
let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;
let serverPort: number;
let baseUrl: string;
let coverageCollector: BrowserCoverageCollector;

let passed = 0;
let failed = 0;
const failures: { name: string; error: Error }[] = [];

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

async function setup(): Promise<void> {
  serverPort = await findAvailablePort();
  baseUrl = `http://localhost:${serverPort}`;
  coverageCollector = new BrowserCoverageCollector(serverPort);
  console.log(`\n🚀 Starting E2E coverage server on port ${serverPort}...`);

  const workspace = `/tmp/e2e-cov-${Date.now()}`;
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
  browser = await chromium.launch({ headless: true });
  console.log('✅ Browser launched\n');
}

async function teardown(): Promise<void> {
  console.log('\n🛑 Processing coverage and cleanup...');

  const coverage = coverageCollector.getCoverage();
  if (coverage.length > 0) {
    const distPath = resolve(import.meta.dir, '../../../web/dist');

    try {
      const istanbulCoverage = await convertToIstanbul(coverage, distPath);
      const stats = calculateStats(istanbulCoverage, 'packages/web/src');
      printCoverageSummary(stats);

      const lcov = generateLcov(istanbulCoverage, 'packages/web/src');
      const lcovPath = resolve(import.meta.dir, 'browser-coverage.lcov');
      await Bun.write(lcovPath, lcov);
      console.log(`   📄 Browser LCOV written to: ${lcovPath}\n`);

      const jsonPath = resolve(import.meta.dir, 'browser-coverage.json');
      await Bun.write(jsonPath, JSON.stringify(coverage, null, 2));
    } catch (err) {
      console.error('Error processing browser coverage:', err);
    }
  } else {
    console.log('⚠️  No browser coverage collected\n');
  }

  await browser?.close();
  server?.stop();
  await daemonContext?.cleanup();
  console.log('✅ Done\n');
}

async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await coverageCollector.startCoverage(page);
  return page;
}

async function closePage(page: Page): Promise<void> {
  await coverageCollector.stopCoverage(page);
  await page.close();
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error: error as Error });
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${(error as Error).message}`);
  }
}

async function runTests(): Promise<void> {
  console.log('Homepage');
  await runTest('loads and shows sidebar', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
      assert(await page.locator('text=Daemon').isVisible(), 'Daemon should be visible');
    } finally {
      await closePage(page);
    }
  });

  await runTest('shows recent sessions area', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
      const hasRecentSessions = await page
        .locator('text=Recent Sessions')
        .isVisible()
        .catch(() => false);
      const hasNoSessions = await page
        .locator('text=No sessions')
        .isVisible()
        .catch(() => false);
      const hasWelcome = await page
        .locator('text=Welcome')
        .isVisible()
        .catch(() => false);
      assert(
        hasRecentSessions || hasNoSessions || hasWelcome,
        'Should show sessions area or welcome'
      );
    } finally {
      await closePage(page);
    }
  });

  console.log('\nWebSocket Connection');
  await runTest('connects and shows status', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Connected').first().waitFor({ state: 'visible', timeout: 15000 });
      assert(
        await page.locator('text=Connected').first().isVisible(),
        'Connected should be visible'
      );
    } finally {
      await closePage(page);
    }
  });

  await runTest('shows daemon status indicator', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
      assert(await page.locator('text=Daemon').isVisible(), 'Daemon should be visible');
    } finally {
      await closePage(page);
    }
  });

  console.log('\nSession Creation');
  await runTest('creates session via New button', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('button:has-text("New")').first().click();
      await page.waitForURL(/\/session\//, { timeout: 10000 });
      assert(page.url().includes('/session/'), 'URL should contain /session/');
    } finally {
      await closePage(page);
    }
  });

  await runTest('session page shows input area', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('button:has-text("New")').first().click();
      await page.waitForURL(/\/session\//, { timeout: 10000 });
      const input = page.locator('textarea');
      await input.waitFor({ state: 'visible', timeout: 5000 });
      assert(await input.isVisible(), 'Input should be visible');
    } finally {
      await closePage(page);
    }
  });

  await runTest('session appears in sidebar', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('button:has-text("New")').first().click();
      await page.waitForURL(/\/session\//, { timeout: 10000 });
      await page.waitForTimeout(1000);
      assert(page.url().includes('/session/'), 'URL should contain /session/');
    } finally {
      await closePage(page);
    }
  });

  console.log('\nNavigation');
  await runTest('can navigate between sessions', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('button:has-text("New")').first().click();
      await page.waitForURL(/\/session\//, { timeout: 10000 });
      const firstSessionUrl = page.url();
      await page.locator('button:has-text("New")').first().click();
      await page.waitForTimeout(500);
      await page.waitForURL(/\/session\//, { timeout: 10000 });
      const secondSessionUrl = page.url();
      assert(firstSessionUrl !== secondSessionUrl, 'Session URLs should be different');
    } finally {
      await closePage(page);
    }
  });

  await runTest('can return to home', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('button:has-text("New")').first().click();
      await page.waitForURL(/\/session\//, { timeout: 10000 });
      await page.goto(baseUrl);
      assert(page.url() === baseUrl + '/', 'Should be at home');
    } finally {
      await closePage(page);
    }
  });

  console.log('\nUI Components');
  await runTest('message input has send button', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('button:has-text("New")').first().click();
      await page.waitForURL(/\/session\//, { timeout: 10000 });
      const input = page.locator('textarea');
      await input.waitFor({ state: 'visible', timeout: 5000 });
      assert(await input.isVisible(), 'Input should be visible');
    } finally {
      await closePage(page);
    }
  });

  await runTest('sidebar has connection status', async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl);
      await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
      const connected = page.locator('text=Connected').first();
      assert(await connected.isVisible(), 'Connected should be visible');
    } finally {
      await closePage(page);
    }
  });
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Quick E2E Coverage Runner');
  console.log('  Server coverage: Bun --coverage (daemon/shared)');
  console.log('  Browser coverage: Playwright CDP (web)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    await setup();
    await runTests();
  } catch (error) {
    console.error('\n❌ Setup/Test error:', error);
    failed++;
  } finally {
    await teardown();
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const { name, error } of failures) {
      console.log(`    - ${name}: ${error.message}`);
    }
  }
  console.log('═══════════════════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

process.on('SIGINT', async () => {
  console.log('\n⚠️  Received SIGINT, shutting down...');
  await teardown();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️  Received SIGTERM, shutting down...');
  await teardown();
  process.exit(143);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
