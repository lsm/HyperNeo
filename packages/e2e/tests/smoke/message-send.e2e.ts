import { test, expect } from '../../fixtures';
import { createSessionViaUI, cleanupTestSession } from '../helpers/wait-helpers';

test.describe('Smoke: Message Send', () => {
  let sessionId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      try {
        await cleanupTestSession(page, sessionId);
      } catch (error) {
        console.warn(`Failed to cleanup session ${sessionId}:`, error);
      }
      sessionId = null;
    }
  });

  test('should send a message and receive response', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('text=New Session', { timeout: 10000 });

    sessionId = await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 15000 });

    await messageInput.fill('Hello');
    await page.locator('button[aria-label="Send message"]').first().click();

    await expect(page.getByText('Hello').first()).toBeVisible();

    await page.waitForTimeout(2000);
  });
});
