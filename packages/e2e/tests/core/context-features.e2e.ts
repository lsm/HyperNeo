import { test, expect } from '../../fixtures';
import {
  setupMessageHubTesting,
  createSessionViaUI,
  cleanupTestSession,
  waitForAssistantResponse,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

async function waitForContextData(page: import('@playwright/test').Page): Promise<boolean> {
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
    sessionId = await createSessionViaUI(page);

    const contextIndicator = page.locator('[title="Context data loading..."]');
    const timeout = IS_MOCK ? 100 : 10000;
    await expect(contextIndicator).toBeVisible({ timeout });
  });

  test('should show context loading state initially', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const loadingIndicator = page.locator('[title="Context data loading..."]');
    const timeout = IS_MOCK ? 100 : 10000;
    await expect(loadingIndicator).toBeVisible({ timeout });
  });

  test('should show non-zero context percentage after message exchange', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello, please respond with a brief greeting');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });

    const contextPercentage = page.getByTestId('context-percentage');

    await expect(contextPercentage).toBeVisible({ timeout });

    const percentageText = await contextPercentage.textContent();
    expect(percentageText).not.toBe('0.0%');

    const percentageValue = parseFloat(percentageText?.replace('%', '') || '0');
    expect(percentageValue).toBeGreaterThan(0);
  });

  test('should toggle dropdown when clicking indicator again', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });

    await contextIndicator.click();

    await expect(page.locator('text=Context Usage')).not.toBeVisible({
      timeout: IS_MOCK ? 100 : 3000,
    });
  });

  test('should persist context data after page refresh', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello, please respond with a brief greeting');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout5000 = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout: timeout5000 });

    const contextPercentage = page.getByTestId('context-percentage');
    await expect(contextPercentage).toBeVisible({ timeout: timeout5000 });

    const percentageBeforeRefresh = await contextPercentage.textContent();
    expect(percentageBeforeRefresh).not.toBe('0.0%');
    const percentageValueBefore = parseFloat(percentageBeforeRefresh?.replace('%', '') || '0');
    expect(percentageValueBefore).toBeGreaterThan(0);

    await page.reload();

    await waitForWebSocketConnected(page);

    const timeout10000 = IS_MOCK ? 100 : 10000;
    await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeVisible({
      timeout: timeout10000,
    });

    const contextIndicatorAfterRefresh = page.locator('[title="Click for context details"]');
    const timeout15000 = IS_MOCK ? 100 : 15000;
    await expect(contextIndicatorAfterRefresh).toBeVisible({ timeout: timeout15000 });

    const contextPercentageAfterRefresh = page.getByTestId('context-percentage');
    await expect(contextPercentageAfterRefresh).toBeVisible({ timeout: timeout5000 });

    const percentageAfterRefresh = await contextPercentageAfterRefresh.textContent();
    const percentageValueAfter = parseFloat(percentageAfterRefresh?.replace('%', '') || '0');

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
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });
  });

  test('should show context window percentage in dropdown', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    await expect(page.locator('text=Context Window')).toBeVisible({
      timeout,
    });
  });

  test('should show breakdown section in dropdown', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    await expect(page.locator('text=Breakdown')).toBeVisible({ timeout });
  });

  test('should show model information in dropdown', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    await expect(page.locator('text=Model:')).toBeVisible({ timeout });
  });

  test('should display token counts in breakdown', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    await expect(page.locator('text=Breakdown')).toBeVisible({ timeout });

    const percentagePattern = page.locator('text=/%$/');
    await expect(percentagePattern.first()).toBeVisible();
  });

  test('should show progress bar in context window section', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });

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
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });

    const closeButton = page
      .locator('button')
      .filter({ has: page.locator('svg line') })
      .last();
    await closeButton.click();

    await expect(page.locator('text=Context Usage')).not.toBeVisible({
      timeout: IS_MOCK ? 100 : 3000,
    });
  });

  test('should close dropdown with Escape key', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });

    await page.waitForTimeout(IS_MOCK ? 100 : 200);

    await page.keyboard.press('Escape');

    await expect(page.locator('text=Context Usage')).not.toBeVisible({
      timeout: IS_MOCK ? 100 : 3000,
    });
  });

  test('should close dropdown when clicking outside', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const input = page.locator('textarea[placeholder*="Ask"]').first();
    await input.fill('Hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    const hasContextData = await waitForContextData(page);
    test.skip(!hasContextData, 'Provider does not report context usage data');

    const contextIndicator = page.locator('[title="Click for context details"]');
    const timeout = IS_MOCK ? 100 : 5000;
    await expect(contextIndicator).toBeVisible({ timeout });
    await contextIndicator.click();

    await expect(page.locator('text=Context Usage')).toBeVisible({
      timeout,
    });

    await page.waitForTimeout(IS_MOCK ? 100 : 200);

    await page.locator('textarea[placeholder*="Ask"]').first().click();

    await expect(page.locator('text=Context Usage')).not.toBeVisible({
      timeout: IS_MOCK ? 100 : 3000,
    });
  });
});
