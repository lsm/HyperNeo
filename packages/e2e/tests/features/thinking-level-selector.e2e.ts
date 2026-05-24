/**
 * Thinking Level Selector E2E Tests
 *
 * Tests the thinking level selector in SessionStatusBar:
 * - Dropdown display and level options
 * - Level selection and persistence
 * - Visual indicator changes
 * - Dropdown close behaviors
 */

import { test, expect } from '../../fixtures';
import {
  setupMessageHubTesting,
  createSessionViaUI,
  cleanupTestSession,
} from '../helpers/wait-helpers';

test.describe('Thinking Level Selector', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
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

  test('should display thinking level button with default Auto level', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Find the thinking level button (has title starting with "Thinking:")
    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await expect(thinkingButton).toBeVisible({ timeout: 10000 });

    // Default should be Auto
    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Auto');
  });

  test('should open dropdown when clicking thinking level button', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Click the thinking level button
    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();

    // Dropdown should appear with "Thinking Level" header
    const dropdown = page.locator('text=Thinking Level');
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // Should show all 4 options
    await expect(page.locator('text=Auto')).toBeVisible();
    await expect(page.locator('text=Think 8k')).toBeVisible();
    await expect(page.locator('text=Think 16k')).toBeVisible();
    await expect(page.locator('text=Think 32k')).toBeVisible();
  });

  test('should select Think 8k level and persist', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Open thinking level dropdown
    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();

    // Wait for dropdown to appear
    await expect(page.locator('text=Thinking Level')).toBeVisible();

    // Click Think 8k option
    await page.locator('button:has-text("Think 8k")').click();

    // Dropdown should close
    await expect(page.locator('text=Thinking Level')).not.toBeVisible({
      timeout: 3000,
    });

    // Button title should update
    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Think 8k');
  });

  test('should select Think 16k level and persist', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Open thinking level dropdown
    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();

    // Wait for dropdown to appear
    await expect(page.locator('text=Thinking Level')).toBeVisible();

    // Click Think 16k option
    await page.locator('button:has-text("Think 16k")').click();

    // Button title should update
    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Think 16k');
  });

  test('should select Think 32k level and persist', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Open thinking level dropdown
    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();

    // Wait for dropdown to appear
    await expect(page.locator('text=Thinking Level')).toBeVisible();

    // Click Think 32k option
    await page.locator('button:has-text("Think 32k")').click();

    // Button title should update
    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Think 32k');
  });

  test('should return to Auto level', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');

    // First, set to Think 8k
    await thinkingButton.click();
    await expect(page.locator('text=Thinking Level')).toBeVisible();
    await page.locator('button:has-text("Think 8k")').click();
    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Think 8k');

    // Now return to Auto
    await thinkingButton.click();
    await expect(page.locator('text=Thinking Level')).toBeVisible();
    await page.locator('button:has-text("Auto")').first().click();

    // Button title should return to Auto
    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Auto');
  });

  test('should show current level indicator in dropdown', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');

    // Set to Think 16k
    await thinkingButton.click();
    await page.locator('button:has-text("Think 16k")').click();

    // Re-open dropdown
    await thinkingButton.click();
    await expect(page.locator('text=Thinking Level')).toBeVisible();

    // Think 16k should show "(current)" indicator
    const think16kOption = page.locator('button:has-text("Think 16k (current)")');
    await expect(think16kOption).toBeVisible();
  });

  test('should close dropdown when clicking button again', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Open thinking level dropdown
    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();
    await expect(page.locator('text=Thinking Level')).toBeVisible();

    // Click button again to close
    await thinkingButton.click();

    // Dropdown should close
    await expect(page.locator('text=Thinking Level')).not.toBeVisible({
      timeout: 3000,
    });
  });

  test('should close model dropdown when opening thinking dropdown', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Open model switcher dropdown first
    const modelButton = page.locator('button[title^="Switch Model"]');
    await modelButton.click();
    await expect(page.locator('text=Select Model')).toBeVisible();

    // Now open thinking level dropdown
    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();

    // Model dropdown should close
    await expect(page.locator('text=Select Model')).not.toBeVisible({
      timeout: 3000,
    });

    // Thinking dropdown should be open
    await expect(page.locator('text=Thinking Level')).toBeVisible();
  });

  test('should persist thinking level after page refresh', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Set to Think 32k
    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();
    await page.locator('button:has-text("Think 32k")').click();
    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Think 32k');

    // Refresh the page
    await page.reload();

    // Wait for daemon connection to be established
    await expect(page.locator('[aria-label="Daemon: Connected"]').first()).toBeVisible({
      timeout: 15000,
    });

    // Click on the session in sidebar to re-open it
    const sessionCard = page.locator(`[data-session-id="${sessionId}"]`).first();
    await sessionCard.click();

    // Wait for session view to load (thinking button should appear)
    const refreshedThinkingButton = page.locator('button[title^="Thinking:"]');
    await expect(refreshedThinkingButton).toBeVisible({ timeout: 10000 });

    // Thinking level should still be Think 32k
    await expect(refreshedThinkingButton).toHaveAttribute('title', 'Thinking: Think 32k', {
      timeout: 10000,
    });
  });
});
