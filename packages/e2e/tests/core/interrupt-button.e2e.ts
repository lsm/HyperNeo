/**
 * Interrupt Button E2E Tests
 *
 * Tests the stop/interrupt button functionality:
 * - Button visibility and state during agent processing
 * - Click to interrupt functionality
 * - Loading states and UI feedback
 * - Button transitions between send/stop states
 */

import { test, expect } from '../../fixtures';
import {
  setupMessageHubTesting,
  createSessionViaUI,
  waitForElement,
  cleanupTestSession,
} from '../helpers/wait-helpers';

// Check if devproxy mock mode is enabled
const IS_MOCK = process.env.NEOKAI_USE_DEV_PROXY === '1';

test.describe('Interrupt Button', () => {
  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test('should show stop button when agent is processing', async ({ page }) => {
    // Create a session
    const sessionId = await createSessionViaUI(page);

    // Initial state: should show send button (disabled, no content)
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

    // Send a message that will take time to process
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Write a detailed essay about quantum computing.');
    await page.click('[data-testid="send-button"]');

    // Wait for agent to start processing
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Stop button should now be visible, send button hidden
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

    // Interrupt to clean up
    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await cleanupTestSession(page, sessionId);
  });

  test('should have clickable stop button (not disabled) when agent is processing', async ({
    page,
  }) => {
    // Create a session
    const sessionId = await createSessionViaUI(page);

    // Send a message
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain machine learning in detail.');
    await page.click('[data-testid="send-button"]');

    // Wait for processing to start
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Stop button should be visible
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // CRITICAL: Stop button should NOT be disabled
    await expect(stopButton).toBeEnabled();

    // Verify it's not grayed out by checking it doesn't have disabled class
    const isGrayedOut = await stopButton.evaluate((el) => {
      const classes = el.className;
      return classes.includes('cursor-not-allowed') || classes.includes('opacity-50');
    });
    expect(isGrayedOut).toBe(false);

    // Verify it has the red color (not gray)
    const hasRedBackground = await stopButton.evaluate((el) => {
      const classes = el.className;
      return classes.includes('bg-red-500');
    });
    expect(hasRedBackground).toBe(true);

    // Clean up
    await stopButton.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await cleanupTestSession(page, sessionId);
  });

  test('should interrupt agent when stop button is clicked', async ({ page }) => {
    // Create a session
    const sessionId = await createSessionViaUI(page);

    // Send a long message
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill(
      'Write a comprehensive guide to distributed systems, including CAP theorem, consensus algorithms, and practical examples.'
    );
    await page.click('[data-testid="send-button"]');

    // Wait for processing to start - stop button should appear
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 10000 });

    // Click stop button
    await stopButton.click();

    // Send button should return (agent is idle again) - this is the key indicator of successful interrupt
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
      timeout: 15000,
    });

    // Input should be enabled
    await expect(messageInput).toBeEnabled();

    await cleanupTestSession(page, sessionId);
  });

  test('should toggle between stop and send button based on input content while agent is running', async ({
    page,
  }) => {
    // Create a session
    const sessionId = await createSessionViaUI(page);

    // Send a message to start agent processing
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain neural networks in depth.');
    await page.click('[data-testid="send-button"]');

    // Wait for agent to start: stop button appears (agent running, input empty after send)
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 10000 });

    // Stop button visible, send button NOT visible (agent running + empty input)
    await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

    // Type text while agent is running → send button should appear, stop button disappear
    await messageInput.fill('some follow-up text');
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 3000 });
    await expect(stopButton).not.toBeVisible();

    // Clear the text → stop button returns, send button disappears
    await messageInput.fill('');
    await expect(stopButton).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

    // Click stop to interrupt → send button returns after interrupt completes
    await stopButton.click();
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 15000 });
    await expect(stopButton).not.toBeVisible();

    await cleanupTestSession(page, sessionId);
  });

  test('should transition from send to stop and back to send', async ({ page }) => {
    // Create a session
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');

    // Initial state: send button visible (but disabled due to no content)
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

    // Type message: send button should be enabled
    await messageInput.fill('Test message');
    await expect(page.locator('[data-testid="send-button"]')).toBeEnabled();

    // Send message
    await page.click('[data-testid="send-button"]');

    // Wait for processing: stop button should appear
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

    // Interrupt
    await page.click('[data-testid="stop-button"]');

    // Wait for idle: send button should return
    await page.waitForTimeout(IS_MOCK ? 100 : 2000);
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should handle rapid interrupt attempts gracefully', async ({ page }) => {
    // TODO: This test is flaky because rapid clicks can cause the browser context to close unexpectedly
    // Create a session
    const sessionId = await createSessionViaUI(page);

    // Send a long message that will take time to process
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill(
      'Write an essay about climate change, including scientific evidence, political responses, and economic impacts. Make it comprehensive.'
    );
    await page.click('[data-testid="send-button"]');

    // Wait for processing to start
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 10000 });

    // Try to click multiple times rapidly - additional clicks may fail if button is already hidden
    await stopButton.click();
    await stopButton.click().catch(() => {});
    await stopButton.click().catch(() => {});

    // Should eventually return to idle state (send button visible)
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
      timeout: 20000,
    });

    await cleanupTestSession(page, sessionId);
  });
});
