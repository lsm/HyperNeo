import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

test.describe('Smoke: Connection', () => {
  test('should establish WebSocket connection', async ({ page }) => {
    await page.goto('/');

    await waitForWebSocketConnected(page);

    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
      timeout: 10000,
    });
  });
});
