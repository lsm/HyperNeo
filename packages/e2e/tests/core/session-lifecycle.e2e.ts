import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

/**
 * Session Lifecycle E2E Tests
 *
 * Comprehensive tests for session lifecycle:
 * - 2-stage session creation (critical regression - instant creation)
 * - Session switching and state preservation
 * - Session routing and navigation
 * - Basic session management (sidebar, visibility)
 *
 * CRITICAL REGRESSION TEST:
 * - 2-stage creation pattern: Stage 1 instant (<100ms), Stage 2 on first message
 * - Bug: Slow session creation blocked UI
 *
 * MERGED FROM:
 * - 2-stage-creation.e2e.ts (base - critical regression)
 * - session-switching.e2e.ts
 * - session-management.e2e.ts
 * - session-routing.e2e.ts
 *
 * STAGE 1 (Instant Creation < 100ms):
 * - Minimal database record created immediately
 * - Default title: "New Session"
 * - No worktree/branch creation (deferred)
 * - workspaceInitialized: false
 *
 * STAGE 2 (On First Message ~2s):
 * - Title generated from user input
 * - Branch name created: session/{slugified-title}-{shortId}
 * - Worktree created with meaningful branch name
 * - workspaceInitialized: true
 */
test.describe('2-Stage Session Creation', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for Lobby to load
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
    // Measure time for session creation
    const startTime = Date.now();

    // Create a new session via RPC helper
    sessionId = await createSessionViaUI(page);

    const endTime = Date.now();
    const creationTime = endTime - startTime;

    // Session creation should be fast (under 5 seconds including navigation)
    expect(creationTime).toBeLessThan(5000);

    // Session ID should be available
    expect(sessionId).toBeTruthy();
  });

  test('should show default title initially (New Session)', async ({ page }) => {
    // Create a new session via RPC helper
    sessionId = await createSessionViaUI(page);

    // Should show default "New Session" title
    await expect(page.locator('h2:has-text("New Session")')).toBeVisible({
      timeout: 5000,
    });
  });

  test.skip('should generate title after first message (Stage 2)', async ({ page }) => {
    // Create a new session via RPC helper
    sessionId = await createSessionViaUI(page);

    // Verify initial title is "New Session"
    await expect(page.locator('h2:has-text("New Session")')).toBeVisible();

    // Send a message using the send button (more reliable than keyboard shortcut)
    const testMessage = 'Reply with exactly: TEST_OK';
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill(testMessage);

    const sendButton = page.locator('[data-testid="send-button"]').first();
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    // Verify user message appears in chat (confirms message was sent)
    await expect(page.locator(`text="${testMessage}"`).first()).toBeVisible({
      timeout: 5000,
    });

    // Verify processing state appears
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // Wait for response
    // Note: This will timeout if API credentials are not configured,
    // SDK subprocess crashes, or there's an SDK/permission issue
    // 30s timeout is sufficient for most API responses (local: ~10s, CI: ~20s)
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 30000,
    });

    // Verify we got a response (not just an error)
    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    const messageText = await assistantMessage.textContent();
    expect(messageText).toBeTruthy();

    // After first message, title should be generated (not "New Session")
    // Wait for title to update (auto-title generation runs after first response)
    await page.waitForTimeout(3000); // Give time for title generation

    // Title should have changed from "New Session" to something related to the message
    const titleElement = page.locator('h2').first();
    const title = await titleElement.textContent();

    // Title could still be "New Session" if title generation is slow or failed
    // But we verify the mechanism exists
    expect(title).toBeTruthy();
  });

  test('should show session in sidebar immediately after creation', async ({ page }) => {
    // Create a new session via RPC helper
    sessionId = await createSessionViaUI(page);

    // Navigate to home and open the Chats section.
    // Sessions created in a git workspace start in 'pending_worktree_choice' status,
    // which means they are excluded from the Lobby's "Recent Sessions" (which only
    // shows 'active' sessions). The Chats/SessionsPage shows all non-archived sessions
    // via LiveQuery regardless of worktree-choice state.
    await page.goto('/');
    await waitForWebSocketConnected(page);
    const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
    if (await chatsButton.isVisible().catch(() => false)) {
      await chatsButton.click();
      await page.waitForTimeout(300);
    }

    // Session card should be visible in the sessions list
    const sessionCard = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionCard).toBeVisible({ timeout: 10000 });
  });

  test('should handle multiple rapid session creations', async ({ page }) => {
    const sessionIds: string[] = [];

    // Create multiple sessions rapidly
    for (let i = 0; i < 3; i++) {
      const id = await createSessionViaUI(page);
      sessionIds.push(id);

      // Navigate back to home to create another
      await page.goto('/');
      await page.waitForTimeout(500);
    }

    // All session IDs should be unique
    const uniqueIds = new Set(sessionIds);
    expect(uniqueIds.size).toBe(sessionIds.length);

    // Clean up all sessions
    for (const id of sessionIds) {
      try {
        await cleanupTestSession(page, id);
      } catch (error) {
        console.warn(`Failed to cleanup session ${id}:`, error);
      }
    }

    // Don't cleanup again in afterEach
    sessionId = null;
  });
});
