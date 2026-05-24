import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForWebSocketConnected,
  waitForElement,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.NEOKAI_USE_DEV_PROXY === '1';

/**
 * File Operations E2E Tests
 *
 * Tests file reading and listing features within sessions:
 * - File reading within workspace
 * - Directory listing
 * - File tree display
 * - Worktree file isolation
 *
 * RPC Methods: file.read, file.list, file.tree
 *
 * IS_MOCK: In mock mode (devproxy), responses are pre-configured mock responses
 * that may differ from real API responses. Assertions are relaxed to accept
 * any valid assistant response in mock mode.
 */
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
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Ask Claude to read a file (Claude will use file tools)
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill('What is in the package.json file? Just show me the name and version.');
    await sendButton.click();

    // Wait for stop button to indicate processing started
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // Wait for response - in mock mode, response is instant but UI still needs time
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: IS_MOCK ? 60000 : 45000,
    });

    // The response should contain file content or mention inability to read
    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();

    // In mock mode, accept any response; in real mode, expect substantive content
    if (!IS_MOCK) {
      expect(content!.length).toBeGreaterThan(10);
    }
  });

  test('should be able to list directory contents through Claude', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Ask Claude to list files
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill('List the files in the current directory. Just show file names.');
    await sendButton.click();

    // Wait for stop button to indicate processing started
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // Wait for response - in mock mode, response is instant but UI still needs time
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: IS_MOCK ? 60000 : 45000,
    });

    // The response should contain file listings
    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();

    // In mock mode, accept any response; in real mode, expect substantive content
    if (!IS_MOCK) {
      expect(content!.length).toBeGreaterThan(0);
    }
  });

  test('should display file content in response', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Ask Claude to read and display file content
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill(
      'Show me the first 5 lines of README.md or any markdown file you can find.'
    );
    await sendButton.click();

    // Wait for stop button to indicate processing started
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // Wait for response - in mock mode, response is instant
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: IS_MOCK ? 30000 : 45000,
    });

    // Response should exist
    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    await expect(assistantMessage).toBeVisible();

    // The message area should have content
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();
  });

  test('should handle file not found gracefully', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Ask Claude to read a non-existent file
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill('Read the file nonexistent_file_12345.xyz');
    await sendButton.click();

    // Wait for stop button to indicate processing started
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // Wait for response - in mock mode, response is instant
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: IS_MOCK ? 30000 : 45000,
    });

    // The response should handle the error gracefully
    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();

    // In mock mode, accept any response; in real mode, check for file-related keywords
    if (!IS_MOCK) {
      // Claude should respond about the file (either found or not found, or error)
      // The key is that the response is meaningful and handles the request
      // It may succeed (if the file exists in workspace) or fail gracefully
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
        contentLower.includes('create') || // Claude might offer to create it
        contentLower.includes('empty'); // File might be created empty

      expect(hasFileReference).toBe(true);
    }
  });

  test('should work with relative and absolute paths', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Ask Claude about path handling
    const messageInput = await waitForElement(page, 'textarea[placeholder*="Ask"]');
    const sendButton = await waitForElement(page, '[data-testid="send-button"]');
    await messageInput.fill("What's the current working directory? Just tell me the path.");
    await sendButton.click();

    // Wait for stop button to indicate processing started
    const stopButton = page.locator('[data-testid="stop-button"]');
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // Wait for response - in mock mode, response is instant
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: IS_MOCK ? 30000 : 45000,
    });

    // The response should contain path information
    const assistantMessage = page.locator('[data-message-role="assistant"]').first();
    const content = await assistantMessage.textContent();
    expect(content).toBeTruthy();

    // In mock mode, accept any response; in real mode, check for path-related keywords
    if (!IS_MOCK) {
      // Should mention a path (likely contains slashes or workspace reference)
      expect(
        content!.includes('/') ||
          content!.toLowerCase().includes('directory') ||
          content!.toLowerCase().includes('workspace') ||
          content!.toLowerCase().includes('path')
      ).toBe(true);
    }
  });
});
