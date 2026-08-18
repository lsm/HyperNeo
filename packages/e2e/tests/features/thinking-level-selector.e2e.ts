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
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await expect(thinkingButton).toBeVisible({ timeout: 10000 });

    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Auto');
  });

  test('should open dropdown when clicking thinking level button', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();

    const dropdown = page.locator('text=Thinking Level');
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    await expect(page.locator('text=Auto')).toBeVisible();
    await expect(page.locator('text=Think 8k')).toBeVisible();
    await expect(page.locator('text=Think 16k')).toBeVisible();
    await expect(page.locator('text=Think 32k')).toBeVisible();
  });

  test('should select Think 8k level and persist', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();

    await expect(page.locator('text=Thinking Level')).toBeVisible();

    await page.locator('button:has-text("Think 8k")').click();

    await expect(page.locator('text=Thinking Level')).not.toBeVisible({
      timeout: 3000,
    });

    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Think 8k');
  });

  test('should select Think 16k level and persist', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();

    await expect(page.locator('text=Thinking Level')).toBeVisible();

    await page.locator('button:has-text("Think 16k")').click();

    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Think 16k');
  });

  test('should select Think 32k level and persist', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();

    await expect(page.locator('text=Thinking Level')).toBeVisible();

    await page.locator('button:has-text("Think 32k")').click();

    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Think 32k');
  });

  test('should return to Auto level', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');

    await thinkingButton.click();
    await expect(page.locator('text=Thinking Level')).toBeVisible();
    await page.locator('button:has-text("Think 8k")').click();
    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Think 8k');

    await thinkingButton.click();
    await expect(page.locator('text=Thinking Level')).toBeVisible();
    await page.locator('button:has-text("Auto")').first().click();

    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Auto');
  });

  test('should show current level indicator in dropdown', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');

    await thinkingButton.click();
    await page.locator('button:has-text("Think 16k")').click();

    await thinkingButton.click();
    await expect(page.locator('text=Thinking Level')).toBeVisible();

    const think16kOption = page.locator('button:has-text("Think 16k (current)")');
    await expect(think16kOption).toBeVisible();
  });

  test('should close dropdown when clicking button again', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();
    await expect(page.locator('text=Thinking Level')).toBeVisible();

    await thinkingButton.click();

    await expect(page.locator('text=Thinking Level')).not.toBeVisible({
      timeout: 3000,
    });
  });

  test('should close model dropdown when opening thinking dropdown', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const modelButton = page.locator('button[title^="Switch Model"]');
    await modelButton.click();
    await expect(page.locator('text=Select Model')).toBeVisible();

    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();

    await expect(page.locator('text=Select Model')).not.toBeVisible({
      timeout: 3000,
    });

    await expect(page.locator('text=Thinking Level')).toBeVisible();
  });

  test('should persist thinking level after page refresh', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const thinkingButton = page.locator('button[title^="Thinking:"]');
    await thinkingButton.click();
    await page.locator('button:has-text("Think 32k")').click();
    await expect(thinkingButton).toHaveAttribute('title', 'Thinking: Think 32k');

    await page.reload();

    await expect(page.locator('[aria-label="Daemon: Connected"]').first()).toBeVisible({
      timeout: 15000,
    });

    const sessionCard = page.locator(`[data-session-id="${sessionId}"]`).first();
    await sessionCard.click();

    const refreshedThinkingButton = page.locator('button[title^="Thinking:"]');
    await expect(refreshedThinkingButton).toBeVisible({ timeout: 10000 });

    await expect(refreshedThinkingButton).toHaveAttribute('title', 'Thinking: Think 32k', {
      timeout: 10000,
    });
  });
});
