/**
 * New Session Modal E2E Tests
 *
 * Tests the New Session modal flow:
 *
 * 1. Modal appears when clicking "New Session" in the Lobby
 * 2. Session can be created without a workspace path (workspace selection
 *    is now handled by the inline WorkspaceSelector in the chat container —
 *    see workspace-selector.e2e.ts for those tests)
 *
 * All actions are performed via UI interactions only (no direct RPC calls in
 * assertions/actions). The only RPC usage is in afterEach cleanup, which is
 * an accepted infrastructure pattern per E2E test rules.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, cleanupTestSession } from '../helpers/wait-helpers';

test.describe('New Session modal', () => {
  let createdSessionIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    // Wait for lobby to be fully loaded
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
      timeout: 15000,
    });
    createdSessionIds = [];
  });

  test.afterEach(async ({ page }) => {
    for (const sessionId of createdSessionIds) {
      try {
        await cleanupTestSession(page, sessionId);
      } catch {
        // Cleanup failure is non-critical
      }
    }
    createdSessionIds = [];
  });

  test('New Session modal appears when clicking the button', async ({ page }) => {
    // Click the "New Session" button in the lobby header
    await page.getByRole('button', { name: 'New Session', exact: true }).click();

    // The modal should appear with title "New Session"
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByRole('dialog').getByRole('heading', { name: 'New Session' })
    ).toBeVisible();

    // Create Session button should be enabled
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Create Session' })
    ).toBeEnabled();

    // Close the modal
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 3000 });
  });

  test('Session can be created without a workspace path', async ({ page }) => {
    // Open the New Session modal
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

    // Submit button should be enabled
    const submitButton = page.getByRole('dialog').getByRole('button', { name: 'Create Session' });
    await expect(submitButton).toBeEnabled();

    // Click "Create Session"
    await submitButton.click();

    // Should navigate to a session
    await expect(page).not.toHaveURL('/', { timeout: 10000 });

    // Extract session ID from URL for cleanup
    const url = page.url();
    const sessionIdMatch = url.match(/\/session\/([^/?#]+)/);
    if (sessionIdMatch) {
      createdSessionIds.push(sessionIdMatch[1]);
    }
  });
});
