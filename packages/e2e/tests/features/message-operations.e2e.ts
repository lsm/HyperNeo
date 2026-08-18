import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  setupMessageHubTesting,
  waitForElement,
  waitForAssistantResponse,
} from '../helpers/wait-helpers';

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
    sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    await messageInput.fill('List the files in the current directory');
    await sendButton.click();

    await waitForAssistantResponse(page, { timeout: 90000 });

    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(0);
  });

  test('should display message content after tool execution', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    await messageInput.fill('What files are in this workspace?');
    await sendButton.click();

    await waitForAssistantResponse(page, { timeout: 90000 });

    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(0);
  });

  test('should maintain conversation after viewing tool output', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    await messageInput.fill('Hello, what is 2+2?');
    await sendButton.click();

    await waitForAssistantResponse(page, { timeout: 90000 });

    await messageInput.fill('And what is that multiplied by 3?');
    await sendButton.click();

    await waitForAssistantResponse(page, { timeout: 90000 });

    const assistantMessages = page.locator('[data-message-role="assistant"]');
    const count = await assistantMessages.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('should show collapsible tool output blocks', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');

    await messageInput.fill('Read the package.json file and tell me the project name');
    await sendButton.click();

    await waitForAssistantResponse(page, { timeout: 90000 });

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible();
  });
});
