/**
 * Context Usage E2E Tests
 *
 * Consolidated tests for context usage display:
 * - Context usage bar display
 * - Dropdown content
 * - Dropdown close behavior
 */

import { test, expect } from '../../fixtures';
import {
  setupMessageHubTesting,
  createSessionViaUI,
  cleanupTestSession,
  waitForAssistantResponse,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

// Detect mock mode (devproxy) - devproxy mock includes usage data so tests should pass
const IS_MOCK = process.env.NEOKAI_USE_DEV_PROXY === '1';

/**
 * Helper to wait for context data to become available after a message exchange.
 * Some providers (e.g., GLM) don't report context usage data, so this may not
 * resolve. Returns true if context data is available, false otherwise.
 */
async function waitForContextData(page: import('@playwright/test').Page): Promise<boolean> {
  // In mock mode, devproxy returns usage data so tests should pass quickly
  const timeout = IS_MOCK ? 100 : 15000;
  const contextIndicator = page.locator('[title="Click for context details"]');
  return contextIndicator.isVisible({ timeout }).catch(() => false);
}

test.describe('Context Usage - Display', () => {
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

  test('should display context usage indicator', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Context usage bar should be visible (the clickable indicator area)
    // Title is "Context data loading..." initially
    const contextIndicator = page.locator('[title="Context data loading..."]');
    const timeout = IS_MOCK ? 100 : 10000;
    await expect(contextIndicator).toBeVisible({ timeout });
  });

  test('should show context loading state initially', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Initial state should show loading message
    const loadingIndicator = page.locator('[title="Context data loading..."]');
    const timeout = IS_MOCK ? 100 : 10000;
    await expect(loadingIndicator).toBeVisible({ timeout });
  });

  test('should show non-zero context percentage after message exchange', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello, please respond with a brief greeting');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });

    // Get the context percentage element by data-testid
    const contextPercentage = page.getByTestId('context-percentage');

    // Should be visible
    await expect(contextPercentage).toBeVisible({ timeout });

    // Get the text content and verify it's NOT "0.0%"
    const percentageText = await contextPercentage.textContent();
    expect(percentageText).not.toBe('0.0%');

    // Should have some actual percentage value (e.g., "1.2%", "5.3%", etc.)
    // Parse the percentage to verify it's a number greater than 0
    const percentageValue = parseFloat(percentageText?.replace('%', '') || '0');
    expect(percentageValue).toBeGreaterThan(0);
  });

  test('should toggle dropdown when clicking indicator again', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    // Open context dropdown
    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    // Wait for dropdown to appear
    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });

    // Click indicator again to close
    await contextIndicator.click();

    // Dropdown should close
    await expect(page.locator('text=Context Usage')).not.toBeVisible({
      timeout: IS_MOCK ? 100 : 3000,
    });
  });

  test('should persist context data after page refresh', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello, please respond with a brief greeting');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout5000 = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout: timeout5000 });

    // Get the context percentage element by data-testid
    const contextPercentage = page.getByTestId('context-percentage');
    await expect(contextPercentage).toBeVisible({ timeout: timeout5000 });

    // Get the percentage value before refresh
    const percentageBeforeRefresh = await contextPercentage.textContent();
    expect(percentageBeforeRefresh).not.toBe('0.0%');
    const percentageValueBefore = parseFloat(percentageBeforeRefresh?.replace('%', '') || '0');
    expect(percentageValueBefore).toBeGreaterThan(0);

    // Refresh the page
    await page.reload();

    // Wait for page to load and WebSocket to reconnect
    await waitForWebSocketConnected(page);

    // Wait for session to load
    const timeout10000 = IS_MOCK ? 100 : 10000;
    await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeVisible({
      timeout: timeout10000,
    });

    // Context indicator should still show data (not "Context data loading...")
    const contextIndicatorAfterRefresh = page.locator('[title="Click for context details"]');
    const timeout15000 = IS_MOCK ? 100 : 15000;
    await expect(contextIndicatorAfterRefresh).toBeVisible({ timeout: timeout15000 });

    // Context percentage should still be visible and non-zero
    const contextPercentageAfterRefresh = page.getByTestId('context-percentage');
    await expect(contextPercentageAfterRefresh).toBeVisible({ timeout: timeout5000 });

    const percentageAfterRefresh = await contextPercentageAfterRefresh.textContent();
    const percentageValueAfter = parseFloat(percentageAfterRefresh?.replace('%', '') || '0');

    // CRITICAL: Context data should persist after refresh
    // This is the bug - currently context usage goes back to 0 after refresh
    // In mock mode, usage data is consistently returned so this test should pass
    expect(percentageValueAfter).toBeGreaterThan(0);
  });
});

test.describe('Context Usage - Dropdown Content', () => {
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

  test('should open dropdown when clicking context indicator after message exchange', async ({
    page,
  }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response (this populates context data)
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    // Dropdown should appear with "Context Usage" header
    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });
  });

  test('should show context window percentage in dropdown', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    // Should show "Context Window" label
    await expect(page.locator('text=Context Window')).toBeVisible({
      timeout,
    });
  });

  test('should show breakdown section in dropdown', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    // Should show "Breakdown" section header
    await expect(page.locator('text=Breakdown')).toBeVisible({ timeout });
  });

  test('should show model information in dropdown', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    // Should show "Model:" label
    await expect(page.locator('text=Model:')).toBeVisible({ timeout });
  });

  test('should display token counts in breakdown', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    // Wait for breakdown section
    await expect(page.locator('text=Breakdown')).toBeVisible({ timeout });

    // Check that percentage values are displayed (format: X.X%)
    const percentagePattern = page.locator('text=/%$/');
    await expect(percentagePattern.first()).toBeVisible();
  });

  test('should show progress bar in context window section', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    // Wait for dropdown
    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });

    // The dropdown should have a progress bar (div with rounded-full and overflow-hidden)
    const progressBar = page.locator('.rounded-full.overflow-hidden').first();
    await expect(progressBar).toBeVisible();
  });
});

test.describe('Context Usage - Dropdown Close Behavior', () => {
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

  test('should close dropdown when clicking close button', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    // Wait for dropdown to appear
    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });

    // Click close button (X button in dropdown header)
    const closeButton = page
      .locator('button')
      .filter({ has: page.locator('svg line') })
      .last();
    await closeButton.click();

    // Dropdown should close
    await expect(page.locator('text=Context Usage')).not.toBeVisible({
      timeout: IS_MOCK ? 100 : 3000,
    });
  });

  test('should close dropdown with Escape key', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    // Wait for dropdown to appear
    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });

    // Wait for useEffect to register keydown handler (runs async after render)
    await page.waitForTimeout(IS_MOCK ? 100 : 200);

    // Press Escape
    await page.keyboard.press('Escape');

    // Dropdown should close
    await expect(page.locator('text=Context Usage')).not.toBeVisible({
      timeout: IS_MOCK ? 100 : 3000,
    });
  });

  test('should close dropdown when clicking outside', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to populate context data
    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page);

    // Wait for context data (some providers like GLM don't report it)
    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    // Wait for dropdown to appear
    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });

    // Wait for useEffect to register click-outside handler (runs async after render)
    await page.waitForTimeout(IS_MOCK ? 100 : 200);

    // Click outside the dropdown (on the chat area background)
    await page.locator('textarea[placeholder*="Ask"]').first().click();

    // Dropdown should close
    await expect(page.locator('text=Context Usage')).not.toBeVisible({
      timeout: IS_MOCK ? 100 : 3000,
    });
  });
});
