import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, cleanupTestSession } from '../helpers/wait-helpers';

test.describe('New Session modal', () => {
  let createdSessionIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
      timeout: 15000,
    });
    createdSessionIds = [];
  });

  test.afterEach(async ({ page }) => {
    for (const sessionId of createdSessionIds) {
      try {
        await cleanupTestSession(page, sessionId);
      } catch {
        // Cleanup failure is non-critical
      }
    }
    createdSessionIds = [];
  });

  test('New Session modal appears when clicking the button', async ({ page }) => {
    await page.getByRole('button', { name: 'New Session', exact: true }).click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByRole('dialog').getByRole('heading', { name: 'New Session' })
    ).toBeVisible();

    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Create Session' })
    ).toBeEnabled();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 3000 });
  });

  test('Session can be created without a workspace path', async ({ page }) => {
    await page.getByRole('button', { name: 'New Session', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

    const submitButton = page.getByRole('dialog').getByRole('button', { name: 'Create Session' });
    await expect(submitButton).toBeEnabled();

    await submitButton.click();

    await expect(page).not.toHaveURL('/', { timeout: 10000 });

    const url = page.url();
    const sessionIdMatch = url.match(/\/session\/([^/?#]+)/);
    if (sessionIdMatch) {
      createdSessionIds.push(sessionIdMatch[1]);
    }
  });
});
