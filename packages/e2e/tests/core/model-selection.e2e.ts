import { test, expect } from '../../fixtures';
import {
  cleanupTestSession,
  createSessionViaUI,
  waitForAssistantResponse,
} from '../helpers/wait-helpers';

test.describe('Model Selection Persistence', () => {
  test('should persist selected model after first message', async ({ page }) => {
    await page.goto('/');

    await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 15000 });

    const modelSwitcher = page.locator('button[title*="Switch Model"]').first();
    await expect(modelSwitcher).toBeVisible({ timeout: 10000 });

    const initialTitle = await modelSwitcher.getAttribute('title');
    expect(initialTitle).toBeTruthy();
    console.log('Initial model title:', initialTitle);

    await messageInput.fill('Hello');
    await messageInput.press('Enter');

    await waitForAssistantResponse(page, { timeout: 90000 });

    const postMessageTitle = await modelSwitcher.getAttribute('title');
    console.log('Post-message model title:', postMessageTitle);
    expect(postMessageTitle).toEqual(initialTitle);
  });

  test('should use default model and persist after first message', async ({ page }) => {
    await page.goto('/');

    await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 15000 });
    await expect(messageInput).toBeEnabled({ timeout: 5000 });

    const modelSwitcher = page.locator('button[title*="Switch Model"]').first();
    await expect(modelSwitcher).toBeVisible({ timeout: 10000 });

    const initialTitle = await modelSwitcher.getAttribute('title');
    expect(initialTitle).toBeTruthy();
    expect(initialTitle).toMatch(/Switch Model/i);
    console.log('Initial model title:', initialTitle);

    await messageInput.fill('Hello');
    await messageInput.press('Enter');

    await waitForAssistantResponse(page, { timeout: 90000 });

    const postMessageTitle = await modelSwitcher.getAttribute('title');
    console.log('Post-message model title:', postMessageTitle);
    expect(postMessageTitle).toEqual(initialTitle);
  });
});

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
    await page.goto('/');

    sessionId = await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 15000 });

    const modelSwitcher = page.locator('button[title*="Switch Model"]').first();
    await expect(modelSwitcher).toBeVisible({ timeout: 10000 });
    await modelSwitcher.click();

    await page.waitForTimeout(500);

    const modelOptions = page.getByRole('button').filter({ hasText: /Sonnet|Opus|Haiku|GLM/ });
    const modelCount = await modelOptions.count();

    const modelTexts: string[] = [];
    for (let i = 0; i < modelCount; i++) {
      const text = await modelOptions.nth(i).textContent();
      if (text) modelTexts.push(text.trim());
    }

    console.log('Found models:', modelTexts);

    const sonnetModels = modelTexts.filter((text) => text.toLowerCase().includes('sonnet'));

    console.log('Sonnet models found:', sonnetModels);

    const hasLegacyId = modelTexts.some((text) => text.includes('claude-sonnet-4-5-20250929'));
    expect(hasLegacyId).toBe(false);

    expect(sonnetModels.length).toBeLessThanOrEqual(2);

    const uniqueModels = new Set(modelTexts);
    expect(modelTexts.length).toBe(uniqueModels.size);
  });
});

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
    sessionId = await createSessionViaUI(page);
    expect(sessionId).toBeTruthy();

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

    expect(sessionData).toBeTruthy();
    expect(sessionData.session).toBeTruthy();

    const modelId = sessionData.session.config.model;
    expect(modelId).toBeTruthy();

    expect(modelId.toLowerCase()).toContain('haiku');

    console.log(`✅ Session ${sessionId} created with model: ${modelId}`);
  });
});
