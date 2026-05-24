import { test, expect } from '../../fixtures';
import { cleanupTestSession, waitForWebSocketConnected } from '../helpers/wait-helpers';
import { CHAT_INPUT_SELECTOR } from '../helpers/selectors';

/**
 * Inline Workspace Selector E2E Tests
 *
 * Tests for the two-stage session creation flow where workspace selection
 * is moved from the modal into an inline selector in the chat container.
 *
 * Flow:
 * 1. User clicks "New Session" → session created immediately without workspace
 * 2. Chat shows inline WorkspaceSelector with history dropdown + worktree toggle
 * 3. User can select workspace + mode, or skip
 *
 * All tests use only UI interactions (clicks, typing, navigation) per E2E rules.
 * No direct RPC calls in test bodies.
 */

/** Helper: create a session via "New Session" UI and return its ID from the URL */
async function createSessionViaNewSessionButton(
  page: import('@playwright/test').Page
): Promise<string> {
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create Session', exact: true })).toBeVisible({
    timeout: 5000,
  });
  await page.getByRole('button', { name: 'Create Session', exact: true }).click();
  await page.waitForURL(/\/session\//, { timeout: 15000 });

  // Wait for chat input to be ready (deterministic, no arbitrary timeout)
  await expect(page.locator(CHAT_INPUT_SELECTOR).first()).toBeVisible({ timeout: 10000 });

  const match = page.url().match(/\/session\/([^/]+)/);
  if (!match) throw new Error('Could not extract session ID from URL');
  return match[1];
}

test.describe('Inline Workspace Selector', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
      timeout: 10000,
    });
    await waitForWebSocketConnected(page);
    sessionId = null;
  });

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      try {
        await cleanupTestSession(page, sessionId);
      } catch {
        // Non-critical cleanup
      }
      sessionId = null;
    }
  });

  test('should show workspace selector after creating session via New Session button', async ({
    page,
  }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    // Workspace selector should appear in chat
    await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start with workspace' })).toBeVisible();
  });

  test('should show worktree/direct mode toggle when a workspace path is entered', async ({
    page,
  }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    // Wait for workspace selector
    await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });

    // Select "Enter path manually..." to show text input
    const dropdown = page.locator('select').first();
    await dropdown.selectOption('__manual__');

    // Text input should appear
    const pathInput = page.locator('input[placeholder="Enter workspace path..."]');
    await expect(pathInput).toBeVisible({ timeout: 3000 });

    // Type a path — mode toggle appears only when activePath is non-empty
    await pathInput.fill('/tmp');

    // Worktree/Direct toggle should now be visible
    await expect(page.getByRole('button', { name: 'Worktree' })).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Direct' })).toBeVisible();

    // Mode description should reflect default (Worktree = Isolated branch)
    await expect(page.getByText('Isolated branch (safe)')).toBeVisible();
  });

  test('should switch mode description when Direct is selected', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });

    // Enter a path to show the toggle
    const dropdown = page.locator('select').first();
    await dropdown.selectOption('__manual__');
    await page.locator('input[placeholder="Enter workspace path..."]').fill('/tmp');

    // Click Direct mode
    await page.getByRole('button', { name: 'Direct' }).click();

    // Description should update
    await expect(page.getByText('Edit directly (fast)')).toBeVisible({ timeout: 2000 });
  });

  test('should dismiss workspace selector when Skip is clicked', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    // Wait for workspace selector to appear
    await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });

    // Click Skip
    await page.getByRole('button', { name: 'Skip' }).click();

    // Workspace selector should disappear
    await expect(page.getByText('Select a workspace')).not.toBeVisible({ timeout: 3000 });

    // Chat input should remain usable
    await expect(page.locator(CHAT_INPUT_SELECTOR).first()).toBeEnabled();
  });

  test('should not show workspace selector after workspace has been set via UI', async ({
    page,
  }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    // Workspace selector appears
    await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });

    // Choose "Enter path manually..." to get text input
    await page.locator('select').first().selectOption('__manual__');
    const pathInput = page.locator('input[placeholder="Enter workspace path..."]');
    await expect(pathInput).toBeVisible({ timeout: 3000 });

    // Enter /tmp (always exists; not a git repo so direct mode is safe)
    await pathInput.fill('/tmp');

    // Switch to Direct mode so no worktree creation is attempted
    await page.getByRole('button', { name: 'Direct' }).click();

    // Confirm workspace
    await page.getByRole('button', { name: 'Start with workspace' }).click();

    // Selector should disappear after confirmation
    await expect(page.getByText('Select a workspace')).not.toBeVisible({ timeout: 5000 });

    // Navigate away and back — selector must NOT reappear
    await page.goto('/');
    await expect(page.getByText('Neo Lobby')).toBeVisible({ timeout: 5000 });

    await page.goto(`/session/${sessionId}`);
    await page.waitForURL(/\/session\//, { timeout: 10000 });
    await expect(page.locator(CHAT_INPUT_SELECTOR).first()).toBeVisible({ timeout: 10000 });

    // Workspace is now set — selector must not appear
    await expect(page.getByText('Select a workspace')).not.toBeVisible();
  });
});
