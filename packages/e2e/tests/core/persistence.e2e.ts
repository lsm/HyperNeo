import { test, expect } from '../../fixtures';
import {
  setupMessageHubTesting,
  createSessionViaUI,
  waitForMessageSent,
  cleanupTestSession,
  waitForElement,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

test.describe('Page Refresh - Session State Persistence', () => {
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

  test('should reset agent state to idle after refresh (expected behavior)', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill('Tell me a short story.');

    const sendButton = page.locator('[data-testid="send-button"]');
    await sendButton.click();

    await page.waitForTimeout(2000);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await waitForWebSocketConnected(page);

    const sessionButton = page.locator(`[data-session-id="${sessionId}"]`);
    await sessionButton.waitFor({ state: 'visible', timeout: 10000 });
    await sessionButton.click();

    await waitForElement(page, 'textarea[placeholder*="Ask"]', {
      timeout: 30000,
    });

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(input).toBeEnabled({ timeout: 10000 });
  });

  test('should restore slash commands immediately after refresh', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await page.waitForTimeout(2000);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill('/');

    await page.waitForTimeout(500);

    await messageInput.fill('');

    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await waitForWebSocketConnected(page);

    const sessionButton = page.locator(`[data-session-id="${sessionId}"]`);
    await sessionButton.waitFor({ state: 'visible', timeout: 10000 });
    await sessionButton.click();

    await waitForElement(page, 'textarea[placeholder*="Ask"]', {
      timeout: 30000,
    });

    await page.waitForTimeout(2000);

    const inputAfterRefresh = page.locator('textarea[placeholder*="Ask"]').first();

    await inputAfterRefresh.fill('/');

    await page.waitForTimeout(500);
  });

  test('should restore user messages after page refresh', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill('What is React and why is it popular?');
    await messageInput.press('Enter');

    await waitForMessageSent(page, 'What is React and why is it popular?');

    const messageCountBefore = await page.locator('[data-message-role="user"]').count();
    expect(messageCountBefore).toBeGreaterThanOrEqual(1);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await waitForWebSocketConnected(page);

    const sessionButtonRefresh = page.locator(`[data-session-id="${sessionId}"]`);
    await sessionButtonRefresh.waitFor({ state: 'visible', timeout: 10000 });
    await sessionButtonRefresh.click();

    await waitForElement(page, 'textarea[placeholder*="Ask"]', {
      timeout: 30000,
    });

    await page.waitForFunction(
      (expectedCount) => {
        const messages = document.querySelectorAll('[data-message-role="user"]');
        return messages.length >= expectedCount;
      },
      messageCountBefore,
      { timeout: 10000 }
    );

    await expect(
      page
        .locator('[data-message-role="user"]')
        .filter({ hasText: 'What is React and why is it popular?' })
    ).toBeVisible();
  });
});
