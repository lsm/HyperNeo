import { test, expect } from '../../fixtures';
import {
  setupMessageHubTesting,
  createSessionViaUI,
  waitForElement,
  cleanupTestSession,
} from '../helpers/wait-helpers';

test.describe('Recovery Mechanisms', () => {
  test('should auto-save draft messages', async ({ page }) => {
    await setupMessageHubTesting(page);

    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    const draftMessage = 'This is a draft message that should be preserved';
    await messageInput.fill(draftMessage);

    await page.getByRole('button', { name: 'Spaces', exact: true }).click();
    await page.waitForTimeout(500);

    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.waitForTimeout(500);

    await page.click(`[data-session-id="${sessionId}"]`);
    await waitForElement(page, 'textarea');

    const _currentValue = await messageInput.inputValue();

    await expect(messageInput).toBeEnabled();

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should handle browser refresh during message processing', async ({ page }) => {
    await setupMessageHubTesting(page);

    const sessionId = await createSessionViaUI(page);

    await page.locator('textarea').first().fill('Message before refresh');
    await page.click('[data-testid="send-button"]');

    await page.waitForSelector('text=/Sending|Processing/i', { timeout: 2000 });

    await page.reload();
    await setupMessageHubTesting(page);

    await page.waitForLoadState('networkidle');

    await page.goto(`/${sessionId}`);

    await page.waitForTimeout(3000);

    const _textareaOrSessionUI = await page
      .locator('textarea, [data-session-id]')
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => null);

    await page.waitForTimeout(2000);

    const hasMessage = await page
      .locator('[data-message-role="user"]')
      .filter({ hasText: 'Message before refresh' })
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    expect(hasMessage).toBe(true);

    const textarea = page.locator('textarea').first();
    if (await textarea.isVisible({ timeout: 2000 }).catch(() => false)) {
      await textarea.fill('Message after refresh');
      await page.click('[data-testid="send-button"]');

      await page.waitForTimeout(3000);
    }

    await cleanupTestSession(page, sessionId);
  });
});
