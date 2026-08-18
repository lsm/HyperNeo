import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForAssistantResponse,
  waitForMessageSent,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

const CHAT_HEADER_TITLE = '[data-testid="chat-header-title"]';

test.describe('Background Job Queue Tasks', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
    await waitForWebSocketConnected(page);
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

  test.skip('chat header title updates after first message (title generation job)', async ({
    page,
  }) => {
    test.setTimeout(180000);

    sessionId = await createSessionViaUI(page);

    const headerTitle = page.locator(CHAT_HEADER_TITLE).first();
    await expect(headerTitle).toHaveText('New Session', { timeout: 5000 });

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('What is the capital of France?');
    await textarea.press('Enter');

    await waitForMessageSent(page, 'What is the capital of France?');

    await waitForAssistantResponse(page);

    if (!IS_MOCK) {
      await page.waitForFunction(
        (selector) => {
          const h2 = document.querySelector(selector);
          const text = h2?.textContent?.trim() ?? '';
          return text !== '' && text !== 'New Session';
        },
        CHAT_HEADER_TITLE,
        { timeout: 60000 }
      );

      const updatedTitle = await headerTitle.textContent();
      expect(updatedTitle?.trim()).toBeTruthy();
      expect(updatedTitle?.trim()).not.toBe('New Session');

      const sessionCard = page.locator(
        `[data-testid="session-card"][data-session-id="${sessionId}"]`
      );
      const cardTitle = sessionCard.locator('h3').first();
      await expect(cardTitle).not.toHaveText('New Session', { timeout: 10000 });
    } else {
      await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
        timeout: 5000,
      });
    }
  });
});
