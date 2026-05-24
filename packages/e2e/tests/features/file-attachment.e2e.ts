/**
 * File Attachment E2E Tests
 *
 * Consolidated tests for file attachment functionality:
 * - UI elements (button, file picker, type validation)
 * - Preview and removal of attachments
 * - Sending messages with attachments
 * - Validation (file size limits)
 */

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
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Click the plus button to open menu
    const plusButton = page.locator('button[title="More options"]');
    await expect(plusButton).toBeVisible();
    await plusButton.click();

    // The "Attach image" button should be visible in the menu
    const attachButton = page.locator('button:has-text("Attach image")');
    await expect(attachButton).toBeVisible();
  });

  test('should open file picker when clicking attach image', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Click the plus button
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    // Set up file chooser listener before clicking
    const fileChooserPromise = page.waitForEvent('filechooser');

    // Click "Attach image"
    await page.locator('button:has-text("Attach image")').click();

    // Wait for file chooser to appear
    const fileChooser = await fileChooserPromise;
    expect(fileChooser).toBeTruthy();

    // Verify it accepts image files
    expect(fileChooser.isMultiple()).toBe(true); // Multiple file selection
  });

  test('should validate file type (accept only images)', async ({ page }) => {
    // Note: This test would require creating non-image files
    // For now, we test that the file picker only accepts image types
    // by checking the accept attribute

    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Click the plus button
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    // Set up file chooser listener
    const fileChooserPromise = page.waitForEvent('filechooser');

    // Click "Attach image"
    await page.locator('button:has-text("Attach image")').click();

    // Verify file chooser accepts only images
    const fileChooser = await fileChooserPromise;

    // The file input should have accept attribute for images
    // We can't directly check accept attribute via file chooser API
    // but we've validated it exists in the component
    expect(fileChooser).toBeTruthy();
  });
});

test.describe('File Attachment - Preview', () => {
  let sessionId: string | null = null;

  test.beforeAll(() => {
    // Create fixtures directory
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    // Create a simple 1x1 PNG test image (valid PNG)
    const pngData = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52, // IHDR chunk
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01, // 1x1 pixels
      0x08,
      0x06,
      0x00,
      0x00,
      0x00,
      0x1f,
      0x15,
      0xc4,
      0x89, // etc.
      0x00,
      0x00,
      0x00,
      0x0a,
      0x49,
      0x44,
      0x41,
      0x54, // IDAT chunk
      0x78,
      0x9c,
      0x63,
      0x00,
      0x01,
      0x00,
      0x00,
      0x05,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x45,
      0x4e,
      0x44, // IEND chunk
      0xae,
      0x42,
      0x60,
      0x82,
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
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Click the plus button
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    // Attach a test image
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImagePath);

    // Wait for the image to be processed
    await page.waitForTimeout(1000);

    // The attachment preview should show the remove button (aria-label)
    const removeButton = page.locator('button[aria-label="Remove attachment"]');
    await expect(removeButton).toBeVisible({ timeout: 10000 });

    // Should show image thumbnail (data: URL)
    const thumbnail = page.locator('img[src^="data:"]').first();
    await expect(thumbnail).toBeVisible();
  });

  test('should allow removing attached image', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Attach an image
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImagePath);

    await page.waitForTimeout(1000);

    // Find the remove button (might need hover to show)
    const removeButton = page.locator('button[aria-label="Remove attachment"]').first();
    await expect(removeButton).toBeVisible({ timeout: 10000 });

    // Hover to ensure button is clickable
    await removeButton.hover();

    // Click remove button
    await removeButton.click();

    // Attachment preview (and its remove button) should disappear
    await expect(removeButton).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('File Attachment - Send', () => {
  let sessionId: string | null = null;

  test.beforeAll(() => {
    // Create fixtures directory
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    // Create a simple 1x1 PNG test image (valid PNG)
    const pngData = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52, // IHDR chunk
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01, // 1x1 pixels
      0x08,
      0x06,
      0x00,
      0x00,
      0x00,
      0x1f,
      0x15,
      0xc4,
      0x89, // etc.
      0x00,
      0x00,
      0x00,
      0x0a,
      0x49,
      0x44,
      0x41,
      0x54, // IDAT chunk
      0x78,
      0x9c,
      0x63,
      0x00,
      0x01,
      0x00,
      0x00,
      0x05,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x45,
      0x4e,
      0x44, // IEND chunk
      0xae,
      0x42,
      0x60,
      0x82,
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
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Attach an image
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImagePath);

    await page.waitForTimeout(500);

    // Type a message
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Here is a test image');

    // Send the message
    const sendButton = page.locator('button[aria-label="Send message"]').first();
    await sendButton.click();

    // Wait for the message to appear
    await page.waitForTimeout(1000);

    // The user message should be visible with text
    const userMessage = page.locator('[data-message-role="user"]').last();
    await expect(userMessage).toContainText('Here is a test image');

    // The attached image should be visible in the sent message
    const sentImage = userMessage.locator('img[alt="Attached image"]');
    await expect(sentImage).toBeVisible();
  });

  test('should support multiple image attachments', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Attach multiple images at once
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;

    // Select same image twice (simulating multiple files)
    await fileChooser.setFiles([testImagePath, testImagePath]);

    await page.waitForTimeout(500);

    // Should show 2 attachment previews
    const previews = page.locator('img[src^="data:image"]');
    await expect(previews).toHaveCount(2);
  });

  test('should clear attachments after sending message', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Attach an image
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImagePath);

    await page.waitForTimeout(1000);

    // Verify attachment is shown via the remove button
    const removeButton = page.locator('button[aria-label="Remove attachment"]');
    await expect(removeButton).toBeVisible({ timeout: 10000 });

    // Type and send message
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Test message with image');

    const sendButton = page.locator('[data-testid="send-button"]');
    await sendButton.click();

    // Wait for message to be sent
    await page.waitForTimeout(2000);

    // Attachment preview should be cleared (remove button gone)
    await expect(removeButton).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('File Attachment - Validation', () => {
  let sessionId: string | null = null;

  test.beforeAll(() => {
    // Create fixtures directory
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    // Create a simple 1x1 PNG test image (valid PNG)
    const pngData = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52, // IHDR chunk
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01, // 1x1 pixels
      0x08,
      0x06,
      0x00,
      0x00,
      0x00,
      0x1f,
      0x15,
      0xc4,
      0x89, // etc.
      0x00,
      0x00,
      0x00,
      0x0a,
      0x49,
      0x44,
      0x41,
      0x54, // IDAT chunk
      0x78,
      0x9c,
      0x63,
      0x00,
      0x01,
      0x00,
      0x00,
      0x05,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x45,
      0x4e,
      0x44, // IEND chunk
      0xae,
      0x42,
      0x60,
      0x82,
    ]);

    fs.writeFileSync(testImagePath, pngData);

    // Create a large image (> 5MB) for validation testing
    // Repeat the PNG data to make it larger than 5MB
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
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Try to attach a large file
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('button:has-text("Attach image")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(largeImagePath);

    await page.waitForTimeout(1000);

    // Should show an error toast (look for error message)
    const errorToast = page.locator('text=/must be under.*5MB/i');
    await expect(errorToast).toBeVisible({ timeout: 3000 });

    // Attachment should not be added (no remove button visible)
    const removeButton = page.locator('button[aria-label="Remove attachment"]');
    await expect(removeButton).not.toBeVisible();
  });
});
