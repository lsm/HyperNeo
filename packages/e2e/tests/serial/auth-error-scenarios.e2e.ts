import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

test.describe('Authentication Status', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should show daemon connection status indicator', async ({ page }) => {
    const daemonIndicator = page.locator('[aria-label^="Daemon:"]').first();
    await expect(daemonIndicator).toBeVisible({ timeout: 5000 });

    await expect(page.locator('[aria-label="Daemon: Connected"]').first()).toBeVisible({
      timeout: 10000,
    });
  });
});
