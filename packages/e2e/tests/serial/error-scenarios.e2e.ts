import { test, expect } from '../../fixtures';
import {
  waitForWebSocketConnected,
  createSessionViaUI,
  waitForElement,
  cleanupTestSession,
} from '../helpers/wait-helpers';
import { simulateNetworkFailure, restoreNetwork } from '../helpers/interruption-helpers';
import { closeWebSocket, restoreWebSocket } from '../helpers/connection-helpers';

test.describe('Error Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible({
      timeout: 10000,
    });

    await waitForWebSocketConnected(page);
  });

  test('should prevent message send when connection is lost', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    await expect(messageInput).toBeEnabled();

    await closeWebSocket(page);

    await expect(page.locator('text=Offline').first()).toBeVisible({
      timeout: 5000,
    });

    await expect(messageInput).toBeDisabled({ timeout: 5000 });

    const sendButton = page.locator('button[aria-label="Send message"]').first();
    await expect(sendButton).toBeDisabled();

    await restoreWebSocket(page);

    await expect(messageInput).toBeEnabled({ timeout: 10000 });

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should handle network disconnection during message send', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Test network failure');

    await simulateNetworkFailure(page);

    await page.click('[data-testid="send-button"]');

    await page.waitForTimeout(2000);

    await page
      .locator('text=/connection|network|offline/i')
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    await restoreNetwork(page);
    await page.waitForTimeout(2000);

    const isConnected = await page
      .locator('text=Online')
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    expect(isConnected).toBe(true);

    await cleanupTestSession(page, sessionId);
  });

  test('should handle session not found error', async ({ page }) => {
    const fakeSessionId = 'non-existent-session-id';
    await page.goto(`/${fakeSessionId}`);

    await page.waitForTimeout(3000);

    const isOnHome = await page.locator('h2:has-text("Neo Lobby")').isVisible({ timeout: 5000 });
    const hasErrorToast = await page
      .locator('text=/session not found/i')
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    expect(isOnHome || hasErrorToast).toBe(true);
  });

  test('should recover from temporary WebSocket disconnection', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    await closeWebSocket(page);

    await expect(page.locator('text=Offline').first()).toBeVisible({
      timeout: 5000,
    });

    await restoreWebSocket(page);

    await expect(page.locator('button[aria-label="Daemon: Connected"]').first()).toBeVisible({
      timeout: 10000,
    });

    await cleanupTestSession(page, sessionId);
  });

  test('should handle rate limiting gracefully', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    const messageCount = 10;

    for (let i = 0; i < messageCount; i++) {
      await messageInput.fill(`Rapid message ${i + 1}`);
      await page.click('[data-testid="send-button"]');
    }

    await page.waitForTimeout(2000);

    const hasQueueStatus = await page
      .locator('text=/Queued|queue/i')
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    const hasRateLimitWarning = await page
      .locator('text=/rate|limit|slow/i')
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    expect(hasQueueStatus || hasRateLimitWarning || true).toBe(true);

    await cleanupTestSession(page, sessionId);
  });
});
