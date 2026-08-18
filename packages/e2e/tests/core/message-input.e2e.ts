import { test, expect } from '../../fixtures';
import {
  setupMessageHubTesting,
  createSessionViaUI,
  waitForElement,
  cleanupTestSession,
} from '../helpers/wait-helpers';

test.describe('Message Input Processing State', () => {
  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test.skip('should keep plus button enabled during processing', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Write a detailed essay about quantum computing.');
    await page.click('[data-testid="send-button"]');

    await page.waitForTimeout(1000);

    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });

    const plusButton = page.locator('button[title="More options"]');
    await expect(plusButton).toBeVisible();
    await expect(plusButton).toBeEnabled();

    const classes = await plusButton.getAttribute('class');
    expect(classes).not.toContain('cursor-not-allowed');
    expect(classes).not.toContain('opacity-50');

    await plusButton.click();
    await page.waitForTimeout(200);

    const menu = page.locator('div:has(> button:has-text("Auto-scroll"))').first();
    await expect(menu).toBeVisible();

    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should disable model switcher during processing', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain machine learning in detail.');
    await page.click('[data-testid="send-button"]');

    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();
    await page.waitForTimeout(200);

    const modelSwitcherInMenu = page
      .locator(
        'button:has-text("Select Model"), button:has-text("Sonnet"), button:has-text("Opus"), button:has-text("Haiku")'
      )
      .first();

    await expect(modelSwitcherInMenu).toBeVisible();
    const classes = await modelSwitcherInMenu.getAttribute('class');
    expect(classes).toContain('opacity-50');
    expect(classes).toContain('cursor-not-allowed');

    await expect(modelSwitcherInMenu).toBeDisabled();

    await page.keyboard.press('Escape');

    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should allow typing in textarea during processing', async ({ page }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain neural networks.');
    await page.click('[data-testid="send-button"]');

    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });

    await expect(messageInput).toBeEnabled();

    const testText = 'This is a follow-up question.';
    await messageInput.fill(testText);

    const inputValue = await messageInput.inputValue();
    expect(inputValue).toBe(testText);

    await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible();

    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should show visual feedback when model switcher is disabled during processing', async ({
    page,
  }) => {
    const sessionId = await createSessionViaUI(page);

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();
    await page.waitForTimeout(200);

    const modelSwitcherBefore = page
      .locator(
        'button:has-text("Select Model"), button:has-text("Sonnet"), button:has-text("Opus"), button:has-text("Haiku")'
      )
      .first();
    const classesBeforeProcessing = await modelSwitcherBefore.getAttribute('class');

    expect(classesBeforeProcessing).not.toContain('opacity-50');
    expect(classesBeforeProcessing).not.toContain('cursor-not-allowed');

    await page.keyboard.press('Escape');

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain consensus algorithms.');
    await page.click('[data-testid="send-button"]');

    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });

    await plusButton.click();
    await page.waitForTimeout(200);

    const modelSwitcherDuringProcessing = page
      .locator(
        'button:has-text("Select Model"), button:has-text("Sonnet"), button:has-text("Opus"), button:has-text("Haiku")'
      )
      .first();
    const classesDuringProcessing = await modelSwitcherDuringProcessing.getAttribute('class');

    expect(classesDuringProcessing).toContain('opacity-50');
    expect(classesDuringProcessing).toContain('cursor-not-allowed');

    await page.keyboard.press('Escape');
    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should allow clicking plus button and then typing while processing', async ({
    page,
  }) => {
    const sessionId = await createSessionViaUI(page);

    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain the CAP theorem.');
    await page.click('[data-testid="send-button"]');

    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });

    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();
    await page.waitForTimeout(200);

    const menu = page.locator('div:has(> button:has-text("Auto-scroll"))').first();
    await expect(menu).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    const newText = 'Follow-up about consistency.';
    await messageInput.fill(newText);

    const inputValue = await messageInput.inputValue();
    expect(inputValue).toBe(newText);

    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });
});
