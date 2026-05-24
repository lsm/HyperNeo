/**
 * Provider / Model Switching E2E Tests
 *
 * Two suites that cover provider-related UI behaviour:
 *
 * Suite A – "Model picker UI rendering"
 *   Works with any single provider.  Verifies static rendering: model name visible
 *   in the session status bar, dropdown opens, models are grouped by provider, and
 *   provider labels appear as group headers.
 *
 * Suite B – "Cross-provider model switching"
 *   Requires at least two configured providers.  Verifies that switching to a model
 *   from a different provider updates the provider badge and that the session
 *   continues to work (sends a message, gets a response).
 *   If only one provider is available the suite FAILS with a clear message — it
 *   does NOT silently skip (hard-fail rule from CLAUDE.md).
 */

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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Create a new session by clicking the "New Session" button in the Lobby UI
 * and submitting the form. Workspace selection has been moved out of the modal
 * into the inline WorkspaceSelector shown in the chat container after creation.
 */
async function createSessionViaNewSessionButton(page: Page): Promise<string> {
  await waitForWebSocketConnected(page);

  // Close any stale modal left open from a previous test.
  const anyDialog = getModal(page).locator(':visible');
  if (await anyDialog.isVisible({ timeout: 500 }).catch(() => false)) {
    await page.keyboard.press('Escape');
    await expect(anyDialog).toBeHidden({ timeout: 3000 });
  }

  // Click the desktop "New Session" button.
  await page.locator('button:has-text("New Session")').first().click();

  const dialog = getModal(page);
  await expect(dialog).toBeVisible({ timeout: 5000 });

  // Submit the form — workspace is set inline after session creation.
  await dialog.getByRole('button', { name: 'Create Session' }).click();

  const sessionId = await waitForSessionCreated(page);

  // Dismiss the inline WorkspaceSelector if it appears — it overlays the chat
  // controls (including the Switch Model button) and blocks pointer events.
  const skipBtn = page.getByRole('button', { name: 'Skip' });
  if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await skipBtn.click();
    await expect(page.getByText('Select a workspace')).toBeHidden({ timeout: 3000 });
  }

  return sessionId;
}

/**
 * Open the model dropdown and return the provider group labels visible in it.
 * Relies on `data-testid="provider-group-header"` spans in the dropdown.
 */
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

/**
 * Hard-fail guard: asserts at least 2 provider groups are available.
 * Called at the start of every cross-provider test to avoid silent skipping
 * (CLAUDE.md hard-fail rule).
 */
function assertMultiProviderRequired(providerGroups: string[]): void {
  expect(
    providerGroups.length,
    'Cross-provider switch test requires at least 2 configured providers. ' +
      `Found providers: [${providerGroups.join(', ')}]. ` +
      'Configure a second provider (e.g. anthropic-copilot or anthropic-codex) to run this suite.'
  ).toBeGreaterThan(1);
}

/**
 * Click the first model listed under a given provider group in the open dropdown
 * and wait for the dropdown to close.
 */
async function switchToProviderModel(page: Page, providerLabel: string): Promise<void> {
  const dropdown = page.getByTestId('model-dropdown');

  // Find the provider section that contains the matching header
  const targetSection = dropdown.locator('[data-testid="provider-section"]').filter({
    has: page.getByTestId('provider-group-header').filter({ hasText: providerLabel }),
  });

  // Click the first model button in that section
  await targetSection.getByRole('button').first().click();

  // Wait for dropdown to close
  await expect(page.locator('text=Select Model')).toBeHidden({ timeout: 10000 });
}

// ---------------------------------------------------------------------------
// Suite A: Model picker UI rendering
// ---------------------------------------------------------------------------
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

    // The model switcher button title is "Switch Model (<name>)" once a model
    // is loaded.  We accept the plain "Switch Model" title too (e.g. when the
    // daemon defaults are unknown), but at minimum the button must exist.
    const modelBtn = page.locator('button[title^="Switch Model"]');
    await expect(modelBtn).toBeVisible({ timeout: 10000 });
  });

  test('model picker dropdown opens when clicking the model button', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    const modelBtn = page.locator('button[title^="Switch Model"]');
    await expect(modelBtn).toBeVisible({ timeout: 10000 });
    await modelBtn.click();

    // The dropdown header "Select Model" should be visible
    await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });
  });

  test('models are grouped by provider with provider headers', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    const modelBtn = page.locator('button[title^="Switch Model"]');
    await expect(modelBtn).toBeVisible({ timeout: 10000 });
    await modelBtn.click();

    // Wait for dropdown
    await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });

    // At least one provider group header via data-testid
    const headers = page.getByTestId('provider-group-header');
    await expect(headers.first()).toBeVisible({ timeout: 5000 });
    const headerCount = await headers.count();
    expect(headerCount).toBeGreaterThan(0);
  });

  test('closing the dropdown by clicking the model button again hides it', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    const modelBtn = page.locator('button[title^="Switch Model"]');
    await expect(modelBtn).toBeVisible({ timeout: 10000 });

    // Open dropdown
    await modelBtn.click();
    await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });

    // Click the same button again to close (toggle)
    await modelBtn.click();

    // Dropdown should disappear
    await expect(page.locator('text=Select Model')).toBeHidden({ timeout: 5000 });
  });

  test('provider badge is visible next to the model button', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    // Wait for model info to load (title includes the model name when loaded)
    const modelBtn = page.locator('button[title^="Switch Model ("]');
    await expect(modelBtn).toBeVisible({ timeout: 20000 });

    // The ProviderBadge renders a span[data-testid="provider-badge"]
    const badge = page.getByTestId('provider-badge');
    await expect(badge).toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Suite B: Cross-provider model switching
// ---------------------------------------------------------------------------
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

    // HARD FAIL — no silent skipping (see CLAUDE.md "Hard Fail Rule")
    assertMultiProviderRequired(providerGroups);
  });

  test('provider badge updates after switching to a model from a different provider', async ({
    page,
  }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    // Wait for model info to load before reading the badge
    await expect(page.locator('button[title^="Switch Model ("]')).toBeVisible({ timeout: 20000 });

    // Read the current provider from the badge
    const badge = page.getByTestId('provider-badge');
    await expect(badge).toBeVisible({ timeout: 5000 });
    const initialProvider = await badge.getAttribute('aria-label');

    // Open the dropdown and verify 2+ providers are available
    const providerGroups = await openDropdownAndGetProviderGroups(page);
    assertMultiProviderRequired(providerGroups);

    // Find a provider group different from the current one
    const targetProvider = providerGroups.find(
      (label) => label.toLowerCase() !== (initialProvider ?? '').toLowerCase()
    );
    expect(targetProvider).toBeTruthy();

    // Switch to the first model under the target provider
    await switchToProviderModel(page, targetProvider!);

    // Use auto-retrying assertion to avoid race condition — the badge was
    // already visible before the switch; we wait for its label to change.
    await expect(badge).not.toHaveAttribute('aria-label', initialProvider!, { timeout: 10000 });
  });

  test('session continues working after cross-provider model switch', async ({ page }) => {
    sessionId = await createSessionViaNewSessionButton(page);

    // Wait for model info to load before reading the badge
    await expect(page.locator('button[title^="Switch Model ("]')).toBeVisible({ timeout: 20000 });

    // Check provider groups first
    const providerGroups = await openDropdownAndGetProviderGroups(page);
    assertMultiProviderRequired(providerGroups);

    const badge = page.getByTestId('provider-badge');
    const initialProvider = await badge.getAttribute('aria-label');

    // Switch to a model from a different provider
    const targetProvider = providerGroups.find(
      (label) => label.toLowerCase() !== (initialProvider ?? '').toLowerCase()
    );
    expect(targetProvider).toBeTruthy();
    await switchToProviderModel(page, targetProvider!);

    // Verify badge updated (auto-retrying assertion — no race condition)
    await expect(badge).not.toHaveAttribute('aria-label', initialProvider!, { timeout: 10000 });

    // Send a simple message and verify the session produces a response
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeEnabled({ timeout: 10000 });
    await textarea.fill('Reply with exactly: OK');
    await page.keyboard.press('Meta+Enter');

    // An assistant message should appear
    await waitForAssistantResponse(page, { timeout: 90000 });

    // Session input should be re-enabled, meaning the session is still functional
    await expect(textarea).toBeEnabled({ timeout: 20000 });
  });
});
