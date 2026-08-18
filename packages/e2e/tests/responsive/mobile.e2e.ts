import { test, expect, devices } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForWebSocketConnectedMobile,
} from '../helpers/wait-helpers';
import { openMobilePanel, closeMobilePanel } from '../helpers/mobile-helpers';

test.describe('Mobile Layout', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
  });

  test('should display correctly on mobile viewport', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Neo Lobby' }).first();
    await expect(heading).toBeVisible();

    const newSessionButton = page.getByRole('button', {
      name: 'New Session',
      exact: true,
    });
    await expect(newSessionButton).toBeVisible();
  });

  test('should have responsive sidebar behavior', async ({ page }) => {
    const menuButton = page.locator('button[aria-label="Open navigation menu"]');
    const closePanelButton = page.locator('button[title="Close panel"]');
    const newSessionButton = page.getByRole('button', {
      name: 'New Session',
      exact: true,
    });

    const hasMenuButton = (await menuButton.count()) > 0;
    const hasCloseButton = (await closePanelButton.count()) > 0;
    const hasNewSession = (await newSessionButton.count()) > 0;

    expect(hasMenuButton || hasCloseButton || hasNewSession).toBe(true);

    if (hasMenuButton) {
      await openMobilePanel(page);
      await expect(newSessionButton).toBeVisible({ timeout: 5000 });
    }
  });
});

test.describe('Mobile Input', () => {
  let sessionId: string | null = null;

  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
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

  test('should create session on mobile', async ({ page }) => {
    await openMobilePanel(page);

    sessionId = await createSessionViaUI(page);

    expect(sessionId).toBeTruthy();

    await closeMobilePanel(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible({ timeout: 10000 });
  });

  test('should handle touch input on textarea', async ({ page }) => {
    await openMobilePanel(page);

    sessionId = await createSessionViaUI(page);

    await closeMobilePanel(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible({ timeout: 10000 });

    await textarea.tap();

    await textarea.fill('Hello from mobile');

    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('Hello from mobile');
  });

  test('should have appropriately sized touch targets', async ({ page }) => {
    await openMobilePanel(page);

    const newSessionButton = page.getByRole('button', {
      name: 'New Session',
      exact: true,
    });
    await expect(newSessionButton).toBeVisible();

    const buttonBox = await newSessionButton.boundingBox();
    if (buttonBox) {
      expect(buttonBox.width).toBeGreaterThanOrEqual(24);
      expect(buttonBox.height).toBeGreaterThanOrEqual(24);
    }

    sessionId = await createSessionViaUI(page);

    await closeMobilePanel(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible({ timeout: 10000 });
    const textareaBox = await textarea.boundingBox();
    if (textareaBox) {
      expect(textareaBox.width).toBeGreaterThan(200);
    }
  });
});

test.describe('Mobile Messages', () => {
  let sessionId: string | null = null;

  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: devices['iPhone 13'].userAgent,
    hasTouch: true,
    isMobile: true,
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
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

  test('should have usable input on narrow screen', async ({ page }) => {
    await openMobilePanel(page);

    sessionId = await createSessionViaUI(page);

    await closeMobilePanel(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible({ timeout: 10000 });

    await textarea.fill('Test message on mobile');

    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('Test message on mobile');

    const textareaBox = await textarea.boundingBox();
    if (textareaBox) {
      expect(textareaBox.width).toBeLessThanOrEqual(390);
    }
  });
});
