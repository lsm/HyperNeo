import type { Page } from '@playwright/test';

export async function openSettingsModal(page: Page): Promise<void> {
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });

  await settingsButton.waitFor({ state: 'visible', timeout: 5000 });
  await settingsButton.click();

  await page.locator('h2:has-text("Global Settings")').waitFor({ state: 'visible', timeout: 5000 });
}

export async function closeSettingsModal(page: Page): Promise<void> {
  const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
  await spacesButton.click();

  await page.locator('h2:has-text("Global Settings")').waitFor({ state: 'hidden', timeout: 5000 });
}
