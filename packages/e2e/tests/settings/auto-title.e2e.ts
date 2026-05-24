import { test, expect } from '../../fixtures';
import {
  createSessionViaUI,
  waitForMessageProcessed,
  cleanupTestSession,
  setupMessageHubTesting,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.NEOKAI_USE_DEV_PROXY === '1';

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
    // Set longer timeout for this test since it involves multiple API calls
    test.setTimeout(180000);

    // Create a new session
    sessionId = await createSessionViaUI(page);
    expect(sessionId).toBeTruthy();

    // Verify initial title is "New Session"
    // Add explicit wait for session item visibility to avoid timeout
    const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionItem).toBeVisible({ timeout: 10000 });
    // Wait for h3 to have text before asserting (avoids race condition)
    await expect(sessionItem.locator('h3')).toHaveText('New Session', { timeout: 10000 });

    // Send a message that should trigger title generation
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill('What is the capital of France?');
    await messageInput.press('Enter');

    // Wait for the message to be processed and response received
    await waitForMessageProcessed(page, 'What is the capital of France?');

    // IS_MOCK: In mock mode, the devproxy won't generate a meaningful title.
    // We verify the API was called (message processed) but skip title assertions.
    if (!IS_MOCK) {
      // Wait for title to be generated (may take a few seconds)
      // Title should change from "New Session" to something else
      await page.waitForFunction(
        (sid) => {
          const sessionEl = document.querySelector(`[data-session-id="${sid}"]`);
          const titleEl = sessionEl?.querySelector('h3');
          const titleText = titleEl?.textContent || '';
          return titleText !== 'New Session' && titleText.length > 0;
        },
        sessionId,
        { timeout: 120000 } // Increased timeout for CI environment
      );

      // Verify the title has changed
      const newTitle = await sessionItem.locator('h3').textContent();
      expect(newTitle).not.toBe('New Session');
      expect(newTitle).toBeTruthy();

      // Title should be concise (3-7 words as per prompt)
      const wordCount = newTitle?.split(/\s+/).length || 0;
      expect(wordCount).toBeGreaterThan(0);
      expect(wordCount).toBeLessThanOrEqual(15); // Allow some flexibility
    } else {
      // In mock mode, just verify an assistant message was received
      await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
        timeout: 5000,
      });
    }
  });

  test('should not regenerate title for subsequent messages', async ({ page }) => {
    // This test sends 2 messages, so needs longer timeout
    test.setTimeout(180000);
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Wait for session to be visible before interacting
    const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionItem).toBeVisible({ timeout: 10000 });

    // Send first message
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill('Tell me about TypeScript');
    await messageInput.press('Enter');

    // Wait for first message and title generation
    await waitForMessageProcessed(page, 'Tell me about TypeScript');

    // Wait for title to be generated
    await page.waitForFunction(
      (sid) => {
        const sessionEl = document.querySelector(`[data-session-id="${sid}"]`);
        const titleEl = sessionEl?.querySelector('h3');
        const titleText = titleEl?.textContent || '';
        return titleText !== 'New Session' && titleText.length > 0;
      },
      sessionId,
      { timeout: 120000 } // Increased timeout for CI environment
    );

    // Get the generated title
    const generatedTitle = await sessionItem.locator('h3').textContent();
    expect(generatedTitle).not.toBe('New Session');

    // Send a second message
    await messageInput.fill('What are its benefits?');
    await messageInput.press('Enter');

    // Wait for second message to appear in the chat (don't need full response)
    await expect(
      page.locator('[data-message-role="user"]').filter({ hasText: 'What are its benefits?' })
    ).toBeVisible({ timeout: 5000 });

    // Wait enough time for title regeneration to trigger (if it were going to)
    // IS_MOCK: Reduced timeout in mock mode since title won't regenerate anyway
    await page.waitForTimeout(IS_MOCK ? 100 : 10000);

    // Verify title hasn't changed
    const titleAfterSecondMessage = await sessionItem.locator('h3').textContent();
    expect(titleAfterSecondMessage).toBe(generatedTitle);
  });

  test('should handle title generation failure gracefully', async ({ page }) => {
    // This test verifies that if title generation fails, the session still works
    // We can't easily simulate failure in E2E, but we can verify the session
    // continues to work even if title stays as "New Session"

    sessionId = await createSessionViaUI(page);

    // Wait for session to be visible before interacting
    const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionItem).toBeVisible({ timeout: 10000 });

    // Send a message
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.fill('Hello');
    await messageInput.press('Enter');

    // Wait for message to be processed
    await waitForMessageProcessed(page, 'Hello');

    // Verify session is still functional regardless of title
    await expect(sessionItem).toBeVisible({ timeout: 5000 });

    // Message input should still be enabled
    await expect(messageInput).toBeEnabled();
  });
});
