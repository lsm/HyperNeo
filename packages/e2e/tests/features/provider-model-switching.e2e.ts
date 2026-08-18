import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import {
  setupMessageHubTesting,
  cleanupTestSession,
  waitForAssistantResponse,
  waitForSessionCreated,
  waitForWebSocketConnected,
  getModal,
} from '../helpers/wait-helpers';

async function createSessionViaNewSessionButton(page: Page): Promise<string> {
  await waitForWebSocketConnected(page);

  const anyDialog = getModal(page).locator(':visible');
  if (await anyDialog.isVisible({ timeout: 500 }).catch(() => false)) {
    await page.keyboard.press('Escape');
    await expect(anyDialog).toBeHidden({ timeout: 3000 });
  }

  await page.locator('button:has-text("New Session")').first().click();

  const dialog = getModal(page);
  await expect(dialog).toBeVisible({ timeout: 5000 });

  await dialog.getByRole('button', { name: 'Create Session' }).click();

  const sessionId = await waitForSessionCreated(page);

  const skipBtn = page.getByRole('button', { name: 'Skip' });
  if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await skipBtn.click();
    await expect(page.getByText('Select a workspace')).toBeHidden({ timeout: 3000 });
  }

  return sessionId;
}

async function openDropdownAndGetProviderGroups(page: Page): Promise<string[]> {
  const modelBtn = page.locator('button[title^="Switch Model"]');
  await expect(modelBtn).toBeVisible({ timeout: 10000 });
  await modelBtn.click();
  await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });

  const dropdown = page.getByTestId('model-dropdown');
  const headers = dropdown.getByTestId('provider-group-header');
  const count = await headers.count();
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = (await headers.nth(i).textContent()) ?? '';
    if (text.trim()) labels.push(text.trim());
  }
  return labels;
}

function assertMultiProviderRequired(providerGroups: string[]): void {
  expect(
    providerGroups.length,
    'Cross-provider switch test requires at least 2 configured providers. ' +
      `Found providers: [${providerGroups.join(', ')}]. ` +
      'Configure a second provider (e.g. anthropic-copilot or anthropic-codex) to run this suite.'
  ).toBeGreaterThan(1);
}

async function switchToProviderModel(page: Page, providerLabel: string): Promise<void> {
  const dropdown = page.getByTestId('model-dropdown');

  const targetSection = dropdown.locator('[data-testid="provider-section"]').filter({
    has: page.getByTestId('provider-group-header').filter({ hasText: providerLabel }),
  });

  await targetSection.getByRole('button').first().click();

  await expect(page.locator('text=Select Model')).toBeHidden({ timeout: 10000 });
}

test.describe('Model picker UI rendering', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
    sessionId = null;
  });

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      try {
        await cleanupTestSession(page, sessionId);
      } catch (error) {
        console.warn(`Failed to cleanup session ${sessionId}:`, error);
      }
      sessionId = null;
    }
  });

  test('model name is visible in the session status bar', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    const modelBtn = page.locator('button[title^="Switch Model"]');
    await expect(modelBtn).toBeVisible({ timeout: 10000 });
  });

  test('model picker dropdown opens when clicking the model button', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    const modelBtn = page.locator('button[title^="Switch Model"]');
    await expect(modelBtn).toBeVisible({ timeout: 10000 });
    await modelBtn.click();

    await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });
  });

  test('models are grouped by provider with provider headers', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    const modelBtn = page.locator('button[title^="Switch Model"]');
    await expect(modelBtn).toBeVisible({ timeout: 10000 });
    await modelBtn.click();

    await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });

    const headers = page.getByTestId('provider-group-header');
    await expect(headers.first()).toBeVisible({ timeout: 5000 });
    const headerCount = await headers.count();
    expect(headerCount).toBeGreaterThan(0);
  });

  test('closing the dropdown by clicking the model button again hides it', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    const modelBtn = page.locator('button[title^="Switch Model"]');
    await expect(modelBtn).toBeVisible({ timeout: 10000 });

    await modelBtn.click();
    await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });

    await modelBtn.click();

    await expect(page.locator('text=Select Model')).toBeHidden({ timeout: 5000 });
  });

  test('provider badge is visible next to the model button', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    const modelBtn = page.locator('button[title^="Switch Model ("]');
    await expect(modelBtn).toBeVisible({ timeout: 20000 });

    const badge = page.getByTestId('provider-badge');
    await expect(badge).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Cross-provider model switching', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
    sessionId = null;
  });

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      try {
        await cleanupTestSession(page, sessionId);
      } catch (error) {
        console.warn(`Failed to cleanup session ${sessionId}:`, error);
      }
      sessionId = null;
    }
  });

  test('requires at least 2 providers — fails clearly when only one is configured', async ({
    page,
  }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    const providerGroups = await openDropdownAndGetProviderGroups(page);

    assertMultiProviderRequired(providerGroups);
  });

  test('provider badge updates after switching to a model from a different provider', async ({
    page,
  }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    await expect(page.locator('button[title^="Switch Model ("]')).toBeVisible({ timeout: 20000 });

    const badge = page.getByTestId('provider-badge');
    await expect(badge).toBeVisible({ timeout: 5000 });
    const initialProvider = await badge.getAttribute('aria-label');

    const providerGroups = await openDropdownAndGetProviderGroups(page);
    assertMultiProviderRequired(providerGroups);

    const targetProvider = providerGroups.find(
      (label) => label.toLowerCase() !== (initialProvider ?? '').toLowerCase()
    );
    expect(targetProvider).toBeTruthy();

    await switchToProviderModel(page, targetProvider!);

    await expect(badge).not.toHaveAttribute('aria-label', initialProvider!, { timeout: 10000 });
  });

  test('session continues working after cross-provider model switch', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    await expect(page.locator('button[title^="Switch Model ("]')).toBeVisible({ timeout: 20000 });

    const providerGroups = await openDropdownAndGetProviderGroups(page);
    assertMultiProviderRequired(providerGroups);

    const badge = page.getByTestId('provider-badge');
    const initialProvider = await badge.getAttribute('aria-label');

    const targetProvider = providerGroups.find(
      (label) => label.toLowerCase() !== (initialProvider ?? '').toLowerCase()
    );
    expect(targetProvider).toBeTruthy();
    await switchToProviderModel(page, targetProvider!);

    await expect(badge).not.toHaveAttribute('aria-label', initialProvider!, { timeout: 10000 });

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeEnabled({ timeout: 10000 });
    await textarea.fill('Reply with exactly: OK');
    await page.keyboard.press('Meta+Enter');

    await waitForAssistantResponse(page, { timeout: 90000 });

    await expect(textarea).toBeEnabled({ timeout: 20000 });
  });
});
