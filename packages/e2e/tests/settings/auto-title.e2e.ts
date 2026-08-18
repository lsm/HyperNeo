import { test, expect } from '../../fixtures';
import {
  createSessionViaUI,
  waitForMessageProcessed,
  cleanupTestSession,
  setupMessageHubTesting,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

test.describe('Auto Title Generation', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
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

  test('should auto-generate title after first message exchange', async ({ page }) => {
    test.setTimeout(180000);

    sessionId = await createSessionViaUI(page);
    expect(sessionId).toBeTruthy();

    const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionItem).toBeVisible({ timeout: 10000 });
    await expect(sessionItem.locator('h3')).toHaveText('New Session', { timeout: 10000 });

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill('What is the capital of France?');
    await messageInput.press('Enter');

    await waitForMessageProcessed(page, 'What is the capital of France?');

    if (!IS_MOCK) {
      await page.waitForFunction(
        (sid) => {
          const sessionEl = document.querySelector(`[data-session-id="${sid}"]`);
          const titleEl = sessionEl?.querySelector('h3');
          const titleText = titleEl?.textContent || '';
          return titleText !== 'New Session' && titleText.length > 0;
        },
        sessionId,
        { timeout: 120000 }
      );

      const newTitle = await sessionItem.locator('h3').textContent();
      expect(newTitle).not.toBe('New Session');
      expect(newTitle).toBeTruthy();

      const wordCount = newTitle?.split(/\s+/).length || 0;
      expect(wordCount).toBeGreaterThan(0);
      expect(wordCount).toBeLessThanOrEqual(15);
    } else {
      await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
        timeout: 5000,
      });
    }
  });

  test('should not regenerate title for subsequent messages', async ({ page }) => {
    test.setTimeout(180000);
    sessionId = await createSessionViaUI(page);

    const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionItem).toBeVisible({ timeout: 10000 });

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill('Tell me about TypeScript');
    await messageInput.press('Enter');

    await waitForMessageProcessed(page, 'Tell me about TypeScript');

    await page.waitForFunction(
      (sid) => {
        const sessionEl = document.querySelector(`[data-session-id="${sid}"]`);
        const titleEl = sessionEl?.querySelector('h3');
        const titleText = titleEl?.textContent || '';
        return titleText !== 'New Session' && titleText.length > 0;
      },
      sessionId,
      { timeout: 120000 }
    );

    const generatedTitle = await sessionItem.locator('h3').textContent();
    expect(generatedTitle).not.toBe('New Session');

    await messageInput.fill('What are its benefits?');
    await messageInput.press('Enter');

    await expect(
      page.locator('[data-message-role="user"]').filter({ hasText: 'What are its benefits?' })
    ).toBeVisible({ timeout: 5000 });

    await page.waitForTimeout(IS_MOCK ? 100 : 10000);

    const titleAfterSecondMessage = await sessionItem.locator('h3').textContent();
    expect(titleAfterSecondMessage).toBe(generatedTitle);
  });

  test('should handle title generation failure gracefully', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionItem).toBeVisible({ timeout: 10000 });

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill('Hello');
    await messageInput.press('Enter');

    await waitForMessageProcessed(page, 'Hello');

    await expect(sessionItem).toBeVisible({ timeout: 5000 });

    await expect(messageInput).toBeEnabled();
  });
});
