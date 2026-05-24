/**
 * Coverage Fixture for Playwright E2E Tests
 *
 * This fixture enables V8 coverage collection when COVERAGE=true is set.
 * It uses monocart-reporter's addCoverageReport API to collect coverage data.
 *
 * Usage:
 *   import { test, expect } from '../fixtures/coverage';
 *   // ... write tests as usual
 *
 * To collect coverage:
 *   COVERAGE=true bun run test
 */

import { test as base, expect, devices } from '@playwright/test';
import { addCoverageReport } from 'monocart-reporter';

const collectCoverage = process.env.COVERAGE === 'true';

/**
 * Custom test fixture that enables V8 coverage collection
 */
export const test = base.extend({
  /**
   * Auto-use fixture that wraps each test with coverage collection
   */
  autoCollectCoverage: [
    async ({ page }, use, testInfo) => {
      if (collectCoverage) {
        // Start V8 coverage collection via CDP
        await page.coverage.startJSCoverage({
          // Don't collect coverage for anonymous scripts (Playwright internals)
          reportAnonymousScripts: false,
          // Reset coverage on navigation (recommended for SPA)
          resetOnNavigation: false,
        });
      }

      // Run the test
      await use();

      if (collectCoverage) {
        // Stop coverage collection and get results
        const coverage = await page.coverage.stopJSCoverage();

        // Add coverage data to monocart reporter (only if we have data)
        // The testInfo provides context for monocart to merge coverage
        if (coverage && coverage.length > 0) {
          await addCoverageReport(coverage, testInfo);
        }
      }
    },
    { auto: true, scope: 'test' },
  ],
});

// Re-export expect and devices for convenience
export { expect, devices };
