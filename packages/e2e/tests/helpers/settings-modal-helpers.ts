/**
 * Settings Modal Test Helpers
 *
 * Shared utility functions for Settings modal E2E tests.
 */

import type { Page } from '@playwright/test';

/**
 * Open the Settings modal from the sidebar footer
 */
export async function openSettingsModal(page: Page): Promise<void> {
  // Find the settings button in the NavRail (sidebar)
  // It's a button with aria-label "Settings"
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });

  await settingsButton.waitFor({ state: 'visible', timeout: 5000 });
  await settingsButton.click();

  // Wait for Settings section to appear in ContextPanel
  await page.locator('h2:has-text("Global Settings")').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Close the Settings view by navigating to the Home section
 *
 * Settings is now a panel view (not a modal), so "closing" it means
 * navigating to a different section via the NavRail.
 */
export async function closeSettingsModal(page: Page): Promise<void> {
  // Navigate away from settings by clicking the Spaces button in the NavRail
  const spacesButton = page.getByRole('button', { name: 'Spaces', exact: true });
  await spacesButton.click();

  // Wait for settings view to close
  await page.locator('h2:has-text("Global Settings")').waitFor({ state: 'hidden', timeout: 5000 });
}
