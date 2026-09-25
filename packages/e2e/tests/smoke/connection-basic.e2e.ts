import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

test.describe('Smoke: Connection', () => {
  test('should establish WebSocket connection', async ({ page }) => {
    await page.goto('/');

    await waitForWebSocketConnected(page);

    await expect(page.getByTestId('new-chat-button')).toBeVisible({
      timeout: 10000,
    });
  });
});
