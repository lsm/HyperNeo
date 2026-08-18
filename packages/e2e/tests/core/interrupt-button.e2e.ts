import { test, expect } from '../../fixtures';
import {
  setupMessageHubTesting,
  createSessionViaUI,
  waitForElement,
  cleanupTestSession,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

test.describe('Interrupt Button', () => {
  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test('should show stop button when agent is processing', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Write a detailed essay about quantum computing.');
    await page.click('[data-testid="send-button"]');

    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await cleanupTestSession(page, sessionId);
  });

  test('should have clickable stop button (not disabled) when agent is processing', async ({
    page,
  }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain machine learning in detail.');
    await page.click('[data-testid="send-button"]');

    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    await expect(stopButton).toBeEnabled();

    const isGrayedOut = await stopButton.evaluate((el) => {
      const classes = el.className;
      return classes.includes('cursor-not-allowed') || classes.includes('opacity-50');
    });
    expect(isGrayedOut).toBe(false);

    const hasRedBackground = await stopButton.evaluate((el) => {
      const classes = el.className;
      return classes.includes('bg-red-500');
    });
    expect(hasRedBackground).toBe(true);

    await stopButton.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await cleanupTestSession(page, sessionId);
  });

  test('should interrupt agent when stop button is clicked', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill(
      'Write a comprehensive guide to distributed systems, including CAP theorem, consensus algorithms, and practical examples.'
    );
    await page.click('[data-testid="send-button"]');

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 10000 });

    await stopButton.click();

    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
      timeout: 15000,
    });

    await expect(messageInput).toBeEnabled();

    await cleanupTestSession(page, sessionId);
  });

  test('should toggle between stop and send button based on input content while agent is running', async ({
    page,
  }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain neural networks in depth.');
    await page.click('[data-testid="send-button"]');

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 10000 });

    await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

    await messageInput.fill('some follow-up text');
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 3000 });
    await expect(stopButton).not.toBeVisible();

    await messageInput.fill('');
    await expect(stopButton).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

    await stopButton.click();
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 15000 });
    await expect(stopButton).not.toBeVisible();

    await cleanupTestSession(page, sessionId);
  });

  test('should transition from send to stop and back to send', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');

    await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

    await messageInput.fill('Test message');
    await expect(page.locator('[data-testid="send-button"]')).toBeEnabled();

    await page.click('[data-testid="send-button"]');

    await page.waitForTimeout(IS_MOCK ? 100 : 1000);
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

    await page.click('[data-testid="stop-button"]');

    await page.waitForTimeout(IS_MOCK ? 100 : 2000);
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should handle rapid interrupt attempts gracefully', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill(
      'Write an essay about climate change, including scientific evidence, political responses, and economic impacts. Make it comprehensive.'
    );
    await page.click('[data-testid="send-button"]');

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 10000 });

    await stopButton.click();
    await stopButton.click().catch(() => {});
    await stopButton.click().catch(() => {});

    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
      timeout: 20000,
    });

    await cleanupTestSession(page, sessionId);
  });
});
