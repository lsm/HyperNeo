import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

test.describe('Session Export', () => {
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

  test('should show Export Chat option in session options menu', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const optionsButton = page.getByTitle('Session options');
    await expect(optionsButton).toBeVisible();
    await optionsButton.click();

    await expect(page.locator('text=Export Chat')).toBeVisible();
  });

  test('should export session to Markdown file', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageText = 'Hello, this is a test message for export.';
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    const sendButton = page.locator('[data-testid="send-button"]').first();
    await messageInput.fill(messageText);
    await sendButton.click();

    await expect(page.locator(`text="${messageText}"`).first()).toBeVisible({
      timeout: 5000,
    });

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    const downloadPromise = page.waitForEvent('download');

    const optionsButton = page.getByTitle('Session options');
    await optionsButton.click();
    await page.locator('text=Export Chat').click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('.md');
  });

  test('should include messages in exported Markdown', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const testMessage = 'Unique export test message ' + Date.now();
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    const sendButton = page.locator('[data-testid="send-button"]').first();
    await messageInput.fill(testMessage);
    await sendButton.click();

    await expect(page.locator(`text="${testMessage}"`).first()).toBeVisible({
      timeout: 5000,
    });

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    const downloadPromise = page.waitForEvent('download');

    const optionsButton = page.getByTitle('Session options');
    await optionsButton.click();
    await page.locator('text=Export Chat').click();

    const download = await downloadPromise;
    const content = await download.createReadStream().then(async (stream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf-8');
    });

    expect(content).toContain(testMessage);
  });

  test('should show success toast after export', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageText = 'Test message for toast';
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    const sendButton = page.locator('[data-testid="send-button"]').first();
    await messageInput.fill(messageText);
    await sendButton.click();

    await expect(page.locator(`text="${messageText}"`).first()).toBeVisible({
      timeout: 5000,
    });

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    const downloadPromise = page.waitForEvent('download');

    const optionsButton = page.getByTitle('Session options');
    await optionsButton.click();
    await page.locator('text=Export Chat').click();

    await downloadPromise;

    await expect(page.locator('text=Chat exported!')).toBeVisible({
      timeout: 5000,
    });
  });

  test('should disable Export when disconnected', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const optionsButton = page.getByTitle('Session options');
    await optionsButton.click();
    const exportOption = page.locator('[role="menuitem"]:has-text("Export Chat")');
    await expect(exportOption).toBeVisible();
    await expect(exportOption).not.toBeDisabled();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      (
        window as unknown as {
          connectionManager: { simulatePermanentDisconnect: () => void };
        }
      ).connectionManager.simulatePermanentDisconnect();
    });

    await expect(page.locator('text=Offline').first()).toBeVisible({
      timeout: 10000,
    });

    const disabledOptionsButton = page.getByRole('button', { name: 'Not connected' }).first();
    await expect(disabledOptionsButton).toBeDisabled();
  });
});
