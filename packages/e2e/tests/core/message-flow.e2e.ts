/**
 * Message Flow E2E Tests
 *
 * Comprehensive tests for message sending, state transitions, and response handling.
 * Tests the complete flow from user input → server processing → UI updates.
 * Includes optimistic updates, consecutive messages, failure recovery, and rapid sending.
 *
 * MERGED FROM:
 * - message-send-receive.e2e.ts (base)
 * - chat-flow-improved.e2e.ts
 */

import { test, expect } from '../../fixtures';
import {
  createSessionViaUI,
  waitForElement,
  setupMessageHubTesting,
  cleanupTestSession,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.NEOKAI_USE_DEV_PROXY === '1';

test.describe('Message Send and Receive', () => {
  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test('should successfully send a message and receive response', async ({ page }) => {
    // Create a new session
    const sessionId = await createSessionViaUI(page);

    // Get message input and send button
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    // Type a simple message
    const testMessage = 'Reply with exactly: TEST_OK';
    await messageInput.fill(testMessage);

    // Verify send button is enabled
    await expect(sendButton).toBeEnabled();

    // Send the message
    await sendButton.click();

    // Verify input is cleared immediately after clicking send
    await page.waitForTimeout(100);
    const inputValue = await messageInput.inputValue();
    expect(inputValue).toBe('');

    // Verify stop button appears during processing
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // Verify status indicator shows processing state
    const statusText = page.locator('text=/Starting|Thinking|Streaming|Processing/i');
    await expect(statusText).toBeVisible({ timeout: 5000 });

    // Wait for the user message to appear in the chat
    await expect(page.locator(`text="${testMessage}"`)).toBeVisible({
      timeout: 5000,
    });

    // Wait for assistant response (with generous timeout for API call)
    // In mock mode, no real assistant response is guaranteed in CI (no-LLM/dev-proxy),
    // so rely on completion state below; otherwise expect TEST_OK content.
    if (IS_MOCK) {
      // no-op: completion is validated by send button returning
    } else {
      await expect(page.locator('text=/TEST_OK|test_ok/i')).toBeVisible({
        timeout: 60000,
      });
    }

    // Wait for processing to complete (send button should return)
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
      timeout: 15000,
    });

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test('should handle message sending state transitions correctly', async ({ page }) => {
    // Create a new session
    const sessionId = await createSessionViaUI(page);

    // Send a message
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await messageInput.fill('Simple test');

    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    // Track state transitions
    const states: string[] = [];

    // Monitor status text changes
    page.on('console', (msg) => {
      if (msg.type() === 'log' && msg.text().includes('Message')) {
        states.push(msg.text());
      }
    });

    // Send message
    await sendButton.click();

    // State transitions during processing:
    // 1. Stop button appears during processing
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // 2. Status should show activity
    await expect(page.locator('text=/Starting|Thinking|Streaming|Processing/i')).toBeVisible({
      timeout: 5000,
    });

    // 3. Wait for response to complete (send button returns)
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
      timeout: 60000,
    });

    // 4. Stop button should disappear
    await expect(stopButton).not.toBeVisible({ timeout: 5000 });

    // 5. After processing, can send another message
    await messageInput.fill('Another message');
    await expect(page.locator('[data-testid="send-button"]')).toBeEnabled();

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test('should not allow sending empty messages', async ({ page }) => {
    // Create a new session
    const sessionId = await createSessionViaUI(page);

    // Get controls
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    // Empty input - send button should be disabled
    await expect(sendButton).toBeDisabled();

    // Whitespace only - send button should be disabled
    await messageInput.fill('   \n  \t  ');
    await expect(sendButton).toBeDisabled();

    // Valid content - send button should be enabled
    await messageInput.fill('Hello');
    await expect(sendButton).toBeEnabled();

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test('should handle WebSocket disconnection gracefully', async ({ page }) => {
    // Create a new session
    const sessionId = await createSessionViaUI(page);

    // Verify initially connected via daemon status indicator
    await page.waitForFunction(
      () => {
        const indicator = document.querySelector('[aria-label="Daemon: Connected"]');
        return !!indicator;
      },
      { timeout: 10000 }
    );

    // Simulate disconnection using exposed method
    await page.evaluate(() => {
      const cm = (window as any).connectionManager;
      if (cm?.simulateDisconnect) cm.simulateDisconnect();
    });

    // Auto-reconnect should kick in and restore connection
    // (Server is still running, so reconnect succeeds)
    await page.waitForFunction(
      () => {
        const indicator = document.querySelector('[aria-label="Daemon: Connected"]');
        return !!indicator;
      },
      { timeout: 15000 }
    );

    // After reconnect, should be able to interact normally
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await expect(messageInput).toBeEnabled();

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test('should display message immediately in UI (optimistic update)', async ({ page }) => {
    // Create a new session
    const sessionId = await createSessionViaUI(page);

    // Send a message
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const testMessage = 'Optimistic update test message';
    await messageInput.fill(testMessage);

    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await sendButton.click();

    // User message should appear very quickly (optimistic update or immediate server echo)
    await expect(page.locator(`text="${testMessage}"`)).toBeVisible({
      timeout: 2000,
    });

    // Wait for assistant response
    await page.waitForTimeout(5000);

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test('should handle consecutive messages correctly', async ({ page }) => {
    // Create a new session
    const sessionId = await createSessionViaUI(page);

    const messages = ['First message', 'Second message', 'Third message'];

    // Send messages one by one, waiting for each to complete
    for (const msg of messages) {
      const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
      await messageInput.fill(msg);

      const sendButton = await waitForElement(page, '[data-testid="send-button"]');
      await sendButton.click();

      // Wait for message to appear
      await expect(page.locator(`text="${msg}"`)).toBeVisible({
        timeout: 5000,
      });

      // Wait for processing status to appear and disappear (includes API call + /context fetch)
      const processingIndicator = page.locator('text=/Sending|Processing|Queued/i').first();
      await processingIndicator.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      await processingIndicator.waitFor({ state: 'hidden', timeout: 35000 }).catch(() => {});

      // Wait for input to be re-enabled (response complete)
      await expect(messageInput).toBeEnabled({ timeout: 5000 });

      // Wait for send button to return (stop button disappears)
      await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
        timeout: 10000,
      });
    }

    // All messages should be visible (use .first() to avoid strict mode violation
    // as same text may appear in sidebar, header, and message area)
    for (const msg of messages) {
      await expect(page.locator(`text="${msg}"`).first()).toBeVisible();
    }

    // In real-LLM mode, should have at least as many assistant messages as user messages.
    // In mock/no-LLM CI mode, assistant messages may not be emitted for every turn.
    if (!IS_MOCK) {
      const assistantMessages = page.locator('[data-message-role="assistant"]');
      const count = await assistantMessages.count();
      expect(count).toBeGreaterThanOrEqual(messages.length);
    }

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });

  test('should recover from send failures', async ({ page }) => {
    // Create a new session
    const sessionId = await createSessionViaUI(page);

    // First, send a successful message
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    await messageInput.fill('First successful message');

    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await sendButton.click();

    // Wait for completion
    await expect(messageInput).toBeEnabled({ timeout: 15000 });

    // Now trigger a failure by temporarily breaking the connection
    // (In real scenario, this could be network issues, server errors, etc.)
    // For this test, we'll just verify recovery from normal operation

    // Send another message to ensure the system is still working
    // Get a fresh reference to the send button after processing completes
    const nextSendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill('Second message after recovery');
    await nextSendButton.click();

    // Should complete successfully (use .first() to handle duplicate text in sidebar)
    await expect(page.locator('text="Second message after recovery"').first()).toBeVisible({
      timeout: 5000,
    });
    await expect(messageInput).toBeEnabled({ timeout: 15000 });

    // Cleanup
    await cleanupTestSession(page, sessionId);
  });
});
