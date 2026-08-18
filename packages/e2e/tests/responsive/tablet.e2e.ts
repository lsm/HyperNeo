import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

test.describe('Tablet Responsiveness', () => {
  let sessionId: string | null = null;

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
    const newSessionButton = page.getByRole('button', {
      name: 'New Session',
      exact: true,
    });

    await expect(newSessionButton).toBeVisible({ timeout: 5000 });

    const menuButton = page.locator('button[aria-label="Open navigation menu"]');
    const closePanelButton = page.locator('button[title="Close panel"]');
    await expect(menuButton).not.toBeVisible();
    await expect(closePanelButton).not.toBeVisible();
  });

  test('should create and use session on tablet', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible({ timeout: 10000 });
    await textarea.fill('Hello from tablet');

    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('Hello from tablet');
  });
});
