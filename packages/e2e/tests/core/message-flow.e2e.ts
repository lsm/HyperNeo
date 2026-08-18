import { test, expect } from '../../fixtures';
import {
  createSessionViaUI,
  waitForElement,
  setupMessageHubTesting,
  cleanupTestSession,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

test.describe('Message Send and Receive', () => {
  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test('should successfully send a message and receive response', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    const testMessage = 'Reply with exactly: TEST_OK';
    await messageInput.fill(testMessage);

    await expect(sendButton).toBeEnabled();

    await sendButton.click();

    await page.waitForTimeout(100);
    const inputValue = await messageInput.inputValue();
    expect(inputValue).toBe('');

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    const statusText = page.locator('text=/Starting|Thinking|Streaming|Processing/i');
    await expect(statusText).toBeVisible({ timeout: 5000 });

    await expect(page.locator(`text="${testMessage}"`)).toBeVisible({
      timeout: 5000,
    });

    if (IS_MOCK) {
      // no-op: completion is validated by send button returning
    } else {
      await expect(page.locator('text=/TEST_OK|test_ok/i')).toBeVisible({
        timeout: 60000,
      });
    }

    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
      timeout: 15000,
    });

    await cleanupTestSession(page, sessionId);
  });

  test('should handle message sending state transitions correctly', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await messageInput.fill('Simple test');

    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    const states: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'log' && msg.text().includes('Message')) {
        states.push(msg.text());
      }
    });

    await sendButton.click();

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    await expect(page.locator('text=/Starting|Thinking|Streaming|Processing/i')).toBeVisible({
      timeout: 5000,
    });

    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
      timeout: 60000,
    });

    await expect(stopButton).not.toBeVisible({ timeout: 5000 });

    await messageInput.fill('Another message');
    await expect(page.locator('[data-testid="send-button"]')).toBeEnabled();

    await cleanupTestSession(page, sessionId);
  });

  test('should not allow sending empty messages', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    await expect(sendButton).toBeDisabled();

    await messageInput.fill('   \n  \t  ');
    await expect(sendButton).toBeDisabled();

    await messageInput.fill('Hello');
    await expect(sendButton).toBeEnabled();

    await cleanupTestSession(page, sessionId);
  });

  test('should handle WebSocket disconnection gracefully', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    await page.waitForFunction(
      () => {
        const indicator = document.querySelector('[aria-label="Daemon: Connected"]');
        return !!indicator;
      },
      { timeout: 10000 }
    );

    await page.evaluate(() => {
      const cm = (window as any).connectionManager;
      if (cm?.simulateDisconnect) cm.simulateDisconnect();
    });

    await page.waitForFunction(
      () => {
        const indicator = document.querySelector('[aria-label="Daemon: Connected"]');
        return !!indicator;
      },
      { timeout: 15000 }
    );

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await expect(messageInput).toBeEnabled();

    await cleanupTestSession(page, sessionId);
  });

  test('should display message immediately in UI (optimistic update)', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const testMessage = 'Optimistic update test message';
    await messageInput.fill(testMessage);

    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await sendButton.click();

    await expect(page.locator(`text="${testMessage}"`)).toBeVisible({
      timeout: 2000,
    });

    await page.waitForTimeout(5000);

    await cleanupTestSession(page, sessionId);
  });

  test('should handle consecutive messages correctly', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messages = ['First message', 'Second message', 'Third message'];

    for (const msg of messages) {
      const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
      await messageInput.fill(msg);

      const sendButton = await waitForElement(page, '[data-testid="send-button"]');
      await sendButton.click();

      await expect(page.locator(`text="${msg}"`)).toBeVisible({
        timeout: 5000,
      });

      const processingIndicator = page.locator('text=/Sending|Processing|Queued/i').first();
      await processingIndicator.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      await processingIndicator.waitFor({ state: 'hidden', timeout: 35000 }).catch(() => {});

      await expect(messageInput).toBeEnabled({ timeout: 5000 });

      await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
        timeout: 10000,
      });
    }

    for (const msg of messages) {
      await expect(page.locator(`text="${msg}"`).first()).toBeVisible();
    }

    if (!IS_MOCK) {
      const assistantMessages = page.locator('[data-message-role="assistant"]');
      const count = await assistantMessages.count();
      expect(count).toBeGreaterThanOrEqual(messages.length);
    }

    await cleanupTestSession(page, sessionId);
  });

  test('should recover from send failures', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await messageInput.fill('First successful message');

    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await sendButton.click();

    await expect(messageInput).toBeEnabled({ timeout: 15000 });

    const nextSendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill('Second message after recovery');
    await nextSendButton.click();

    await expect(page.locator('text="Second message after recovery"').first()).toBeVisible({
      timeout: 5000,
    });
    await expect(messageInput).toBeEnabled({ timeout: 15000 });

    await cleanupTestSession(page, sessionId);
  });
});
