/**
 * Authentication Status E2E Test
 *
 * Tests that authentication status is visible in the UI.
 * Tests actual UI behavior through real user interactions only.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

test.describe('Authentication Status', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should show daemon connection status indicator', async ({ page }) => {
    // The daemon status indicator shows connection state via aria-label
    // Possible states: "Daemon: Connected", "Daemon: Connecting...", "Daemon: Offline", "Daemon: Error"
    const daemonIndicator = page.locator('[aria-label^="Daemon:"]').first();
    await expect(daemonIndicator).toBeVisible({ timeout: 5000 });

    // Should show connected state (green indicator)
    await expect(page.locator('[aria-label="Daemon: Connected"]').first()).toBeVisible({
      timeout: 10000,
    });
  });
});
