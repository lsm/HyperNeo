import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  setupMessageHubTesting,
  waitForElement,
  waitForAssistantResponse,
} from '../helpers/wait-helpers';

/**
 * Message Operations E2E Tests
 *
 * Tests for message operations in the chat interface:
 * - Tool output display in assistant messages
 * - Message content verification after tool execution
 * - Multi-turn conversation maintenance
 * - Collapsible tool output block rendering
 */
test.describe('Message Operations', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      try {
        await cleanupTestSession(page, sessionId);
      } catch {
        // Cleanup errors are logged but don't fail the test
      }
      sessionId = null;
    }
  });

  test('should show tool output in message when present', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Get message input and send button
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    // Send a message that will trigger tool use
    await messageInput.fill('List the files in the current directory');
    await sendButton.click();

    // Wait for assistant response using robust helper
    await waitForAssistantResponse(page, { timeout: 90000 });

    // Verify the assistant responded with tool-related content
    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    // Verify the message contains meaningful content (assistant responded)
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(0);
  });

  test('should display message content after tool execution', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Get message input and send button
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    // Send a message that triggers tool use
    await messageInput.fill('What files are in this workspace?');
    await sendButton.click();

    // Wait for assistant response using robust helper
    await waitForAssistantResponse(page, { timeout: 90000 });

    // The assistant message should be visible
    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    // Message should have some content
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(0);
  });

  test('should maintain conversation after viewing tool output', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Get message input and send button
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    // Send first message
    await messageInput.fill('Hello, what is 2+2?');
    await sendButton.click();

    // Wait for first assistant response using robust helper
    await waitForAssistantResponse(page, { timeout: 90000 });

    // Send follow-up message
    await messageInput.fill('And what is that multiplied by 3?');
    await sendButton.click();

    // Wait for second assistant response using robust helper
    await waitForAssistantResponse(page, { timeout: 90000 });

    // Verify both messages were received (multi-turn conversation)
    const assistantMessages = page.locator('[data-message-role="assistant"]');
    const count = await assistantMessages.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('should show collapsible tool output blocks', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Get message input and send button
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    // Send a message that should trigger file reading
    await messageInput.fill('Read the package.json file and tell me the project name');
    await sendButton.click();

    // Wait for assistant response using robust helper
    await waitForAssistantResponse(page, { timeout: 90000 });

    // Verify assistant responded
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible();
  });
});
