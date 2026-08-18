import { test as base, expect, type Page } from '@playwright/test';

async function waitForAppReady(page: Page) {
  await page
    .getByRole('button', { name: /New Session/i })
    .waitFor({ state: 'visible', timeout: 10000 });

  await page
    .locator('text=/Authentication|OAuth Token|Connected|Status/i')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 });

  await page.waitForTimeout(1000);
}

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await page.goto('/');

    await waitForAppReady(page);

    await use(page);
  },
});

export { expect };
