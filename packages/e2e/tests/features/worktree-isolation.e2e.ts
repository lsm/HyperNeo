import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';

/**
 * Worktree Isolation E2E Tests
 *
 * Tests git worktree integration for session isolation:
 * - Session in worktree vs shared workspace
 * - Branch display in UI
 * - Worktree indicator tooltip
 * - Cleanup on session deletion
 *
 * Note: These tests require the workspace to be a git repository
 * Worktree path: ~/.neokai/worktrees/{repo-hash}/{sessionId}
 * Branch naming: session/{slugified-title}-{shortId}
 */
test.describe('Worktree Isolation', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
    await page.waitForTimeout(1000);
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

  // ⚠️ SKIPPED: Requires LLM to respond (waitForAssistantResponse) which times out in CI without LLM.
  // Session creation via UI works, but Stage 2 workspace init requires agent response.
  test.skip('should create session with worktree indicator', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to trigger Stage 2 (workspace initialization)
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Hello, please confirm this is working');
    await page.keyboard.press('Meta+Enter');

    // Wait for response
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    // After workspace initialization, worktree info might be visible
    // Look for branch indicator or worktree tooltip
    const sessionHeader = page.locator('h2').first();
    await expect(sessionHeader).toBeVisible();

    // Worktree sessions may show branch information
    // This depends on UI implementation
  });

  // ⚠️ SKIPPED: Requires LLM to respond (waitForAssistantResponse) which times out in CI without LLM.
  // Session creation via UI works, but workspace init requires agent response.
  test.skip('should show session metadata with workspace info', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to trigger workspace initialization
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Test message for worktree');
    await page.keyboard.press('Meta+Enter');

    // Wait for response
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    // Open session options menu to see session info
    const optionsButton = page.getByTitle('Session options');
    await optionsButton.click();

    // The dropdown should be visible
    const dropdown = page.locator('[role="menu"]');
    await expect(dropdown).toBeVisible();
  });

  // ⚠️ SKIPPED: Requires LLM to respond to message (lines 89-96) and URL navigation after session deletion.
  // Both may fail in CI without LLM access. URL navigation issue may be product bug.
  test.skip('should cleanup worktree when session is deleted', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to initialize workspace
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Test for cleanup');
    await page.keyboard.press('Meta+Enter');

    // Wait for response
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    // Remember the session ID before deletion
    const deletedSessionId = sessionId;

    // Open session options and delete
    const optionsButton = page.getByTitle('Session options');
    await optionsButton.click();

    // Click Delete option
    await page.locator('text=Delete Chat').click();

    // Confirm deletion
    const confirmButton = page.locator('[data-testid="confirm-delete-session"]');
    await confirmButton.click();

    // Session should be gone - URL should no longer contain the deleted session ID
    await expect(page).not.toHaveURL(new RegExp(deletedSessionId!), { timeout: 10000 });

    // Don't try to cleanup in afterEach since it's already deleted
    sessionId = null;
  });

  test.skip('should maintain separate sessions in different worktrees', async ({ page }) => {
    // TODO: This test needs to use more specific selectors to avoid strict mode violations
    const sessionIds: string[] = [];

    // Create first session
    const session1Id = await createSessionViaUI(page);
    sessionIds.push(session1Id);

    // Send message to first session
    let textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('First session message');
    await page.keyboard.press('Meta+Enter');
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    // Navigate home and create second session
    await page.goto('/');
    await page.waitForTimeout(1000);

    const session2Id = await createSessionViaUI(page);
    sessionIds.push(session2Id);

    // Send message to second session
    textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Second session message');
    await page.keyboard.press('Meta+Enter');
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    // Sessions should have different IDs (isolated)
    expect(session1Id).not.toBe(session2Id);

    // Navigate back to first session and verify its content
    await page.goto(`/${session1Id}`);
    await page.waitForTimeout(1000);

    // First session should show its message
    await expect(page.locator('text=First session message')).toBeVisible();

    // Clean up both sessions
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

  test.skip('should display worktree info in session header', async ({ page }) => {
    // TODO: The UI may not have a <main> element; needs investigation
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send message to trigger workspace initialization
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Initialize workspace');
    await page.keyboard.press('Meta+Enter');

    // Wait for response
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    // Wait for workspace to initialize
    await page.waitForTimeout(3000);

    // Look for worktree/branch indicator in the UI
    // This might be shown as a tooltip or badge near the session title
    const sessionArea = page.locator('main').first();

    // Verify the session area is visible
    await expect(sessionArea).toBeVisible();

    // The actual display of worktree info depends on UI implementation
    // Check that session is loaded and functional
    const sessionTitle = page.locator('h2').first();
    await expect(sessionTitle).toBeVisible();
  });
});
