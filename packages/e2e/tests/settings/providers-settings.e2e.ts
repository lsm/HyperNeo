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

    await expect(page.locator('h3:has-text("General")')).toBeVisible();

    await page.locator('button:has-text("Providers")').click();

    await expect(page.locator('h3:has-text("Providers")')).toBeVisible();
  });

  test('should display Providers section with providers list or empty state', async ({ page }) => {
    await openSettingsModal(page);

    await page.locator('button:has-text("Providers")').click();

    await expect(page.locator('h3:has-text("Providers")')).toBeVisible();

    await expect(page.locator('text=Configure authentication for AI providers')).toBeVisible();

    const providerCards = page.locator('.space-y-3 > div');
    const hasProviderCards = (await providerCards.count()) > 0;
    const hasNoProvidersMessage = (await page.locator('text=No providers available').count()) > 0;

    expect(hasProviderCards || hasNoProvidersMessage).toBe(true);
  });

  test('should show action buttons for providers', async ({ page }) => {
    await openSettingsModal(page);

    await page.locator('button:has-text("Providers")').click();

    await expect(page.locator('h3:has-text("Providers")')).toBeVisible();

    const providerCards = page.locator('.space-y-3 > div');
    const hasProviderCards = (await providerCards.count()) > 0;
    const hasNoProvidersMessage = (await page.locator('text=No providers available').count()) > 0;

    if (hasProviderCards) {
      const loginButtons = await page.locator('button:has-text("Login")').count();
      const logoutButtons = await page.locator('button:has-text("Logout")').count();
      const refreshButtons = await page.locator('button:has-text("Refresh Login")').count();
      const totalButtons = loginButtons + logoutButtons + refreshButtons;

      expect(totalButtons).toBeGreaterThan(0);
    } else {
      expect(hasNoProvidersMessage).toBe(true);
    }
  });
});
