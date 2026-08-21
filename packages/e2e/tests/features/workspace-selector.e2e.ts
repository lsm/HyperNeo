import { test, expect } from '../../fixtures';
import { cleanupTestSession, waitForWebSocketConnected } from '../helpers/wait-helpers';
import { CHAT_INPUT_SELECTOR } from '../helpers/selectors';

async function createSessionViaNewSessionButton(
  page: import('@playwright/test').Page
): Promise<string> {
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create Session', exact: true })).toBeVisible({
    timeout: 5000,
  });
  await page.getByRole('button', { name: 'Create Session', exact: true }).click();
  await page.waitForURL(/\/session\//, { timeout: 15000 });

  await expect(page.locator(CHAT_INPUT_SELECTOR).first()).toBeVisible({ timeout: 10000 });

  const match = page.url().match(/\/session\/([^/]+)/);
  if (!match) throw new Error('Could not extract session ID from URL');
  return match[1];
}

test.describe('Inline Workspace Selector', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
      timeout: 10000,
    });
    await waitForWebSocketConnected(page);
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

  test('should show workspace selector after creating session via New Session button', async ({
    page,
  }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start with workspace' })).toBeVisible();
  });

  test('should show worktree/direct mode toggle when a workspace path is entered', async ({
    page,
  }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });

    const dropdown = page.locator('select').first();
    await dropdown.selectOption('__manual__');

    const pathInput = page.locator('input[placeholder="Enter workspace path..."]');
    await expect(pathInput).toBeVisible({ timeout: 3000 });

    await pathInput.fill('/tmp');

    await expect(page.getByRole('button', { name: 'Worktree' })).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Direct' })).toBeVisible();

    await expect(page.getByText('Isolated branch (safe)')).toBeVisible();
  });

  test('should switch mode description when Direct is selected', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });

    const dropdown = page.locator('select').first();
    await dropdown.selectOption('__manual__');
    await page.locator('input[placeholder="Enter workspace path..."]').fill('/tmp');

    await page.getByRole('button', { name: 'Direct' }).click();

    await expect(page.getByText('Edit directly (fast)')).toBeVisible({ timeout: 2000 });
  });

  test('should dismiss workspace selector when Skip is clicked', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: 'Skip' }).click();

    await expect(page.getByText('Select a workspace')).not.toBeVisible({ timeout: 3000 });

    await expect(page.locator(CHAT_INPUT_SELECTOR).first()).toBeEnabled();
  });

  test('should not show workspace selector after workspace has been set via UI', async ({
    page,
  }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });

    await page.locator('select').first().selectOption('__manual__');
    const pathInput = page.locator('input[placeholder="Enter workspace path..."]');
    await expect(pathInput).toBeVisible({ timeout: 3000 });

    await pathInput.fill('/tmp');

    await page.getByRole('button', { name: 'Direct' }).click();

    await page.getByRole('button', { name: 'Start with workspace' }).click();

    await expect(page.getByText('Select a workspace')).not.toBeVisible({ timeout: 5000 });

    await page.goto('/');
    await expect(page.getByText('Neo Lobby')).toBeVisible({ timeout: 5000 });

    await page.goto(`/session/${sessionId}`);
    await page.waitForURL(/\/session\//, { timeout: 10000 });
    await expect(page.locator(CHAT_INPUT_SELECTOR).first()).toBeVisible({ timeout: 10000 });

    await expect(page.getByText('Select a workspace')).not.toBeVisible();
  });
});
