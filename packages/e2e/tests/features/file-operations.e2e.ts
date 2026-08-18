import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForWebSocketConnected,
  waitForElement,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

test.describe('File Operations', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
    await waitForWebSocketConnected(page);
    sessionId = null;
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

  test('should be able to read files through Claude', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill('What is in the package.json file? Just show me the name and version.');
    await sendButton.click();

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: IS_MOCK ? 60000 : 45000,
    });

    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();

    if (!IS_MOCK) {
      expect(content!.length).toBeGreaterThan(10);
    }
  });

  test('should be able to list directory contents through Claude', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill('List the files in the current directory. Just show file names.');
    await sendButton.click();

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: IS_MOCK ? 60000 : 45000,
    });

    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();

    if (!IS_MOCK) {
      expect(content!.length).toBeGreaterThan(0);
    }
  });

  test('should display file content in response', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill(
      'Show me the first 5 lines of README.md or any markdown file you can find.'
    );
    await sendButton.click();

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: IS_MOCK ? 30000 : 45000,
    });

    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();
  });

  test('should handle file not found gracefully', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill('Read the file nonexistent_file_12345.xyz');
    await sendButton.click();

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: IS_MOCK ? 30000 : 45000,
    });

    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();

    if (!IS_MOCK) {
      const contentLower = content!.toLowerCase();
      const hasFileReference =
        contentLower.includes('file') ||
        contentLower.includes('not found') ||
        contentLower.includes("doesn't exist") ||
        contentLower.includes('does not exist') ||
        contentLower.includes('no such') ||
        contentLower.includes('unable') ||
        contentLower.includes('cannot') ||
        contentLower.includes("couldn't") ||
        contentLower.includes("can't") ||
        contentLower.includes('error') ||
        contentLower.includes('nonexistent') ||
        contentLower.includes('create') ||
        contentLower.includes('empty');

      expect(hasFileReference).toBe(true);
    }
  });

  test('should work with relative and absolute paths', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill("What's the current working directory? Just tell me the path.");
    await sendButton.click();

    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: IS_MOCK ? 30000 : 45000,
    });

    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();

    if (!IS_MOCK) {
      expect(
        content!.includes('/') ||
          content!.toLowerCase().includes('directory') ||
          content!.toLowerCase().includes('workspace') ||
          content!.toLowerCase().includes('path')
      ).toBe(true);
    }
  });
});
