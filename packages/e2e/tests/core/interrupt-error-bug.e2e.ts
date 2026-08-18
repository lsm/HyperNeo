import { test, expect } from '../../fixtures';
import {
  setupMessageHubTesting,
  createSessionViaUI,
  waitForElement,
  cleanupTestSession,
  waitForSDKSystemInitMessage,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

test.describe('Interrupt Error Bug', () => {
  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test.describe('Issue: Race Condition Requiring Reset', () => {
    test.fixme('should allow sending messages immediately after interrupt without reset', async ({
      page,
    }) => {
      const sessionId = await createSessionViaUI(page);

      const messageInput = await waitForElement(page, 'textarea');
      await messageInput.fill('Tell me about AI');
      await page.click('[data-testid="send-button"]');

      await waitForSDKSystemInitMessage(page);

      await page.locator('[data-testid="stop-button"]').click();
      await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
        timeout: IS_MOCK ? 100 : 5000,
      });

      await messageInput.fill('Just say: "Hello after interrupt"');
      await page.click('[data-testid="send-button"]');

      await waitForSDKSystemInitMessage(page);

      await expect(page.locator('text=/Hello after interrupt/i')).toBeVisible({
        timeout: IS_MOCK ? 100 : 5000,
      });

      await expect(page.locator('[data-testid="assistant-message"]')).toBeVisible({
        timeout: IS_MOCK ? 100 : 20000,
      });

      const sendButtonVisible = await page
        .locator('[data-testid="send-button"]')
        .isVisible({ timeout: IS_MOCK ? 100 : 5000 })
        .catch(() => false);

      expect(sendButtonVisible).toBe(true);

      await cleanupTestSession(page, sessionId);
    });
  });
});
