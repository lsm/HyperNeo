import { test, expect, type Page } from '../../fixtures';
import { waitForWebSocketConnected, getModal } from '../helpers/wait-helpers';

const TEST_MCP_SERVER_NAME = 'fetch-mcp';

async function openGlobalSettings(page: Page): Promise<void> {
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  await settingsButton.waitFor({ state: 'visible', timeout: 5000 });
  await settingsButton.click();
  await expect(page.getByText('Global Settings')).toBeVisible({ timeout: 5000 });
}

async function navigateToSkillsSection(page: Page): Promise<void> {
  const skillsNavButton = page.locator('nav button:has-text("Skills")').first();
  await skillsNavButton.waitFor({ state: 'visible', timeout: 5000 });
  await skillsNavButton.click();

  await page
    .locator('text=Application-level skills are available to any space or session')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });
}

async function addMcpSkill(page: Page, displayName: string): Promise<void> {
  const addSkillButton = page
    .locator('button')
    .filter({ hasText: /^Add Skill$/ })
    .first();
  await addSkillButton.waitFor({ state: 'visible', timeout: 5000 });
  await addSkillButton.click();

  await getModal(page)
    .locator('h2')
    .filter({ hasText: 'Add Skill' })
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });

  const displayNameInput = getModal(page).locator('input[placeholder="e.g., Web Search"]');
  await displayNameInput.waitFor({ state: 'visible', timeout: 5000 });
  await displayNameInput.fill(displayName);

  const mcpServerRadio = getModal(page).locator('input[type="radio"][value="mcp_server"]');
  await mcpServerRadio.click();

  const mcpSelect = getModal(page).locator('select');
  await mcpSelect.waitFor({ state: 'visible', timeout: 5000 });

  await mcpSelect.selectOption({ label: TEST_MCP_SERVER_NAME });

  const submitButton = getModal(page)
    .locator('button[type="submit"]')
    .filter({ hasText: 'Add Skill' });
  await submitButton.click();

  await page.locator(`text="${displayName}"`).first().waitFor({ state: 'visible', timeout: 15000 });

  await getModal(page)
    .locator('h2')
    .filter({ hasText: 'Add Skill' })
    .first()
    .waitFor({ state: 'hidden', timeout: 10000 });
}

function getSkillRow(page: Page, displayName: string) {
  return page
    .locator(
      `xpath=//*[normalize-space(text())="${displayName}"]/ancestor::div[.//button[@title="Delete"]][1]`
    )
    .first();
}

async function deleteSkillByName(page: Page, displayName: string): Promise<void> {
  const row = getSkillRow(page, displayName);
  const deleteButton = row.locator('button[title="Delete"]');
  await deleteButton.waitFor({ state: 'visible', timeout: 5000 });
  await deleteButton.click();

  const confirmModal = getModal(page).filter({ hasText: 'Delete Skill' });
  await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
  const confirmButton = confirmModal.locator('button').filter({ hasText: 'Delete' }).last();
  await confirmButton.click();

  await page.locator(`text="${displayName}"`).first().waitFor({ state: 'hidden', timeout: 10000 });
}

test.describe('Global Skills Registry', () => {
  const displayName = `E2E Skill ${Date.now()}`;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
    await openGlobalSettings(page);
    await navigateToSkillsSection(page);
  });

  test('full lifecycle: add, toggle, edit, delete a skill', async ({ page }) => {
    await addMcpSkill(page, displayName);

    const skillRow = getSkillRow(page, displayName);
    await expect(skillRow).toBeVisible({ timeout: 10000 });

    await expect(skillRow.getByText('mcp', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    const toggle = skillRow.locator('[role="switch"]').first();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 5000 });

    const editButton = skillRow.locator('button[title="Edit"]');
    await editButton.click();

    const editDialog = getModal(page).filter({ hasText: 'Edit Skill' }).first();
    await editDialog.waitFor({ state: 'visible', timeout: 5000 });

    const updatedDescription = 'Updated E2E description';
    const descriptionInput = editDialog.locator('input[placeholder="Optional description"]');
    await descriptionInput.fill(updatedDescription);

    const saveButton = editDialog
      .locator('button[type="submit"]')
      .filter({ hasText: 'Save Changes' });
    await saveButton.click();

    await editDialog.waitFor({ state: 'hidden', timeout: 5000 });

    await expect(skillRow.locator(`text="${updatedDescription}"`)).toBeVisible({ timeout: 5000 });

    await deleteSkillByName(page, displayName);

    await expect(page.locator(`text="${displayName}"`).first()).not.toBeVisible({ timeout: 5000 });
  });
});
