import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  getModal,
  waitForWebSocketConnected,
} from '../helpers/wait-helpers';

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
      } catch {}
      sessionId = null;
    }
  });

  async function openToolsModal(page: import('@playwright/test').Page) {
    await waitForWebSocketConnected(page);
    const optionsButton = page.getByTitle('Session options');
    await optionsButton.click();
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

    await expect(dialog.getByText('App Skills & MCP Servers', { exact: true })).toBeVisible();
    await expect(dialog.locator('button:has-text("Project MCP Servers")')).toBeVisible();
  });

  test('should show Advanced section collapsed by default', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    await expect(dialog.getByRole('button', { name: /Advanced/i })).toBeVisible();

    await expect(dialog.getByText('Claude Code Preset')).not.toBeVisible();
  });

  test('should expand Advanced section and show Claude Code Preset', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    await dialog.getByRole('button', { name: /Advanced/i }).click();

    await expect(dialog.getByText('Claude Code Preset')).toBeVisible({ timeout: 2000 });

    await expect(dialog.getByText('Setting Sources').first()).toBeVisible();
  });

  test('should show scope badges for groups', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    await expect(dialog.getByText('All sessions').first()).toBeVisible();

    await expect(dialog.getByText('This session').first()).toBeVisible();
  });

  test('should collapse Advanced group and hide Claude Code Preset', async ({ page }) => {
    sessionId = await createSessionViaUI(page);
    const dialog = await openToolsModal(page);

    const advancedHeader = dialog.getByRole('button', { name: /Advanced/i });
    await expect(advancedHeader).toBeVisible();

    await expect(dialog.getByText('Claude Code Preset')).not.toBeVisible();

    await advancedHeader.click();
    await expect(dialog.getByText('Claude Code Preset')).toBeVisible({ timeout: 2000 });

    await advancedHeader.click();
    await expect(dialog.getByText('Claude Code Preset')).not.toBeVisible({ timeout: 2000 });
  });

  test('should collapse Project MCP Servers group and hide content', async ({ page }) => {
    sessionId = await createSessionViaUI(page);
    const dialog = await openToolsModal(page);

    await expect(getModal(page).getByText('Loading servers...')).not.toBeVisible({
      timeout: 10000,
    });

    const fileMcpHeader = dialog.locator('button:has-text("Project MCP Servers")');
    await expect(fileMcpHeader).toBeVisible();

    await expect(fileMcpHeader).toHaveAttribute('aria-expanded', 'true');

    const fileMcpContent = fileMcpHeader.locator('xpath=../../div[contains(@class,"ml-5")]');
    await expect(fileMcpContent.first()).toBeAttached();

    await fileMcpHeader.click();
    await expect(fileMcpHeader).toHaveAttribute('aria-expanded', 'false');

    await expect(fileMcpContent.first()).not.toBeAttached({ timeout: 2000 });
  });

  test('should show Claude Code Preset toggle in Advanced section', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    await dialog.getByRole('button', { name: /Advanced/i }).click();

    await expect(dialog.getByText('Claude Code Preset')).toBeVisible({ timeout: 2000 });
    await expect(dialog.getByText('Use official Claude Code system prompt')).toBeVisible();
  });

  test('should enable Save button when session-local setting is toggled', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const dialog = await openToolsModal(page);

    const saveBtn = dialog.getByRole('button', { name: 'Save' });
    await expect(saveBtn).toBeDisabled();

    await dialog.getByRole('button', { name: /Advanced/i }).click();
    const claudeCodeLabel = dialog.locator('label:has-text("Claude Code Preset")');
    await expect(claudeCodeLabel).toBeVisible({ timeout: 2000 });
    await claudeCodeLabel.locator('input[type="checkbox"]').click();

    await expect(saveBtn).toBeEnabled({ timeout: 2000 });
  });

  test('should close modal with Cancel without saving', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    await openToolsModal(page);

    const dialog = getModal(page);
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('should persist state: save and reopen modal shows same config', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    let dialog = await openToolsModal(page);

    const memoryLabel = dialog.locator('label:has-text("Memory")').first();
    if ((await memoryLabel.count()) > 0) {
      const memoryCheckbox = memoryLabel.locator('input[type="checkbox"]');
      const isChecked = await memoryCheckbox.isChecked();

      await memoryLabel.click();
      await expect(memoryCheckbox).toHaveJSProperty('checked', !isChecked, { timeout: 2000 });

      const saveBtn = dialog.getByRole('button', { name: 'Save' });
      if (await saveBtn.isEnabled()) {
        await saveBtn.click();
        await expect(getModal(page)).not.toBeVisible({ timeout: 5000 });

        dialog = await openToolsModal(page);

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
