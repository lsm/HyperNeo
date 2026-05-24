import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  getModal,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

/**
 * Tools Modal E2E Tests (Redesigned)
 *
 * Tests the redesigned ToolsModal with:
 * - Unified MCP server list grouped by scope
 * - Collapsible groups with group-level toggles
 * - Advanced section (collapsed by default) for Claude Code Preset + Setting Sources
 * - Scope badges ("All sessions" vs "This session")
 */

test.describe('Tools Modal - Redesigned', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
    await page.waitForTimeout(500);
    sessionId = null;
  });

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      try {
        await cleanupTestSession(page, sessionId);
      } catch {
        // ignore cleanup errors
      }
      sessionId = null;
    }
  });

  /** Open the Tools modal for the current session and return the dialog locator */
  async function openToolsModal(page: import('@playwright/test').Page) {
    // Ensure WebSocket is connected before clicking — the button title changes to
    // "Not connected" when disconnected, so we must wait for the connected state first.
    await waitForWebSocketConnected(page);
    const optionsButton = page.getByTitle('Session options');
    await optionsButton.click();
    // Scope the menu to the session options menu container to avoid matching stray "Tools" buttons
    await page
      .locator(
        '[role="menu"] [role="menuitem"]:has-text("Tools"), [role="menuitem"]:has-text("Tools")'
      )
      .first()
      .click();
    await expect(getModal(page)).toBeVisible({ timeout: 5000 });
    return getModal(page);
  }

  test('should open tools modal and show group sections', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    // Should show the group section headers — scoped to dialog to avoid page-level duplicates.
    // "App Skills & MCP Servers" renders as a <button> (GroupHeader) when skills exist, or a
    // plain <span> when no app skills are configured. In both cases the text is always present.
    await expect(dialog.getByText('App Skills & MCP Servers', { exact: true })).toBeVisible();
    // "Project MCP Servers" always renders as a GroupHeader button.
    await expect(dialog.locator('button:has-text("Project MCP Servers")')).toBeVisible();
  });

  test('should show Advanced section collapsed by default', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    // Advanced section should be visible but collapsed
    await expect(dialog.getByRole('button', { name: /Advanced/i })).toBeVisible();

    // Claude Code Preset should NOT be visible initially (hidden in Advanced)
    // Scoping to dialog ensures this assertion targets the modal state, not a stray page node
    await expect(dialog.getByText('Claude Code Preset')).not.toBeVisible();
  });

  test('should expand Advanced section and show Claude Code Preset', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    // Click Advanced to expand
    await dialog.getByRole('button', { name: /Advanced/i }).click();

    // Claude Code Preset should now be visible
    await expect(dialog.getByText('Claude Code Preset')).toBeVisible({ timeout: 2000 });

    // Setting Sources should also be visible — scoped to dialog to avoid page-level duplicates.
    // .first() is still required within the dialog: getByText matches both the <h4> element
    // and its parent <div> (whose text content is a superset), causing a strict-mode violation.
    await expect(dialog.getByText('Setting Sources').first()).toBeVisible();
  });

  test('should show scope badges for groups', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    // App MCP group should show "All sessions" scope badge
    await expect(dialog.getByText('All sessions').first()).toBeVisible();

    // Project MCP group should show "This session" scope badge
    await expect(dialog.getByText('This session').first()).toBeVisible();
  });

  test('should collapse Advanced group and hide Claude Code Preset', async ({ page }) => {
    sessionId = await createSessionViaUI(page);
    const dialog = await openToolsModal(page);

    const advancedHeader = dialog.getByRole('button', { name: /Advanced/i });
    await expect(advancedHeader).toBeVisible();

    // Initially collapsed — Claude Code Preset should NOT be visible
    await expect(dialog.getByText('Claude Code Preset')).not.toBeVisible();

    // Expand
    await advancedHeader.click();
    await expect(dialog.getByText('Claude Code Preset')).toBeVisible({ timeout: 2000 });

    // Collapse again
    await advancedHeader.click();
    await expect(dialog.getByText('Claude Code Preset')).not.toBeVisible({ timeout: 2000 });
  });

  test('should collapse Project MCP Servers group and hide content', async ({ page }) => {
    sessionId = await createSessionViaUI(page);
    const dialog = await openToolsModal(page);

    // Wait for MCP loading to finish before checking collapse
    await expect(getModal(page).getByText('Loading servers...')).not.toBeVisible({
      timeout: 10000,
    });

    const fileMcpHeader = dialog.locator('button:has-text("Project MCP Servers")');
    await expect(fileMcpHeader).toBeVisible();

    // Initially expanded
    await expect(fileMcpHeader).toHaveAttribute('aria-expanded', 'true');

    // The content div (div.mt-1.ml-5) is a sibling of the GroupHeader div — it should be attached
    // XPath: from button → parent (GroupHeader div) → parent (section div) → child div.ml-5
    const fileMcpContent = fileMcpHeader.locator('xpath=../../div[contains(@class,"ml-5")]');
    await expect(fileMcpContent.first()).toBeAttached();

    // Collapse
    await fileMcpHeader.click();
    await expect(fileMcpHeader).toHaveAttribute('aria-expanded', 'false');

    // Content div is removed from DOM
    await expect(fileMcpContent.first()).not.toBeAttached({ timeout: 2000 });
  });

  test('should show Claude Code Preset toggle in Advanced section', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    // Expand Advanced section
    await dialog.getByRole('button', { name: /Advanced/i }).click();

    // Claude Code Preset and Setting Sources should be visible
    await expect(dialog.getByText('Claude Code Preset')).toBeVisible({ timeout: 2000 });
    await expect(dialog.getByText('Use official Claude Code system prompt')).toBeVisible();
  });

  test('should enable Save button when session-local setting is toggled', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    // Save should be disabled initially (no changes)
    const saveBtn = dialog.getByRole('button', { name: 'Save' });
    await expect(saveBtn).toBeDisabled();

    // Toggle Claude Code Preset (in Advanced section) to mark modal as changed
    await dialog.getByRole('button', { name: /Advanced/i }).click();
    const claudeCodeLabel = dialog.locator('label:has-text("Claude Code Preset")');
    await expect(claudeCodeLabel).toBeVisible({ timeout: 2000 });
    await claudeCodeLabel.locator('input[type="checkbox"]').click();

    // Save button must now be enabled
    await expect(saveBtn).toBeEnabled({ timeout: 2000 });
  });

  test('should close modal with Cancel without saving', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await openToolsModal(page);

    const dialog = getModal(page);
    await expect(dialog).toBeVisible();

    // Click Cancel
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Modal should close
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should persist state: save and reopen modal shows same config', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    let dialog = await openToolsModal(page);

    // Toggle memory on
    const memoryLabel = dialog.locator('label:has-text("Memory")').first();
    if ((await memoryLabel.count()) > 0) {
      const memoryCheckbox = memoryLabel.locator('input[type="checkbox"]');
      const isChecked = await memoryCheckbox.isChecked();

      // Toggle memory state
      await memoryLabel.click();
      await expect(memoryCheckbox).toHaveJSProperty('checked', !isChecked, { timeout: 2000 });

      // Save
      const saveBtn = dialog.getByRole('button', { name: 'Save' });
      if (await saveBtn.isEnabled()) {
        await saveBtn.click();
        await expect(getModal(page)).not.toBeVisible({ timeout: 5000 });

        // Reopen modal
        dialog = await openToolsModal(page);

        // Memory should reflect saved state
        const memoryCheckboxAfter = dialog
          .locator('label:has-text("Memory")')
          .first()
          .locator('input[type="checkbox"]');
        await expect(memoryCheckboxAfter).toHaveJSProperty('checked', !isChecked, {
          timeout: 2000,
        });
      }
    }
  });
});
