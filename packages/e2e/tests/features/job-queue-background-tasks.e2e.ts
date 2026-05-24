import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForAssistantResponse,
  waitForMessageSent,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

/**
 * E2E tests for background job queue tasks.
 *
 * Verifies that background tasks (session title generation) are working
 * correctly from the user's perspective — i.e., through visible DOM state only.
 *
 * The existing `tests/settings/auto-title.e2e.ts` verifies the sidebar session
 * card (`h3`) updates. This test complements it by asserting the chat header
 * (`h2`) also updates, confirming real-time signal propagation from the
 * background job through to the active session view.
 */

const IS_MOCK = process.env.NEOKAI_USE_DEV_PROXY === '1';

// Use the data-testid on the ChatHeader h2 for an unambiguous selector.
// A plain class-based selector would also match ContextPanel.tsx's h2
// (which has the same classes plus `mr-2`), causing false positives.
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

  // ⚠️ SKIPPED: Requires LLM response (waitForAssistantResponse) which times out in CI without LLM.
  // The background title generation job depends on an agent completing its response.
  test.skip('chat header title updates after first message (title generation job)', async ({
    page,
  }) => {
    // Longer timeout: waitForAssistantResponse (90s) + title job (60s) + buffer
    test.setTimeout(180000);

    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Verify the chat header starts with the default "New Session" title.
    // Use the scoped class selector to avoid false matches on sidebar headings.
    const headerTitle = page.locator(CHAT_HEADER_TITLE).first();
    await expect(headerTitle).toHaveText('New Session', { timeout: 5000 });

    // Send a short message — this triggers the session.title_generation background job.
    // Use Enter (not Meta+Enter) so the test works on both macOS and Linux CI.
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('What is the capital of France?');
    await textarea.press('Enter');

    // Verify user message appears in chat
    await waitForMessageSent(page, 'What is the capital of France?');

    // Wait for the assistant to respond (proves the agent ran end-to-end)
    await waitForAssistantResponse(page);

    if (!IS_MOCK) {
      // Wait for the chat header title to change from "New Session" to the
      // generated title — this confirms the background job ran and the
      // session signal was updated in the active view.
      // Scope to the ChatHeader h2 via its specific class combo to avoid
      // selecting the sidebar's "<h2>Sessions</h2>".
      await page.waitForFunction(
        (selector) => {
          const h2 = document.querySelector(selector);
          const text = h2?.textContent?.trim() ?? '';
          return text !== '' && text !== 'New Session';
        },
        CHAT_HEADER_TITLE,
        { timeout: 60000 }
      );

      // Confirm the new title is visible in the chat header
      const updatedTitle = await headerTitle.textContent();
      expect(updatedTitle?.trim()).toBeTruthy();
      expect(updatedTitle?.trim()).not.toBe('New Session');

      // Also confirm the sidebar session card (scoped to this session)
      // reflects the updated title
      const sessionCard = page.locator(
        `[data-testid="session-card"][data-session-id="${sessionId}"]`
      );
      const cardTitle = sessionCard.locator('h3').first();
      await expect(cardTitle).not.toHaveText('New Session', { timeout: 10000 });
    } else {
      // In mock mode the devproxy won't generate a meaningful title;
      // just verify the assistant responded so the job queue at least ran
      await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
        timeout: 5000,
      });
    }
  });
});
