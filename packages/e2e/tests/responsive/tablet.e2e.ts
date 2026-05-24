/**
 * Tablet Responsiveness E2E Tests
 *
 * Tests for tablet-specific responsive behavior at iPad portrait width (768px).
 *
 * At 768px, the app hits the Tailwind `md:` breakpoint (min-width: 768px),
 * rendering in desktop mode: the sidebar (ContextPanel) is always visible,
 * the NavRail is shown, and mobile controls (hamburger menu, close panel)
 * are hidden via `md:hidden`. These tests verify the desktop layout works
 * correctly at this narrower tablet width.
 */

import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

test.describe('Tablet Responsiveness', () => {
  let sessionId: string | null = null;

  // Use iPad portrait viewport — this triggers desktop mode (md: breakpoint)
  test.use({
    viewport: { width: 768, height: 1024 },
    hasTouch: true,
    isMobile: false,
  });

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

  test('should display desktop sidebar on tablet', async ({ page }) => {
    // At 768px (md: breakpoint), the app renders in desktop mode.
    // The sidebar (ContextPanel) is always visible — no hamburger menu needed.
    const newSessionButton = page.getByRole('button', {
      name: 'New Session',
      exact: true,
    });

    // New Session button should be directly visible in the always-on sidebar
    await expect(newSessionButton).toBeVisible({ timeout: 5000 });

    // Mobile controls should NOT be visible at this width
    const menuButton = page.locator('button[aria-label="Open navigation menu"]');
    const closePanelButton = page.locator('button[title="Close panel"]');
    await expect(menuButton).not.toBeVisible();
    await expect(closePanelButton).not.toBeVisible();
  });

  test('should create and use session on tablet', async ({ page }) => {
    // At 768px the sidebar is always visible — no need to open a mobile panel.
    // Create a session directly.
    sessionId = await createSessionViaUI(page);

    // Type a message to verify input works on tablet
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible({ timeout: 10000 });
    await textarea.fill('Hello from tablet');

    // Verify text was entered correctly
    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('Hello from tablet');
  });
});
