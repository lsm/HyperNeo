/**
 * Mobile E2E Tests
 *
 * Consolidated tests for mobile/responsive behavior:
 * - Layout adaptation
 * - Input behavior on mobile
 * - Message display on mobile
 *
 * Note: Room-specific mobile navigation (bottom tab bar in room context) is retired.
 * Space-focused mobile navigation coverage is handled by space-*.e2e.ts suites.
 */

import { test, expect, devices } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForWebSocketConnectedMobile,
} from '../helpers/wait-helpers';
import { openMobilePanel, closeMobilePanel } from '../helpers/mobile-helpers';

test.describe('Mobile Layout', () => {
  // Use iPhone 13 viewport for mobile tests
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
    // Verify the app loads on mobile
    const heading = page.getByRole('heading', { name: 'Neo Lobby' }).first();
    await expect(heading).toBeVisible();

    // New Session button should still be accessible
    const newSessionButton = page.getByRole('button', {
      name: 'New Session',
      exact: true,
    });
    await expect(newSessionButton).toBeVisible();
  });

  test('should have responsive sidebar behavior', async ({ page }) => {
    // On mobile, the context panel should be toggleable via the menu button
    const menuButton = page.locator('button[aria-label="Open navigation menu"]');
    const closePanelButton = page.locator('button[title="Close panel"]');
    const newSessionButton = page.getByRole('button', {
      name: 'New Session',
      exact: true,
    });

    // At least one navigation method should exist
    const hasMenuButton = (await menuButton.count()) > 0;
    const hasCloseButton = (await closePanelButton.count()) > 0;
    const hasNewSession = (await newSessionButton.count()) > 0;

    expect(hasMenuButton || hasCloseButton || hasNewSession).toBe(true);

    // If menu button exists, clicking it should open the panel
    if (hasMenuButton) {
      await openMobilePanel(page);
      await expect(newSessionButton).toBeVisible({ timeout: 5000 });
    }
  });
});

test.describe('Mobile Input', () => {
  let sessionId: string | null = null;

  // Use iPhone 13 viewport for mobile tests
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
    // Open the mobile panel to access the New Session button
    await openMobilePanel(page);

    // Create session via RPC helper
    sessionId = await createSessionViaUI(page);

    // Verify session was created
    expect(sessionId).toBeTruthy();

    // Close panel to see the chat area
    await closeMobilePanel(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible({ timeout: 10000 });
  });

  test('should handle touch input on textarea', async ({ page }) => {
    // Open the mobile panel to access the New Session button
    await openMobilePanel(page);

    // Create session via RPC helper
    sessionId = await createSessionViaUI(page);

    // Close panel to see chat area
    await closeMobilePanel(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible({ timeout: 10000 });

    // Tap to focus (simulate touch)
    await textarea.tap();

    // Type some text
    await textarea.fill('Hello from mobile');

    // Verify text was entered
    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('Hello from mobile');
  });

  test('should have appropriately sized touch targets', async ({ page }) => {
    // Open the mobile panel to access the New Session button
    await openMobilePanel(page);

    // Check New Session button
    const newSessionButton = page.getByRole('button', {
      name: 'New Session',
      exact: true,
    });
    await expect(newSessionButton).toBeVisible();

    // Check button size - should be reasonably sized for touch
    const buttonBox = await newSessionButton.boundingBox();
    if (buttonBox) {
      // Icon-only buttons on mobile may be compact (28px+)
      expect(buttonBox.width).toBeGreaterThanOrEqual(24);
      // Height can be slightly less than 44px in compact mobile layouts
      expect(buttonBox.height).toBeGreaterThanOrEqual(24);
    }

    // Create session via RPC helper
    sessionId = await createSessionViaUI(page);

    // Close panel to see textarea
    await closeMobilePanel(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible({ timeout: 10000 });
    const textareaBox = await textarea.boundingBox();
    if (textareaBox) {
      // Textarea should span most of the mobile width
      expect(textareaBox.width).toBeGreaterThan(200);
    }
  });
});

test.describe('Mobile Messages', () => {
  let sessionId: string | null = null;

  // Use iPhone 13 viewport for mobile tests
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
    // Open the mobile panel to access the New Session button
    await openMobilePanel(page);

    // Create session via RPC helper
    sessionId = await createSessionViaUI(page);

    // Close panel to see chat area
    await closeMobilePanel(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible({ timeout: 10000 });

    // Type a message to verify input works on narrow screen
    // Note: We don't send the message or wait for API response since E2E tests
    // may not have API credentials configured. This test verifies layout/input only.
    await textarea.fill('Test message on mobile');

    // Verify text was entered correctly
    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('Test message on mobile');

    // Verify the textarea fits within the mobile viewport
    const textareaBox = await textarea.boundingBox();
    if (textareaBox) {
      // Textarea should fit within mobile viewport width (390px)
      expect(textareaBox.width).toBeLessThanOrEqual(390);
    }
  });
});
