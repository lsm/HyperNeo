/**
 * Global Skills Registry E2E Tests
 *
 * Tests the full lifecycle of a skill in the Global Settings > Skills panel:
 * - Navigate to Settings > Skills
 * - Add a new MCP server skill
 * - Verify the skill appears with correct name and type badge
 * - Toggle the skill off and verify disabled state
 * - Edit the description and verify it updates
 * - Delete the skill and verify it is removed
 *
 * Setup: no room needed; tests the global Settings panel directly.
 * Cleanup: delete is the final step in the test itself.
 */

import { test, expect, type Page } from '../../fixtures';
import { waitForWebSocketConnected, getModal } from '../helpers/wait-helpers';

// ─── Constants ────────────────────────────────────────────────────────────────

// fetch-mcp is a pre-seeded Application MCP Server always present in the registry
const TEST_MCP_SERVER_NAME = 'fetch-mcp';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Open the Global Settings panel via the NavRail Settings button.
 */
async function openGlobalSettings(page: Page): Promise<void> {
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  await settingsButton.waitFor({ state: 'visible', timeout: 5000 });
  await settingsButton.click();
  await expect(page.getByText('Global Settings')).toBeVisible({ timeout: 5000 });
}

/**
 * Navigate to the Skills section inside the Global Settings panel.
 * Assumes Global Settings is already open.
 */
async function navigateToSkillsSection(page: Page): Promise<void> {
  // The Skills nav button in the settings sidebar
  const skillsNavButton = page.locator('nav button:has-text("Skills")').first();
  await skillsNavButton.waitFor({ state: 'visible', timeout: 5000 });
  await skillsNavButton.click();

  // Wait for the Skills content area to appear
  await page
    .locator('text=Application-level skills are available to any space or session')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Add a new MCP server skill through the Add Skill dialog.
 * Waits for the skill to appear in the list and the dialog to close.
 */
async function addMcpSkill(page: Page, displayName: string): Promise<void> {
  // Click the "Add Skill" button
  const addSkillButton = page
    .locator('button')
    .filter({ hasText: /^Add Skill$/ })
    .first();
  await addSkillButton.waitFor({ state: 'visible', timeout: 5000 });
  await addSkillButton.click();

  // Wait for the dialog to open
  await getModal(page)
    .locator('h2')
    .filter({ hasText: 'Add Skill' })
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });

  // Fill in Display Name
  const displayNameInput = getModal(page).locator('input[placeholder="e.g., Web Search"]');
  await displayNameInput.waitFor({ state: 'visible', timeout: 5000 });
  await displayNameInput.fill(displayName);

  // Select "MCP Server" source type radio
  const mcpServerRadio = getModal(page).locator('input[type="radio"][value="mcp_server"]');
  await mcpServerRadio.click();

  // Wait for the MCP server select dropdown to appear
  const mcpSelect = getModal(page).locator('select');
  await mcpSelect.waitFor({ state: 'visible', timeout: 5000 });

  // Select the fetch-mcp option
  await mcpSelect.selectOption({ label: TEST_MCP_SERVER_NAME });

  // Click the submit button inside the dialog
  const submitButton = getModal(page)
    .locator('button[type="submit"]')
    .filter({ hasText: 'Add Skill' });
  await submitButton.click();

  // Wait for the skill to appear in the list (LiveQuery fires before RPC returns)
  await page.locator(`text="${displayName}"`).first().waitFor({ state: 'visible', timeout: 15000 });

  // Wait for the dialog to close after the RPC completes and handleClose() fires.
  // The Add Skill dialog title h2 was used to open the dialog; wait for it to disappear.
  await getModal(page)
    .locator('h2')
    .filter({ hasText: 'Add Skill' })
    .first()
    .waitFor({ state: 'hidden', timeout: 10000 });
}

/**
 * Find the skill row by navigating from the display name text up to its nearest
 * ancestor div that contains a Delete button. The ancestor:: axis in XPath starts
 * from the nearest ancestor, so [1] picks the skill row div itself (not a parent container).
 * Uses .first() to guard against brief double-render of the SkillsRegistry.
 */
function getSkillRow(page: Page, displayName: string) {
  // Walk up from the display name element to find the nearest ancestor div
  // that contains a Delete button (i.e., the skill row itself).
  return page
    .locator(
      `xpath=//*[normalize-space(text())="${displayName}"]/ancestor::div[.//button[@title="Delete"]][1]`
    )
    .first();
}

/**
 * Delete the skill with the given display name via the UI delete button + confirm modal.
 */
async function deleteSkillByName(page: Page, displayName: string): Promise<void> {
  const row = getSkillRow(page, displayName);
  const deleteButton = row.locator('button[title="Delete"]');
  await deleteButton.waitFor({ state: 'visible', timeout: 5000 });
  await deleteButton.click();

  // Wait for confirm modal and click the confirm "Delete" button
  // Use the modal's button specifically to avoid matching the list's delete buttons
  const confirmModal = getModal(page).filter({ hasText: 'Delete Skill' });
  await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
  const confirmButton = confirmModal.locator('button').filter({ hasText: 'Delete' }).last();
  await confirmButton.click();

  // Wait for the skill to disappear from the list
  await page.locator(`text="${displayName}"`).first().waitFor({ state: 'hidden', timeout: 10000 });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Global Skills Registry', () => {
  // Unique display name to avoid conflicts across test runs
  const displayName = `E2E Skill ${Date.now()}`;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
    await openGlobalSettings(page);
    await navigateToSkillsSection(page);
  });

  test('full lifecycle: add, toggle, edit, delete a skill', async ({ page }) => {
    // ── 1. Add the skill ──────────────────────────────────────────────────

    await addMcpSkill(page, displayName);

    // Skill row should now be visible
    const skillRow = getSkillRow(page, displayName);
    await expect(skillRow).toBeVisible({ timeout: 10000 });

    // MCP type badge shows "mcp" — the badge span shows source type label
    await expect(skillRow.getByText('mcp', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    // ── 2. Toggle the skill off ───────────────────────────────────────────

    const toggle = skillRow.locator('[role="switch"]').first();
    // After adding, the skill is enabled by default
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });

    // Click toggle to disable
    await toggle.click();

    // Verify toggle shows disabled state
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 5000 });

    // ── 3. Edit the skill's description ──────────────────────────────────

    const editButton = skillRow.locator('button[title="Edit"]');
    await editButton.click();

    // Wait for edit dialog
    const editDialog = getModal(page).filter({ hasText: 'Edit Skill' }).first();
    await editDialog.waitFor({ state: 'visible', timeout: 5000 });

    // Update the description field
    const updatedDescription = 'Updated E2E description';
    const descriptionInput = editDialog.locator('input[placeholder="Optional description"]');
    await descriptionInput.fill(updatedDescription);

    // Save changes
    const saveButton = editDialog
      .locator('button[type="submit"]')
      .filter({ hasText: 'Save Changes' });
    await saveButton.click();

    // Wait for the edit dialog to close
    await editDialog.waitFor({ state: 'hidden', timeout: 5000 });

    // Verify updated description appears in the skill row
    await expect(skillRow.locator(`text="${updatedDescription}"`)).toBeVisible({ timeout: 5000 });

    // ── 4. Delete the skill ───────────────────────────────────────────────

    await deleteSkillByName(page, displayName);

    // Verify the skill no longer appears in the list
    await expect(page.locator(`text="${displayName}"`).first()).not.toBeVisible({ timeout: 5000 });
  });
});
