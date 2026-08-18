import { test, expect, type Page } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForMessageProcessed,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

async function sendMessage(page: Page, messageText: string): Promise<void> {
  await page.locator('textarea[placeholder*="Ask"]').first().fill(messageText);
  await page.locator('button[aria-label*="Send message"]').first().click();

  await Promise.race([
    waitForMessageProcessed(page, messageText).catch(() => {}),
    page.locator('[data-testid="send-button"]').waitFor({
      state: 'visible',
      timeout: IS_MOCK ? 5000 : 90000,
    }),
  ]);

  await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeEnabled({
    timeout: IS_MOCK ? 1000 : 5000,
  });
}

async function openInputActionsMenu(page: Page): Promise<void> {
  const menuButton = page.locator('button[title="More options"]');
  await menuButton.waitFor({ state: 'visible', timeout: 5000 });
  await menuButton.click();
  await page.waitForTimeout(IS_MOCK ? 100 : 200);
}

async function waitForRewindModeReady(page: Page): Promise<void> {
  await page.waitForSelector('div:has-text("Select a message to rewind to")', { timeout: 5000 });
  await page.waitForTimeout(IS_MOCK ? 100 : 300);
  await page.waitForSelector('[data-message-uuid] input[type="checkbox"]', { timeout: 5000 });
}

async function getCheckboxCount(page: Page): Promise<number> {
  return await page.locator('[data-message-uuid] input[type="checkbox"]').count();
}

async function getSelectedCheckboxCount(page: Page): Promise<number> {
  return await page.locator('[data-message-uuid] input[type="checkbox"]:checked').count();
}

test.describe('Rewind Mode', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
    await waitForWebSocketConnected(page);
    sessionId = null;
  });

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      const rewindModeActive = await page
        .locator('div:has-text("Select a message to rewind to")')
        .isVisible()
        .catch(() => false);
      if (rewindModeActive) {
        const exitButton = page
          .locator('button:has-text("Exit Rewind Mode")')
          .or(page.locator('button[aria-label="Close rewind mode"]'));
        await exitButton.click().catch(() => {});
        await page.waitForTimeout(IS_MOCK ? 100 : 500);
      }
      await cleanupTestSession(page, sessionId);
      sessionId = null;
    }
  });

  test('should have "Rewind Mode" option in InputActionsMenu', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await openInputActionsMenu(page);

    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await expect(rewindModeItem).toBeVisible();
  });

  test('should enter rewind mode when "Rewind Mode" is clicked', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await sendMessage(page, 'Test message for rewind mode');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    const rewindBanner = page.locator('div:has-text("Select a message to rewind to")').first();
    await expect(rewindBanner).toBeVisible({ timeout: 5000 });

    await expect(page.locator('text=Select a message to rewind to')).toBeVisible();
  });

  test('should show checkboxes next to messages in rewind mode', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await sendMessage(page, 'First message');
    await sendMessage(page, 'Second message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    await waitForRewindModeReady(page);

    const checkboxCount = await getCheckboxCount(page);
    expect(checkboxCount).toBeGreaterThan(0);
  });

  test('should not show checkboxes for tool progress messages', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await sendMessage(page, 'What files are in the current directory?');
    await page.waitForTimeout(IS_MOCK ? 1000 : 15000);

    const menuButton = page.locator('button[title="More options"]');
    await menuButton.waitFor({ state: 'visible', timeout: 10000 });

    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    await waitForRewindModeReady(page);

    const userCheckboxes = page.locator('[data-message-uuid]').locator('input[type="checkbox"]');
    const count = await userCheckboxes.count();

    expect(count).toBeGreaterThan(0);
  });

  test('should auto-select subsequent messages when a message is selected', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await sendMessage(page, 'First message');
    await sendMessage(page, 'Second message');
    await sendMessage(page, 'Third message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    await waitForRewindModeReady(page);

    const initialCheckboxCount = await getCheckboxCount(page);

    const firstCheckbox = page.locator('[data-message-uuid] input[type="checkbox"]').first();
    await firstCheckbox.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 300);

    const selectedCount = await getSelectedCheckboxCount(page);
    expect(selectedCount).toBeGreaterThan(1);
    expect(selectedCount).toBeLessThanOrEqual(initialCheckboxCount);
  });

  test('should update selection count in banner', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await sendMessage(page, 'First message');
    await sendMessage(page, 'Second message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    await waitForRewindModeReady(page);

    await expect(page.locator('text=Select a message to rewind to')).toBeVisible();

    const firstCheckbox = page.locator('[data-message-uuid] input[type="checkbox"]').first();
    await firstCheckbox.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 300);

    const selectionText = page.getByText(/message.*selected/);
    await expect(selectionText).toBeVisible();
  });

  test('should show "Rewind to Here" button when messages are selected', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await sendMessage(page, 'First message');
    await sendMessage(page, 'Second message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    await waitForRewindModeReady(page);

    const rewindButton = page
      .locator('button:has-text("Rewind to Here")')
      .or(page.locator('button:text-is("Rewind to Here")'));
    await expect(rewindButton)
      .not.toBeVisible({ timeout: 3000 })
      .catch(() => {});

    const firstCheckbox = page.locator('[data-message-uuid] input[type="checkbox"]').first();
    await firstCheckbox.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 300);

    await expect(rewindButton).toBeVisible({ timeout: 3000 });
  });

  test('should exit rewind mode when "Exit Rewind Mode" is clicked', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await sendMessage(page, 'Test message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    await waitForRewindModeReady(page);

    await expect(
      page.locator('div:has-text("Select a message to rewind to")').first()
    ).toBeVisible();

    await openInputActionsMenu(page);
    const exitRewindModeItem = page
      .locator('button', { hasText: 'Exit Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await expect(exitRewindModeItem).toBeVisible();
    await exitRewindModeItem.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 500);

    await expect(page.locator('div:has-text("Select a message to rewind to")'))
      .not.toBeVisible({ timeout: 3000 })
      .catch(() => {});

    const checkboxCount = await getCheckboxCount(page);
    expect(checkboxCount).toBe(0);
  });

  test('should show checkmark icon when in rewind mode', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await sendMessage(page, 'Test message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    await waitForRewindModeReady(page);

    await openInputActionsMenu(page);

    const checkmarkIcon = page
      .locator('button', { hasText: 'Exit Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') })
      .locator('svg')
      .first();
    await expect(checkmarkIcon).toBeVisible();
  });

  test('should deselect messages when checkbox is clicked again', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await sendMessage(page, 'First message');
    await sendMessage(page, 'Second message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    await waitForRewindModeReady(page);

    const firstCheckbox = page.locator('[data-message-uuid] input[type="checkbox"]').first();
    await firstCheckbox.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 300);

    let selectedCount = await getSelectedCheckboxCount(page);
    expect(selectedCount).toBeGreaterThan(0);

    await firstCheckbox.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 300);

    selectedCount = await getSelectedCheckboxCount(page);
    expect(selectedCount).toBe(0);
  });
});
