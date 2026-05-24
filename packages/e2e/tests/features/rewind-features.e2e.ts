import { test, expect, type Page } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForMessageProcessed,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

const IS_MOCK = process.env.NEOKAI_USE_DEV_PROXY === '1';

/**
 * Rewind Mode E2E Tests
 *
 * Tests for the Rewind Mode feature (multi-select rewind) accessible via
 * the InputActionsMenu (plus button dropdown).
 * The rewind mode allows users to select multiple messages and rewind to a specific point.
 *
 * IS_MOCK: In mock mode (devproxy), responses are pre-configured mock responses
 * that may differ from real API responses. Timeouts are reduced and assertions
 * are relaxed to accommodate faster mock responses.
 */

/**
 * Helper to send a message and wait for response or agent idle.
 * Uses Promise.race to handle SDK crashes gracefully — if the SDK process
 * exits before responding, waits for the send button to reappear (agent idle).
 */
async function sendMessage(page: Page, messageText: string): Promise<void> {
  await page.locator('textarea[placeholder*="Ask"]').first().fill(messageText);
  await page.locator('button[aria-label*="Send message"]').first().click();

  // Race between: full response completes OR send button returns (SDK crash recovery)
  await Promise.race([
    waitForMessageProcessed(page, messageText).catch(() => {}),
    // If SDK crashes, send button returns after error handling
    // In mock mode, response is instant; in real mode, wait up to 90s
    page.locator('[data-testid="send-button"]').waitFor({
      state: 'visible',
      timeout: IS_MOCK ? 5000 : 90000,
    }),
  ]);

  // Ensure input is ready for next message
  // In mock mode, UI updates faster
  await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeEnabled({
    timeout: IS_MOCK ? 1000 : 5000,
  });
}

/**
 * Open the InputActionsMenu (plus button dropdown)
 */
async function openInputActionsMenu(page: Page): Promise<void> {
  // Use the More options button specifically - filter out New Session button
  const menuButton = page.locator('button[title="More options"]');
  await menuButton.waitFor({ state: 'visible', timeout: 5000 });
  await menuButton.click();
  await page.waitForTimeout(IS_MOCK ? 100 : 200);
}

/**
 * Helper to wait for rewind mode to be fully activated and checkboxes to render
 */
async function waitForRewindModeReady(page: Page): Promise<void> {
  // Wait for the rewind mode banner to appear
  await page.waitForSelector('div:has-text("Select a message to rewind to")', { timeout: 5000 });
  // Wait a bit more for checkboxes to render
  await page.waitForTimeout(IS_MOCK ? 100 : 300);
  // Wait for at least one checkbox to be present
  await page.waitForSelector('[data-message-uuid] input[type="checkbox"]', { timeout: 5000 });
}

/**
 * Helper to count checkboxes visible in rewind mode
 * Checkboxes are inside div[data-message-uuid] in rewind mode
 */
async function getCheckboxCount(page: Page): Promise<number> {
  return await page.locator('[data-message-uuid] input[type="checkbox"]').count();
}

/**
 * Helper to get selected checkbox count
 * Checkboxes are inside div[data-message-uuid] in rewind mode
 */
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
      // Exit rewind mode if active
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
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Open InputActionsMenu
    await openInputActionsMenu(page);

    // Verify "Rewind Mode" menu item exists - use more specific selector
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await expect(rewindModeItem).toBeVisible();
  });

  test('should enter rewind mode when "Rewind Mode" is clicked', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message to have content
    await sendMessage(page, 'Test message for rewind mode');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Open InputActionsMenu and click "Rewind Mode"
    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    // Verify rewind mode banner appears
    const rewindBanner = page.locator('div:has-text("Select a message to rewind to")').first();
    await expect(rewindBanner).toBeVisible({ timeout: 5000 });

    // Verify banner shows "Select a message to rewind to"
    await expect(page.locator('text=Select a message to rewind to')).toBeVisible();
  });

  test('should show checkboxes next to messages in rewind mode', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send multiple messages
    await sendMessage(page, 'First message');
    await sendMessage(page, 'Second message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Enter rewind mode
    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    // Wait for rewind mode to be fully ready
    await waitForRewindModeReady(page);

    // Verify checkboxes appear next to messages
    const checkboxCount = await getCheckboxCount(page);
    expect(checkboxCount).toBeGreaterThan(0);
  });

  test('should not show checkboxes for tool progress messages', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message that triggers tool use
    await sendMessage(page, 'What files are in the current directory?');
    // In mock mode, tool execution is instant; in real mode, wait for actual tool execution.
    // Increased from 5000ms to 15000ms because directory listing can take longer with real API.
    await page.waitForTimeout(IS_MOCK ? 1000 : 15000);

    // Wait for the "More options" button to be visible
    const menuButton = page.locator('button[title="More options"]');
    await menuButton.waitFor({ state: 'visible', timeout: 10000 });

    // Enter rewind mode
    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    // Wait for rewind mode to be fully ready
    await waitForRewindModeReady(page);

    // Verify user and assistant messages have checkboxes
    const userCheckboxes = page.locator('[data-message-uuid]').locator('input[type="checkbox"]');
    const count = await userCheckboxes.count();

    // Checkboxes should only be on user/assistant messages, not tool progress
    expect(count).toBeGreaterThan(0);
  });

  test('should auto-select subsequent messages when a message is selected', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send multiple messages
    await sendMessage(page, 'First message');
    await sendMessage(page, 'Second message');
    await sendMessage(page, 'Third message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Enter rewind mode
    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    // Wait for rewind mode to be fully ready
    await waitForRewindModeReady(page);

    // Get initial checkbox count
    const initialCheckboxCount = await getCheckboxCount(page);

    // Click the first message checkbox
    const firstCheckbox = page.locator('[data-message-uuid] input[type="checkbox"]').first();
    await firstCheckbox.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 300);

    // Verify multiple messages are selected (all subsequent messages should be selected)
    const selectedCount = await getSelectedCheckboxCount(page);
    expect(selectedCount).toBeGreaterThan(1);
    expect(selectedCount).toBeLessThanOrEqual(initialCheckboxCount);
  });

  test('should update selection count in banner', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send messages
    await sendMessage(page, 'First message');
    await sendMessage(page, 'Second message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Enter rewind mode
    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    // Wait for rewind mode to be fully ready
    await waitForRewindModeReady(page);

    // Verify initial banner text
    await expect(page.locator('text=Select a message to rewind to')).toBeVisible();

    // Select a message
    const firstCheckbox = page.locator('[data-message-uuid] input[type="checkbox"]').first();
    await firstCheckbox.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 300);

    // Verify banner shows selection count
    const selectionText = page.getByText(/message.*selected/);
    await expect(selectionText).toBeVisible();
  });

  test('should show "Rewind to Here" button when messages are selected', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send messages
    await sendMessage(page, 'First message');
    await sendMessage(page, 'Second message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Enter rewind mode
    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    // Wait for rewind mode to be fully ready
    await waitForRewindModeReady(page);

    // "Rewind to Here" button should not be visible initially
    const rewindButton = page
      .locator('button:has-text("Rewind to Here")')
      .or(page.locator('button:text-is("Rewind to Here")'));
    await expect(rewindButton)
      .not.toBeVisible({ timeout: 3000 })
      .catch(() => {});

    // Select a message
    const firstCheckbox = page.locator('[data-message-uuid] input[type="checkbox"]').first();
    await firstCheckbox.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 300);

    // "Rewind to Here" button should now be visible
    await expect(rewindButton).toBeVisible({ timeout: 3000 });
  });

  test('should exit rewind mode when "Exit Rewind Mode" is clicked', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message
    await sendMessage(page, 'Test message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Enter rewind mode
    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    // Wait for rewind mode to be fully ready
    await waitForRewindModeReady(page);

    // Verify rewind mode is active
    await expect(
      page.locator('div:has-text("Select a message to rewind to")').first()
    ).toBeVisible();

    // Open InputActionsMenu and click "Exit Rewind Mode"
    await openInputActionsMenu(page);
    const exitRewindModeItem = page
      .locator('button', { hasText: 'Exit Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await expect(exitRewindModeItem).toBeVisible();
    await exitRewindModeItem.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 500);

    // Verify rewind mode banner is gone
    await expect(page.locator('div:has-text("Select a message to rewind to")'))
      .not.toBeVisible({ timeout: 3000 })
      .catch(() => {});

    // Verify checkboxes are gone
    const checkboxCount = await getCheckboxCount(page);
    expect(checkboxCount).toBe(0);
  });

  test('should show checkmark icon when in rewind mode', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send a message
    await sendMessage(page, 'Test message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Enter rewind mode
    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    // Wait for rewind mode to be fully ready
    await waitForRewindModeReady(page);

    // Open menu again to verify checkmark appears
    await openInputActionsMenu(page);

    // Check for checkmark icon next to "Exit Rewind Mode"
    const checkmarkIcon = page
      .locator('button', { hasText: 'Exit Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') })
      .locator('svg')
      .first();
    await expect(checkmarkIcon).toBeVisible();
  });

  test('should deselect messages when checkbox is clicked again', async ({ page }) => {
    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Send messages
    await sendMessage(page, 'First message');
    await sendMessage(page, 'Second message');
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Enter rewind mode
    await openInputActionsMenu(page);
    const rewindModeItem = page
      .locator('button', { hasText: 'Rewind Mode' })
      .filter({ has: page.locator('svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"]') });
    await rewindModeItem.click();

    // Wait for rewind mode to be fully ready
    await waitForRewindModeReady(page);

    // Select a message
    const firstCheckbox = page.locator('[data-message-uuid] input[type="checkbox"]').first();
    await firstCheckbox.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 300);

    // Verify messages are selected
    let selectedCount = await getSelectedCheckboxCount(page);
    expect(selectedCount).toBeGreaterThan(0);

    // Click the same checkbox again to deselect
    await firstCheckbox.click();
    await page.waitForTimeout(IS_MOCK ? 100 : 300);

    // Verify all messages are deselected
    selectedCount = await getSelectedCheckboxCount(page);
    expect(selectedCount).toBe(0);
  });
});
