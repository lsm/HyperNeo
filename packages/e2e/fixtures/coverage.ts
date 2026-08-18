import { test as base, expect, devices } from '@playwright/test';
import { addCoverageReport } from 'monocart-reporter';

const collectCoverage = process.env.COVERAGE === 'true';

export const test = base.extend({
  autoCollectCoverage: [
    async ({ page }, use, testInfo) => {
      if (collectCoverage) {
        await page.coverage.startJSCoverage({
          reportAnonymousScripts: false,
          resetOnNavigation: false,
        });
      }

      await use();

      if (collectCoverage) {
        const coverage = await page.coverage.stopJSCoverage();

        if (coverage && coverage.length > 0) {
          await addCoverageReport(coverage, testInfo);
        }
      }
    },
    { auto: true, scope: 'test' },
  ],
});

export { expect, devices };
