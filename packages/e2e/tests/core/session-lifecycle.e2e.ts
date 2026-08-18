import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

test.describe('2-Stage Session Creation', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
      timeout: 10000,
    });
    await page.waitForTimeout(500);
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

  test('should create session instantly (Stage 1)', async ({ page }) => {
    const startTime = Date.now();

    sessionId = await createSessionViaUI(page);

    const endTime = Date.now();
    const creationTime = endTime - startTime;

    expect(creationTime).toBeLessThan(5000);

    expect(sessionId).toBeTruthy();
  });

  test('should show default title initially (New Session)', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await expect(page.locator('h2:has-text("New Session")')).toBeVisible({
      timeout: 5000,
    });
  });

  test.skip('should generate title after first message (Stage 2)', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await expect(page.locator('h2:has-text("New Session")')).toBeVisible();

    const testMessage = 'Reply with exactly: TEST_OK';
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill(testMessage);

    const sendButton = page.locator('[data-testid="send-button"]').first();
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    await expect(page.locator(`text="${testMessage}"`).first()).toBeVisible({
      timeout: 5000,
    });

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 30000,
    });

    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    const messageText = await assistantMessage.textContent();
    expect(messageText).toBeTruthy();

    await page.waitForTimeout(3000);

    const titleElement = page.locator('h2').first();
    const title = await titleElement.textContent();

    expect(title).toBeTruthy();
  });

  test('should show session in sidebar immediately after creation', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await page.goto('/');
    await waitForWebSocketConnected(page);
    const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
    if (await chatsButton.isVisible().catch(() => false)) {
      await chatsButton.click();
      await page.waitForTimeout(300);
    }

    const sessionCard = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionCard).toBeVisible({ timeout: 10000 });
  });

  test('should handle multiple rapid session creations', async ({ page }) => {
    const sessionIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const id = await createSessionViaUI(page);
      sessionIds.push(id);

      await page.goto('/');
      await page.waitForTimeout(500);
    }

    const uniqueIds = new Set(sessionIds);
    expect(uniqueIds.size).toBe(sessionIds.length);

    for (const id of sessionIds) {
      try {
        await cleanupTestSession(page, id);
      } catch (error) {
        console.warn(`Failed to cleanup session ${id}:`, error);
      }
    }

    sessionId = null;
  });
});
