#!/usr/bin/env bun
/**
 * Quick E2E Coverage Tests
 *
 * Runs representative E2E tests with an in-process server to collect coverage
 * for both server-side (daemon/shared) and browser-side (web) code.
 *
 * Coverage collection:
 * - Server-side: Bun test --coverage instruments imported daemon/shared code
 * - Browser-side: Playwright CDP page.coverage API + v8-to-istanbul
 *
 * Run: bun test --coverage tests/e2e-coverage/e2e-quick.test.ts
 */

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

// Import daemon components - these will be covered by bun --coverage
import { createDaemonApp } from '@hyperneo/daemon/app';
import { getConfig } from '@hyperneo/daemon/config';
import { createWebSocketHandlers } from '@hyperneo/daemon/routes/setup-websocket';

// Test fixtures
let browser: Browser;
let server: ReturnType<typeof Bun.serve> | null = null;
let daemonContext: Awaited<ReturnType<typeof createDaemonApp>> | null = null;
let serverPort: number;
let baseUrl: string;
let coverageCollector: BrowserCoverageCollector;

describe('E2E Quick Coverage Tests', () => {
  /**
   * Setup: Start in-process server and browser
   */
  beforeAll(async () => {
    serverPort = await findAvailablePort();
    baseUrl = `http://localhost:${serverPort}`;
    coverageCollector = new BrowserCoverageCollector(serverPort);
    console.log(`\n🚀 Starting E2E coverage server on port ${serverPort}...`);

    // Setup workspace
    const workspace = `/tmp/e2e-cov-${Date.now()}`;
    await Bun.$`mkdir -p ${workspace}`;

    // Configure
    process.env.HYPERNEO_WORKSPACE_PATH = workspace;
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
    const wsHandlers = createWebSocketHandlers(
      daemonContext.transport,
      daemonContext.sessionManager
    );

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
    browser = await chromium.launch({ headless: true });
    console.log('✅ Browser launched\n');
  }, 60000);

  /**
   * Teardown: Collect coverage, cleanup
   */
  afterAll(async () => {
    console.log('\n🛑 Processing coverage and cleanup...');

    // Process browser coverage
    const coverage = coverageCollector.getCoverage();
    if (coverage.length > 0) {
      const distPath = resolve(import.meta.dir, '../../../web/dist');

      try {
        // Convert to Istanbul format
        const istanbulCoverage = await convertToIstanbul(coverage, distPath);

        // Filter path for web source files
        const filterPath = 'packages/web/src';

        // Calculate stats
        const stats = calculateStats(istanbulCoverage, filterPath);

        // Print summary
        printCoverageSummary(stats);

        // Generate LCOV
        const lcovContent = generateLcov(istanbulCoverage, filterPath);

        // Write to file
        const outputPath = resolve(import.meta.dir, 'browser-coverage.lcov');
        await Bun.write(outputPath, lcovContent);
        console.log(`\n   📄 Browser LCOV written to: ${outputPath}`);
      } catch (error) {
        console.error('   ❌ Error processing browser coverage:', error);
      }
    } else {
      console.log('   ⚠️  No browser coverage collected');
    }

    // Cleanup
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

  // =============================================================================
  // Test Helper Functions
  // =============================================================================

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

  // =============================================================================
  // Test Suites
  // =============================================================================

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

        // Click New button
        await page.locator('button:has-text("New")').first().click();

        // Should navigate to session page
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        // Wait for textarea to appear
        await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });

        // Should show input area
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

        // Create a session first
        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        // Wait for textarea to appear
        await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });

        // Check for input area
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

        // Create a session
        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        // Go back to home
        await page.goto(baseUrl);
        await page.locator('text=Daemon').waitFor({ state: 'visible', timeout: 5000 });

        // Should show session in sidebar
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

        // Create first session
        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        // Create second session
        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        // Navigate to first session via sidebar
        const firstSession = page.locator('[data-testid="session-card"]').first();
        await firstSession.click();

        // Should navigate
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

        // Create a session
        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        // Go to home via navigation
        await page.goto(baseUrl);

        // Should be on home page
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

        // Create a session
        await page.locator('button:has-text("New")').first().click();
        await page.waitForURL(/\/session\/[a-f0-9-]+(-[a-f0-9-]+)+/, { timeout: 5000 });

        // Wait for textarea to appear
        await page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });

        // Check for send button
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

// =============================================================================
// Helper Functions
// =============================================================================

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
