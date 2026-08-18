#!/usr/bin/env bun

import { beforeAll, afterAll, test, describe } from 'bun:test';
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

describe('E2E Quick Coverage Tests', () => {
  beforeAll(async () => {
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

    console.log(`✅ Server ready at ${baseUrl}`);
    browser = await chromium.launch({ headless: true });
    console.log('✅ Browser launched\n');
  }, 60000);

  afterAll(async () => {
    console.log('\n🛑 Processing coverage and cleanup...');

    const coverage = coverageCollector.getCoverage();
    if (coverage.length > 0) {
      const distPath = resolve(import.meta.dir, '../../../web/dist');

      try {
        const istanbulCoverage = await convertToIstanbul(coverage, distPath);

        const filterPath = 'packages/web/src';

        const stats = calculateStats(istanbulCoverage, filterPath);

        printCoverageSummary(stats);

        const lcovContent = generateLcov(istanbulCoverage, filterPath);

        const outputPath = resolve(import.meta.dir, 'browser-coverage.lcov');
        await Bun.write(outputPath, lcovContent);
        console.log(`\n   📄 Browser LCOV written to: ${outputPath}`);
      } catch (error) {
        console.error('   ❌ Error processing browser coverage:', error);
      }
    } else {
      console.log('   ⚠️  No browser coverage collected');
    }

    if (browser) {
      await browser.close();
    }
    if (server) {
      server.stop();
    }
    if (daemonContext) {
      await daemonContext.cleanup();
    }

    console.log('✅ Done');
  }, 30000);

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

  describe('Homepage', () => {
    test('loads and shows sidebar', async () => {
      const page = await newPage();
      try {
        await page.goto(baseUrl);
        await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });
        assert(await page.locator('text=Daemon').isVisible(), 'Daemon should be visible');
      } finally {
        await closePage(page);
      }
    });

    test('shows recent sessions area', async () => {
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
  });

  describe('WebSocket Connection', () => {
    test('connects and shows status', async () => {
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

    test('shows daemon status indicator', async () => {
      const page = await newPage();
      try {
        await page.goto(baseUrl);
        await page.locator('text=Connected').first().waitFor({ state: 'visible', timeout: 15000 });
        assert(
          await page.locator('.bg-green-500').first().isVisible(),
          'Status indicator should be visible'
        );
      } finally {
        await closePage(page);
      }
    });
  });

  describe('Session Creation', () => {
    test('creates session via New button', async () => {
      const page = await newPage();
      try {
        await page.goto(baseUrl);
        await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('button:has-text("New")').first().click();

        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });

        assert(
          await page.locator('textarea[placeholder*="Ask"]').first().isVisible(),
          'Should show message input'
        );
      } finally {
        await closePage(page);
      }
    });

    test('session page shows input area', async () => {
      const page = await newPage();
      try {
        await page.goto(baseUrl);
        await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });

        assert(
          await page.locator('textarea[placeholder*="Ask"]').first().isVisible(),
          'Should show message input'
        );
      } finally {
        await closePage(page);
      }
    });

    test('session appears in sidebar', async () => {
      const page = await newPage();
      try {
        await page.goto(baseUrl);
        await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        await page.goto(baseUrl);
        await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 5000 });

        const sessionCount = await page.locator('[data-testid="session-card"]').count();
        assert(sessionCount > 0, 'Should show at least one session in sidebar');
      } finally {
        await closePage(page);
      }
    });
  });

  describe('Navigation', () => {
    test('can navigate between sessions', async () => {
      const page = await newPage();
      try {
        await page.goto(baseUrl);
        await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        const firstSession = page.locator('[data-testid="session-card"]').first();
        await firstSession.click();

        assert(page.url().match(/\/session\/[a-f0-9-]+/), 'Should be on session page');
      } finally {
        await closePage(page);
      }
    });

    test('can return to home', async () => {
      const page = await newPage();
      try {
        await page.goto(baseUrl);
        await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        await page.goto(baseUrl);

        assert(page.url().endsWith('/') || page.url().endsWith(baseUrl), 'Should be on home page');
      } finally {
        await closePage(page);
      }
    });
  });

  describe('UI Components', () => {
    test('message input has send button', async () => {
      const page = await newPage();
      try {
        await page.goto(baseUrl);
        await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 15000 });

        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });

        assert(
          await page.locator('button[aria-label="Send message"]').isVisible(),
          'Should show send button'
        );
      } finally {
        await closePage(page);
      }
    });

    test('sidebar has connection status', async () => {
      const page = await newPage();
      try {
        await page.goto(baseUrl);
        await page.locator('text=Connected').first().waitFor({ state: 'visible', timeout: 15000 });

        assert(
          await page.locator('.bg-green-500').first().isVisible(),
          'Should show connection status'
        );
      } finally {
        await closePage(page);
      }
    });
  });
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
