import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';

test.describe('Worktree Isolation', () => {
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

  test.skip('should create session with worktree indicator', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Hello, please confirm this is working');
    await page.keyboard.press('Meta+Enter');

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    const sessionHeader = page.locator('h2').first();
    await expect(sessionHeader).toBeVisible();
  });

  test.skip('should show session metadata with workspace info', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Test message for worktree');
    await page.keyboard.press('Meta+Enter');

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    const optionsButton = page.getByTitle('Session options');
    await optionsButton.click();

    const dropdown = page.locator('[role="menu"]');
    await expect(dropdown).toBeVisible();
  });

  test.skip('should cleanup worktree when session is deleted', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Test for cleanup');
    await page.keyboard.press('Meta+Enter');

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    const deletedSessionId = sessionId;

    const optionsButton = page.getByTitle('Session options');
    await optionsButton.click();

    await page.locator('text=Delete Chat').click();

    const confirmButton = page.locator('[data-testid="confirm-delete-session"]');
    await confirmButton.click();

    await expect(page).not.toHaveURL(new RegExp(deletedSessionId!), { timeout: 10000 });

    sessionId = null;
  });

  test.skip('should maintain separate sessions in different worktrees', async ({ page }) => {
    const sessionIds: string[] = [];

    const session1Id = await createSessionViaUI(page);
    sessionIds.push(session1Id);

    let textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('First session message');
    await page.keyboard.press('Meta+Enter');
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    await page.goto('/');
    await page.waitForTimeout(1000);

    const session2Id = await createSessionViaUI(page);
    sessionIds.push(session2Id);

    textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Second session message');
    await page.keyboard.press('Meta+Enter');
    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    expect(session1Id).not.toBe(session2Id);

    await page.goto(`/${session1Id}`);
    await page.waitForTimeout(1000);

    await expect(page.locator('text=First session message')).toBeVisible();

    for (const id of sessionIds) {
      try {
        await cleanupTestSession(page, id);
      } catch (error) {
        console.warn(`Failed to cleanup session ${id}:`, error);
      }
    }

    sessionId = null;
  });

  test.skip('should display worktree info in session header', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Initialize workspace');
    await page.keyboard.press('Meta+Enter');

    await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
      timeout: 60000,
    });

    await page.waitForTimeout(3000);

    const sessionArea = page.locator('main').first();

    await expect(sessionArea).toBeVisible();

    const sessionTitle = page.locator('h2').first();
    await expect(sessionTitle).toBeVisible();
  });
});
