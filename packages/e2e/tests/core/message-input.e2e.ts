/**
 * Message Input E2E Tests
 *
 * Tests for message input component behavior during different states:
 * - Input enablement/disablement during processing
 * - Model switcher state during processing
 * - Layout and styling (send button alignment, stop button icons)
 *
 * MERGED FROM:
 * - message-input-processing-state.e2e.ts (base)
 * - message-input-layout-and-styling.e2e.ts
 */

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
    // Create a session
    const sessionId = await createSessionViaUI(page);

    // Send a message to trigger processing
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Write a detailed essay about quantum computing.');
    await page.click('[data-testid="send-button"]');

    // Wait for processing to start
    await page.waitForTimeout(1000);

    // Wait for stop button to appear (confirms processing started)
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });

    // Plus button should still be enabled (not disabled)
    const plusButton = page.locator('button[title="More options"]');
    await expect(plusButton).toBeVisible();
    await expect(plusButton).toBeEnabled();

    // Plus button should not have disabled classes
    const classes = await plusButton.getAttribute('class');
    expect(classes).not.toContain('cursor-not-allowed');
    expect(classes).not.toContain('opacity-50');

    // Click plus button to verify it opens menu
    await plusButton.click();
    await page.waitForTimeout(200);

    // Menu should be visible
    const menu = page.locator('div:has(> button:has-text("Auto-scroll"))').first();
    await expect(menu).toBeVisible();

    // Interrupt to clean up
    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should disable model switcher during processing', async ({ page }) => {
    // Create a session
    const sessionId = await createSessionViaUI(page);

    // Send a message to trigger processing
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain machine learning in detail.');
    await page.click('[data-testid="send-button"]');

    // Wait for processing to start
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });

    // Open plus menu
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();
    await page.waitForTimeout(200);

    // Find model switcher button in menu
    const modelSwitcherInMenu = page
      .locator(
        'button:has-text("Select Model"), button:has-text("Sonnet"), button:has-text("Opus"), button:has-text("Haiku")'
      )
      .first();

    // Model switcher should be visible but have opacity-50 (disabled visual)
    await expect(modelSwitcherInMenu).toBeVisible();
    const classes = await modelSwitcherInMenu.getAttribute('class');
    expect(classes).toContain('opacity-50');
    expect(classes).toContain('cursor-not-allowed');

    // Should also be disabled at DOM level
    await expect(modelSwitcherInMenu).toBeDisabled();

    // Close menu
    await page.keyboard.press('Escape');

    // Interrupt to clean up
    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should allow typing in textarea during processing', async ({ page }) => {
    // Create a session
    const sessionId = await createSessionViaUI(page);

    // Send a message to trigger processing
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain neural networks.');
    await page.click('[data-testid="send-button"]');

    // Wait for processing to start
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });

    // Textarea should be enabled (allowing typing)
    await expect(messageInput).toBeEnabled();

    // Type text in textarea
    const testText = 'This is a follow-up question.';
    await messageInput.fill(testText);

    // Verify text appears in textarea
    const inputValue = await messageInput.inputValue();
    expect(inputValue).toBe(testText);

    // Send button should NOT be visible (stop button is shown instead)
    await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

    // Stop button should be visible (confirming we can't send while processing)
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible();

    // Interrupt to clean up
    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should show visual feedback when model switcher is disabled during processing', async ({
    page,
  }) => {
    // Create a session
    const sessionId = await createSessionViaUI(page);

    // First check enabled state (before processing)
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();
    await page.waitForTimeout(200);

    const modelSwitcherBefore = page
      .locator(
        'button:has-text("Select Model"), button:has-text("Sonnet"), button:has-text("Opus"), button:has-text("Haiku")'
      )
      .first();
    const classesBeforeProcessing = await modelSwitcherBefore.getAttribute('class');

    // Should NOT have disabled styling before processing
    expect(classesBeforeProcessing).not.toContain('opacity-50');
    expect(classesBeforeProcessing).not.toContain('cursor-not-allowed');

    // Close menu
    await page.keyboard.press('Escape');

    // Send a message to trigger processing
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain consensus algorithms.');
    await page.click('[data-testid="send-button"]');

    // Wait for processing to start
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });

    // Open plus menu again
    await plusButton.click();
    await page.waitForTimeout(200);

    // Check model switcher styling during processing
    const modelSwitcherDuringProcessing = page
      .locator(
        'button:has-text("Select Model"), button:has-text("Sonnet"), button:has-text("Opus"), button:has-text("Haiku")'
      )
      .first();
    const classesDuringProcessing = await modelSwitcherDuringProcessing.getAttribute('class');

    // Should have disabled styling during processing
    expect(classesDuringProcessing).toContain('opacity-50');
    expect(classesDuringProcessing).toContain('cursor-not-allowed');

    // Interrupt to clean up
    await page.keyboard.press('Escape');
    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });

  test.skip('should allow clicking plus button and then typing while processing', async ({
    page,
  }) => {
    // Create a session
    const sessionId = await createSessionViaUI(page);

    // Send a message to trigger processing
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Explain the CAP theorem.');
    await page.click('[data-testid="send-button"]');

    // Wait for processing to start
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
      timeout: 5000,
    });

    // Click plus button (should work)
    const plusButton = page.locator('button[title="More options"]');
    await plusButton.click();
    await page.waitForTimeout(200);

    // Menu should be visible
    const menu = page.locator('div:has(> button:has-text("Auto-scroll"))').first();
    await expect(menu).toBeVisible();

    // Close menu
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Type in textarea (should work)
    const newText = 'Follow-up about consistency.';
    await messageInput.fill(newText);

    // Verify text was entered
    const inputValue = await messageInput.inputValue();
    expect(inputValue).toBe(newText);

    // Interrupt to clean up
    await page.click('[data-testid="stop-button"]');
    await page.waitForTimeout(1000);

    await cleanupTestSession(page, sessionId);
  });
});
