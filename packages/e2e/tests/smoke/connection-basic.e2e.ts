/**
 * Smoke Test: Basic Connection
 *
 * Quick test to verify WebSocket connection works.
 * Part of the smoke test suite (target: < 1 minute total).
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

test.describe('Smoke: Connection', () => {
  test('should establish WebSocket connection', async ({ page }) => {
    await page.goto('/');

    // Wait for connection indicator
    await waitForWebSocketConnected(page);

    // Verify "New Session" button is visible (indicates app is ready)
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
      timeout: 10000,
    });
  });
});
