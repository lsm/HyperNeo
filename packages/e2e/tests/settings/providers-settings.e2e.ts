/**
 * Providers Settings E2E Tests
 *
 * Tests for the Providers section in settings:
 * - Navigate to Providers section
 * - Verify Providers section loads
 * - Verify provider list is displayed
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { openSettingsModal } from '../helpers/settings-modal-helpers';

test.describe('Settings Modal - Providers Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should navigate to Providers section from settings', async ({ page }) => {
    await openSettingsModal(page);

    // Verify we're in the General section by default
    await expect(page.locator('h3:has-text("General")')).toBeVisible();

    // Navigate to the Providers section
    await page.locator('button:has-text("Providers")').click();

    // Verify Providers section is shown
    await expect(page.locator('h3:has-text("Providers")')).toBeVisible();
  });

  test('should display Providers section with providers list or empty state', async ({ page }) => {
    await openSettingsModal(page);

    // Navigate to the Providers section
    await page.locator('button:has-text("Providers")').click();

    // Wait for providers section heading to be visible (proves section loaded)
    await expect(page.locator('h3:has-text("Providers")')).toBeVisible();

    // Verify the description text is visible
    await expect(page.locator('text=Configure authentication for AI providers')).toBeVisible();

    // Either shows a provider list or "No providers available"
    // Check for provider cards - they should have a button inside
    const providerCards = page.locator('.space-y-3 > div');
    const hasProviderCards = (await providerCards.count()) > 0;
    const hasNoProvidersMessage = (await page.locator('text=No providers available').count()) > 0;

    // At least one of these states should be true
    expect(hasProviderCards || hasNoProvidersMessage).toBe(true);
  });

  test('should show action buttons for providers', async ({ page }) => {
    await openSettingsModal(page);

    // Navigate to the Providers section
    await page.locator('button:has-text("Providers")').click();

    // Wait for providers section to load
    await expect(page.locator('h3:has-text("Providers")')).toBeVisible();

    // Either shows provider cards with action buttons, or "No providers available"
    const providerCards = page.locator('.space-y-3 > div');
    const hasProviderCards = (await providerCards.count()) > 0;
    const hasNoProvidersMessage = (await page.locator('text=No providers available').count()) > 0;

    if (hasProviderCards) {
      // Count action buttons in the providers section
      const loginButtons = await page.locator('button:has-text("Login")').count();
      const logoutButtons = await page.locator('button:has-text("Logout")').count();
      const refreshButtons = await page.locator('button:has-text("Refresh Login")').count();
      const totalButtons = loginButtons + logoutButtons + refreshButtons;

      // Provider cards should have action buttons
      expect(totalButtons).toBeGreaterThan(0);
    } else {
      // No providers should show the empty message
      expect(hasNoProvidersMessage).toBe(true);
    }
  });
});
