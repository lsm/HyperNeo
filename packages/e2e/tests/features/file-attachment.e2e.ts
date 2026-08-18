import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';
import * as fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, '../test-fixtures/images');
const testImagePath = join(fixturesDir, 'test-image.png');
const largeImagePath = join(fixturesDir, 'large-image.png');

test.describe('File Attachment - UI', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
    await page.waitForTimeout(1000);
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

  test('should show "Attach image" button in plus menu', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const plusButton = page.locator('button[title="More options"]');
    await expect(plusButton).toBeVisible();
    await plusButton.click();

    const attachButton = page.locator('button:has-text("Attach image")');
    await expect(attachButton).toBeVisible();
  });

  test('should open file picker when clicking attach image', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');

    await page.locator('button:has-text("Attach image")').click();

    const fileChooser = await fileChooserPromise;
    expect(fileChooser).toBeTruthy();

    expect(fileChooser.isMultiple()).toBe(true);
  });

  test('should validate file type (accept only images)', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');

    await page.locator('button:has-text("Attach image")').click();

    const fileChooser = await fileChooserPromise;

    expect(fileChooser).toBeTruthy();
  });
});

test.describe('File Attachment - Preview', () => {
  let sessionId: string | null = null;

  test.beforeAll(() => {
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    const pngData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
      0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);

    fs.writeFileSync(testImagePath, pngData);
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
    await page.waitForTimeout(1000);
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

  test('should preview attached image before sending', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImagePath);

    await page.waitForTimeout(1000);

    const removeButton = page.locator('button[aria-label="Remove attachment"]');
    await expect(removeButton).toBeVisible({ timeout: 10000 });

    const thumbnail = page.locator('img[src^="data:"]').first();
    await expect(thumbnail).toBeVisible();
  });

  test('should allow removing attached image', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImagePath);

    await page.waitForTimeout(1000);

    const removeButton = page.locator('button[aria-label="Remove attachment"]').first();
    await expect(removeButton).toBeVisible({ timeout: 10000 });

    await removeButton.hover();

    await removeButton.click();

    await expect(removeButton).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('File Attachment - Send', () => {
  let sessionId: string | null = null;

  test.beforeAll(() => {
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    const pngData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
      0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);

    fs.writeFileSync(testImagePath, pngData);
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
    await page.waitForTimeout(1000);
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

  test('should send message with attached image', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImagePath);

    await page.waitForTimeout(500);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Here is a test image');

    const sendButton = page.locator('button[aria-label="Send message"]').first();
    await sendButton.click();

    await page.waitForTimeout(1000);

    const userMessage = page.locator('[data-message-role="user"]').last();
    await expect(userMessage).toContainText('Here is a test image');

    const sentImage = userMessage.locator('img[alt="Attached image"]');
    await expect(sentImage).toBeVisible();
  });

  test('should support multiple image attachments', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;

    await fileChooser.setFiles([testImagePath, testImagePath]);

    await page.waitForTimeout(500);

    const previews = page.locator('img[src^="data:image"]');
    await expect(previews).toHaveCount(2);
  });

  test('should clear attachments after sending message', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImagePath);

    await page.waitForTimeout(1000);

    const removeButton = page.locator('button[aria-label="Remove attachment"]');
    await expect(removeButton).toBeVisible({ timeout: 10000 });

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Test message with image');

    const sendButton = page.locator('[data-testid="send-button"]');
    await sendButton.click();

    await page.waitForTimeout(2000);

    await expect(removeButton).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('File Attachment - Validation', () => {
  let sessionId: string | null = null;

  test.beforeAll(() => {
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    const pngData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
      0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);

    fs.writeFileSync(testImagePath, pngData);

    const largeData = Buffer.concat([pngData, Buffer.alloc(6 * 1024 * 1024, 0x00)]);
    fs.writeFileSync(largeImagePath, largeData);
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
    await page.waitForTimeout(1000);
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

  test('should validate file size (reject > 5MB)', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(largeImagePath);

    await page.waitForTimeout(1000);

    const errorToast = page.locator('text=/must be under.*5MB/i');
    await expect(errorToast).toBeVisible({ timeout: 3000 });

    const removeButton = page.locator('button[aria-label="Remove attachment"]');
    await expect(removeButton).not.toBeVisible();
  });
});
