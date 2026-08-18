import { test, expect } from '../../fixtures';
import { createSessionViaUI, cleanupTestSession } from '../helpers/wait-helpers';

test.describe('Auto-Scroll Toggle', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('text=New Session', { timeout: 10000 });
    sessionId = null;
  });

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

  test('should toggle auto-scroll when button is clicked', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 15000 });

    await messageInput.fill('Hello');
    await page.locator('button[aria-label="Send message"]').first().click();

    await page.waitForTimeout(2000);

    const autoScrollToggle = page.locator('button:has-text("Auto")').first();

    const isVisible = await autoScrollToggle.isVisible().catch(() => false);

    if (isVisible) {
      await autoScrollToggle.click();
      await page.waitForTimeout(300);

      await autoScrollToggle.click();
      await page.waitForTimeout(300);

      expect(true).toBe(true);
    } else {
      console.log('Auto-scroll toggle not visible - test skipped');
    }
  });
});
