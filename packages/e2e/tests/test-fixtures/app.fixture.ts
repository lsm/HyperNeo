/**
 * App Fixture
 *
 * Provides a page that's already navigated to the app
 * and waited for key UI elements to be ready.
 *
 * This fixture uses DOM-based checks only - no access to internal state.
 */

import { test as base, expect, type Page } from '@playwright/test';

/**
 * Wait for the app to be fully loaded by checking for key UI elements
 * that indicate the app is ready for interaction.
 */
async function waitForAppReady(page: Page) {
  // Wait for the sidebar to be visible (indicates app shell loaded)
  await page
    .getByRole('button', { name: /New Session/i })
    .waitFor({ state: 'visible', timeout: 10000 });

  // Wait for authentication status to be shown in footer
  await page
    .locator('text=/Authentication|OAuth Token|Connected|Status/i')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 });

  // Give a bit of time for WebSocket connection to establish and initial data to load
  await page.waitForTimeout(1000);
}

/**
 * Extended test with app fixture
 *
 * Usage: import { test, expect } from '../fixtures/app.fixture';
 */
export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    // Navigate to the app
    await page.goto('/');

    // Wait for app to be ready (DOM-based checks only)
    await waitForAppReady(page);

    // Expose the page as 'app'
    await use(page);
  },
});

export { expect };
