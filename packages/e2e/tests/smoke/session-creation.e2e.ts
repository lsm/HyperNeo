import { test, expect } from '../../fixtures';
import { createSessionViaUI, cleanupTestSession } from '../helpers/wait-helpers';

test.describe('Smoke: Session Creation', () => {
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

  test('should create a new session', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('text=New Session', { timeout: 10000 });

    sessionId = await createSessionViaUI(page);
    expect(sessionId).toBeTruthy();

    await expect(page.locator(`[data-session-id="${sessionId}"]`).first()).toBeVisible();
  });
});
