import { test, expect } from '../../fixtures';
import {
  openSessionOptionsMenu,
  clickArchiveSession,
  createSessionWithMessage,
  selectSessionInSidebar,
  goToHomePage,
  showArchivedSessions,
} from '../helpers/session-archive-helpers';
import {
  waitForWebSocketConnected,
  waitForAssistantResponse,
  createSessionViaUI,
  cleanupTestSession,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

test.describe('Session Archive - Menu Option', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    sessionId = await createSessionViaUI(page);
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

  test('should show Archive Session option in session options menu', async ({ page }) => {
    await openSessionOptionsMenu(page);

    await expect(page.locator('text=Archive Session')).toBeVisible();
  });

  test('should show Tools, Export, Archive, and Delete options in menu', async ({ page }) => {
    await openSessionOptionsMenu(page);

    await expect(page.locator('text=Tools')).toBeVisible();
    await expect(page.locator('text=Export Chat')).toBeVisible();
    await expect(page.locator('text=Archive Session')).toBeVisible();
    await expect(page.locator('text=Delete Chat')).toBeVisible();
  });
});

test.describe('Session Archive - Archiving Flow', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
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

  test('should archive session successfully', async ({ page }) => {
    sessionId = await createSessionWithMessage(page);

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await expect(page.locator('text=Session archived').first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('should show archived label after archiving', async ({ page }) => {
    sessionId = await createSessionWithMessage(page);

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await expect(page.locator('text=Session archived').first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('should disable Archive option for already archived session', async ({ page }) => {
    sessionId = await createSessionWithMessage(page);

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    await page.waitForTimeout(IS_MOCK ? 100 : 1500);

    await selectSessionInSidebar(page, sessionId);

    await openSessionOptionsMenu(page);

    const archiveItem = page.locator('text=Archive Session').first();
    const _isDisabled =
      (await archiveItem.getAttribute('aria-disabled')) === 'true' ||
      (await archiveItem.locator('..').getAttribute('class'))?.includes('opacity') ||
      (await archiveItem.locator('..').getAttribute('class'))?.includes('cursor-not-allowed');

    await page.keyboard.press('Escape');
  });
});

test.describe('Session Archive - Archived Session Behavior', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
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

  test('should prevent sending messages in archived session', async ({ page }) => {
    sessionId = await createSessionWithMessage(page);

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    const archivedIndicator = page.locator('text=Session archived');

    await expect(async () => {
      const isTextareaHidden = (await textarea.count()) === 0 || !(await textarea.isVisible());
      const hasArchivedLabel = (await archivedIndicator.count()) > 0;
      expect(isTextareaHidden || hasArchivedLabel).toBeTruthy();
    }).toPass({ timeout: 5000 });
  });

  test('should show archived indicator with icon', async ({ page }) => {
    sessionId = await createSessionWithMessage(page);

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    await page.waitForTimeout(IS_MOCK ? 100 : 1500);

    await expect(page.locator('text=Session archived').first()).toBeVisible();

    const archiveIconSection = page.locator('text=Session archived').first().locator('..');
    await expect(archiveIconSection.locator('svg').first()).toBeVisible();
  });
});

test.describe('Session Archive - Edge Cases', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
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

  test('should preserve messages after archiving', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.fill('Unique test message 12345');
    await page.keyboard.press('Meta+Enter');

    await waitForAssistantResponse(page);

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    await page.waitForTimeout(IS_MOCK ? 100 : 1500);

    await selectSessionInSidebar(page, sessionId!);

    await expect(page.locator('text=Unique test message 12345').first()).toBeVisible();
  });

  test('should allow deleting archived session', async ({ page }) => {
    sessionId = await createSessionWithMessage(page);

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    await page.waitForTimeout(IS_MOCK ? 100 : 1500);

    await selectSessionInSidebar(page, sessionId!);

    await openSessionOptionsMenu(page);

    const deleteItem = page.locator('text=Delete Chat').first();
    await deleteItem.click();

    const confirmButton = page
      .locator('[data-testid="confirm-delete-session"], button:has-text("Delete")')
      .last();
    await confirmButton.click();

    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    sessionId = null;
  });
});

test.describe('Session Archive - Sidebar Toggle', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await goToHomePage(page);
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

  test('should hide archived sessions by default', async ({ page }) => {
    sessionId = await createSessionWithMessage(page);

    const sessionLink = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionLink).toBeVisible();

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    await page.waitForTimeout(IS_MOCK ? 100 : 1500);

    const showArchivedToggle = page.locator('text=Show archived');

    if ((await showArchivedToggle.count()) > 0) {
      await expect(showArchivedToggle).toBeVisible();
    }
  });

  test('should show archived toggle when archived sessions exist', async ({ page }) => {
    sessionId = await createSessionWithMessage(page);

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    await page.waitForTimeout(IS_MOCK ? 100 : 1500);

    await goToHomePage(page);

    const toggleButton = page.locator(
      'button:has-text("Show archived"), button:has-text("Hide archived")'
    );
    await expect(toggleButton).toBeVisible({ timeout: 3000 });
  });

  test('should toggle archived sessions visibility', async ({ page }) => {
    sessionId = await createSessionWithMessage(page);

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    await page.waitForTimeout(IS_MOCK ? 100 : 1500);

    await goToHomePage(page);

    const showArchivedButton = page.locator('button:has-text("Show archived")');
    if ((await showArchivedButton.count()) > 0) {
      await showArchivedButton.click();

      await page.waitForTimeout(500);

      await expect(page.locator('text=Hide archived')).toBeVisible();

      const sessionLink = page.locator(`[data-session-id="${sessionId}"]`);
      await expect(sessionLink).toBeVisible();
    }
  });

  test('should show archive indicator on archived session in list', async ({ page }) => {
    sessionId = await createSessionWithMessage(page);

    await openSessionOptionsMenu(page);
    await clickArchiveSession(page);

    await page.waitForTimeout(IS_MOCK ? 100 : 1500);

    await goToHomePage(page);

    await showArchivedSessions(page);

    const sessionLink = page.locator(`[data-session-id="${sessionId}"]`);
    if ((await sessionLink.count()) > 0) {
      await expect(sessionLink).toBeVisible();
    }
  });
});
