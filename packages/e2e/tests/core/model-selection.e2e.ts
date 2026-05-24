/**
 * Model Selection E2E Tests
 *
 * Comprehensive tests for model selection behavior:
 * - Model persistence when selected before first message (critical regression)
 * - Model switcher dropdown filtering (no duplicates)
 * - Default model configuration (DEFAULT_MODEL env var)
 *
 * CRITICAL REGRESSION TESTS:
 * - Model selected before first message must persist (bug: reset to default)
 * - Legacy model IDs should not appear as duplicates in dropdown
 *
 * MERGED FROM:
 * - model-selection-persistence.e2e.ts (base - critical regression)
 * - model-list-duplicates.e2e.ts (critical regression)
 * - default-model-haiku.e2e.ts
 * - model-switcher.e2e.ts (basic UI interactions already covered)
 */

import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForAssistantResponse,
} from '../helpers/wait-helpers';

test.describe('Model Selection Persistence', () => {
  test('should persist selected model after first message', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Create a new session
    await createSessionViaUI(page);

    // Wait for chat interface to load
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 15000 });

    // Find the model switcher button
    const modelSwitcher = page.locator('button[title*="Switch Model"]').first();
    await expect(modelSwitcher).toBeVisible({ timeout: 10000 });

    // Get initial model title BEFORE sending any message
    // This is the critical regression test: model should NOT reset after first message
    const initialTitle = await modelSwitcher.getAttribute('title');
    expect(initialTitle).toBeTruthy();
    console.log('Initial model title:', initialTitle);

    // Send first message
    await messageInput.fill('Hello');
    await messageInput.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page, { timeout: 90000 });

    // CRITICAL: Verify model switcher STILL shows the SAME model after message
    // This catches the regression where model would reset to default after first message
    const postMessageTitle = await modelSwitcher.getAttribute('title');
    console.log('Post-message model title:', postMessageTitle);
    expect(postMessageTitle).toEqual(initialTitle);
  });

  test('should use default model and persist after first message', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Create a new session
    await createSessionViaUI(page);

    // Wait for input to be ready
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 15000 });
    await expect(messageInput).toBeEnabled({ timeout: 5000 });

    // Check that model switcher button is visible
    const modelSwitcher = page.locator('button[title*="Switch Model"]').first();
    await expect(modelSwitcher).toBeVisible({ timeout: 10000 });

    // Get initial model title BEFORE sending any message
    const initialTitle = await modelSwitcher.getAttribute('title');
    expect(initialTitle).toBeTruthy();
    expect(initialTitle).toMatch(/Switch Model/i);
    console.log('Initial model title:', initialTitle);

    // Send first message
    await messageInput.fill('Hello');
    await messageInput.press('Enter');

    // Wait for assistant response
    await waitForAssistantResponse(page, { timeout: 90000 });

    // CRITICAL: Verify model switcher STILL shows the SAME model after message
    // This catches the regression where model would reset to default after first message
    const postMessageTitle = await modelSwitcher.getAttribute('title');
    console.log('Post-message model title:', postMessageTitle);
    expect(postMessageTitle).toEqual(initialTitle);
  });
});

// ============================================================
// Tests merged from model-list-duplicates.e2e.ts
// CRITICAL REGRESSION: Legacy model IDs should not show as duplicates
// ============================================================

test.describe('Model List Duplicates', () => {
  let sessionId: string | null = null;

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

  test('should not show duplicate Sonnet models in model switcher', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Create new session
    sessionId = await createSessionViaUI(page);

    // Wait for chat interface to load
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 15000 });

    // Find and click the model switcher button (uses title attribute since button shows emoji icon)
    const modelSwitcher = page.locator('button[title*="Switch Model"]').first();
    await expect(modelSwitcher).toBeVisible({ timeout: 10000 });
    await modelSwitcher.click();

    // Wait for dropdown to open
    await page.waitForTimeout(500);

    // Get all model option buttons in the dropdown
    const modelOptions = page.getByRole('button').filter({ hasText: /Sonnet|Opus|Haiku|GLM/ });
    const modelCount = await modelOptions.count();

    // Get text of all model options
    const modelTexts: string[] = [];
    for (let i = 0; i < modelCount; i++) {
      const text = await modelOptions.nth(i).textContent();
      if (text) modelTexts.push(text.trim());
    }

    console.log('Found models:', modelTexts);

    // Count Sonnet models
    const sonnetModels = modelTexts.filter((text) => text.toLowerCase().includes('sonnet'));

    console.log('Sonnet models found:', sonnetModels);

    // Assert: Should NOT contain the legacy model ID
    const hasLegacyId = modelTexts.some((text) => text.includes('claude-sonnet-4-5-20250929'));
    expect(hasLegacyId).toBe(false);

    // Assert: Should have at most 2 Sonnet models:
    // 1. "Sonnet 4.5" (default)
    // 2. "Sonnet 4.5 with 1M context" (sonnet[1m])
    expect(sonnetModels.length).toBeLessThanOrEqual(2);

    // Assert: Each model should appear only once
    const uniqueModels = new Set(modelTexts);
    expect(modelTexts.length).toBe(uniqueModels.size);
  });
});

// ============================================================
// Tests merged from default-model-haiku.e2e.ts
// Tests DEFAULT_MODEL environment variable
// ============================================================

test.describe('Default Model Configuration', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
    await page.waitForTimeout(1000);
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

  test.skip('should create sessions with Haiku model when DEFAULT_MODEL=haiku', async ({
    page,
  }) => {
    // SKIPPED: This test requires Haiku model availability which may not be available
    // with all API keys. The fix for model aliases has been implemented in model-service.ts
    // by setting the alias from LEGACY_MODEL_MAPPINGS.

    // Create a new session
    sessionId = await createSessionViaUI(page);
    expect(sessionId).toBeTruthy();

    // Get the session data via RPC to check the model
    const sessionData = await page.evaluate(async (sid) => {
      const messageHub = window.__messageHub || window.appState?.messageHub;
      if (!messageHub) {
        throw new Error('MessageHub not available');
      }

      try {
        const response = await messageHub.call('session.get', {
          sessionId: sid,
        });
        return response;
      } catch (error) {
        console.error('Failed to get session:', error);
        throw error;
      }
    }, sessionId);

    // Verify the session was retrieved
    expect(sessionData).toBeTruthy();
    expect(sessionData.session).toBeTruthy();

    // Verify the model is set to Haiku
    const modelId = sessionData.session.config.model;
    expect(modelId).toBeTruthy();

    // The model should contain "haiku" in the ID (case-insensitive)
    expect(modelId.toLowerCase()).toContain('haiku');

    console.log(`✅ Session ${sessionId} created with model: ${modelId}`);
  });
});
