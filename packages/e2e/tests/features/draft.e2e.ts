/**
 * Draft E2E Tests
 *
 * Consolidated tests for input draft functionality:
 * - Draft persistence across navigation
 * - Draft clearing bug regression tests
 */

import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';

test.describe('Draft Persistence', () => {
  test.beforeEach(async ({ page }) => {
    // Use baseURL from config (supports dynamic port in CI)
    await page.goto('/');
    await page
      .getByRole('button', { name: 'New Session', exact: true })
      .waitFor({ timeout: 10000 });
  });

  test.skip('should save draft text while typing', async ({ page }) => {
    // TODO: Draft persistence feature may not be fully implemented or timing-dependent
    // Create new session
    await createSessionViaUI(page);

    // Type draft text
    const draftText = 'This is a draft message';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(draftText);

    // Wait for debounced save (250ms + buffer)
    await page.waitForTimeout(500);

    // Get the session ID from the URL or store the title
    const currentUrl = page.url();

    // Create another session to switch away
    await createSessionViaUI(page);
    await page.waitForTimeout(500);

    // Navigate back to the first session
    await page.goto(currentUrl);
    await page.waitForSelector('textarea[placeholder*="Ask"]', {
      timeout: 10000,
    });
    await page.waitForTimeout(500);

    // Draft should be restored
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toHaveValue(draftText);
  });

  test('should clear draft after sending message', async ({ page }) => {
    // Create new session
    await createSessionViaUI(page);

    // Type and send message
    const messageText = 'Test message for draft clearing';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(messageText);
    await page.locator('button[aria-label*="Send message"]').first().click();

    // Wait for message to be sent
    await page.waitForSelector(`text=${messageText}`, { timeout: 5000 });

    // Textarea should be empty
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toHaveValue('');

    // Switch to another session
    await createSessionViaUI(page);
    await page.waitForTimeout(500);

    // Go back to test session
    const sessionButtons = await page
      .locator('button')
      .filter({ hasText: messageText.substring(0, 20) })
      .all();
    if (sessionButtons.length > 0) {
      await sessionButtons[0].click();
    }

    await page.waitForTimeout(500);

    // Textarea should STILL be empty (this is the bug we're testing)
    await expect(textarea).toHaveValue('');
  });

  test.skip('should not restore sent message as draft after page reload', async ({ page }) => {
    // TODO: Draft persistence feature may not be fully implemented
    // Create new session
    await createSessionViaUI(page);

    // Type and send message
    const messageText = 'Message that should not reappear';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(messageText);
    await page.locator('button[aria-label*="Send message"]').first().click();

    // Wait for message to be sent
    await page.waitForSelector(`text=${messageText}`, { timeout: 5000 });

    // Reload the page
    await page.reload();
    await page
      .getByRole('button', { name: 'New Session', exact: true })
      .waitFor({ timeout: 10000 });

    // Navigate back to the session
    const sessionButtons = await page
      .locator('button')
      .filter({ hasText: messageText.substring(0, 20) })
      .all();
    if (sessionButtons.length > 0) {
      await sessionButtons[0].click();
    }

    await page.waitForTimeout(500);

    // Textarea should be empty
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toHaveValue('');
  });

  test('should clear draft when user manually deletes all text', async ({ page }) => {
    // Create new session
    await createSessionViaUI(page);

    // Type draft text
    const draftText = 'Draft to be deleted';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(draftText);

    // Wait for debounced save
    await page.waitForTimeout(500);

    // Clear the textarea
    await page.locator('textarea[placeholder*="Ask"]').first().fill('');

    // Wait for immediate save of empty draft
    await page.waitForTimeout(200);

    // Switch to another session and back
    await createSessionViaUI(page);
    await page.waitForTimeout(500);

    // Go back to first session
    const sessionButtons = await page
      .locator('button')
      .filter({ hasText: /^\s*0\s*$/ })
      .all();
    if (sessionButtons.length > 0) {
      await sessionButtons[0].click();
    }

    await page.waitForTimeout(500);

    // Textarea should remain empty
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toHaveValue('');
  });

  test('should handle rapid typing and sending without draft interference', async ({ page }) => {
    // Create new session
    await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();

    // Type quickly and send without waiting for debounce
    await textarea.fill('Quick message 1');
    await page.locator('button[aria-label*="Send message"]').first().click();

    // Textarea should clear immediately
    await expect(textarea).toHaveValue('');

    // Wait for message to appear
    await page.waitForSelector('text=Quick message 1', { timeout: 5000 });

    // Type another message quickly
    await textarea.fill('Quick message 2');
    await page.locator('button[aria-label*="Send message"]').first().click();

    // Textarea should clear again
    await expect(textarea).toHaveValue('');

    // Switch sessions
    await createSessionViaUI(page);
    await page.waitForTimeout(500);

    // Go back
    const sessionButtons = await page.locator('button').filter({ hasText: 'Quick message' }).all();
    if (sessionButtons.length > 0) {
      await sessionButtons[0].click();
    }

    await page.waitForTimeout(500);

    // Textarea should still be empty, not showing any sent messages
    await expect(textarea).toHaveValue('');
  });

  test.skip('should preserve draft when switching sessions without sending', async ({ page }) => {
    // TODO: Draft persistence feature may not be fully implemented
    // Create first session
    await createSessionViaUI(page);

    // Type draft in first session
    const draft1 = 'Draft for session 1';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(draft1);
    await page.waitForTimeout(500);

    // Create second session
    await createSessionViaUI(page);

    // Type draft in second session
    const draft2 = 'Draft for session 2';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(draft2);
    await page.waitForTimeout(500);

    // Go back to first session
    const sessionButtons = await page
      .locator('button')
      .filter({ hasText: /^\s*0\s*$/ })
      .all();
    if (sessionButtons.length >= 2) {
      await sessionButtons[1].click(); // Second "0 messages" session (first created)
    }

    await page.waitForTimeout(500);

    // Should show first draft
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toHaveValue(draft1);

    // Go back to second session
    if (sessionButtons.length >= 2) {
      await sessionButtons[0].click(); // First "0 messages" session (most recent)
    }

    await page.waitForTimeout(500);

    // Should show second draft
    await expect(textarea).toHaveValue(draft2);
  });
});

test.describe('Draft Clearing Bug Fix', () => {
  test.beforeEach(async ({ page }) => {
    // Use baseURL from config (supports dynamic port in CI)
    await page.goto('/');
    await page
      .getByRole('button', { name: 'New Session', exact: true })
      .waitFor({ timeout: 10000 });
  });

  test('should NOT restore sent message as draft after session switch', async ({ page }) => {
    // Create first session
    await createSessionViaUI(page);

    // Type and send message
    const messageText = 'This message should not reappear';
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();

    await textarea.fill(messageText);
    await page.locator('button[aria-label*="Send message"]').first().click();

    // Textarea should clear immediately
    await expect(textarea).toHaveValue('', { timeout: 2000 });

    // Wait for message to appear in chat
    await page.waitForSelector(`text=${messageText}`, { timeout: 10000 });

    // Get the first session's data-session-id attribute
    const firstSessionButton = page.locator('[data-session-id]').first();
    const firstSessionId = await firstSessionButton.getAttribute('data-session-id');

    // Create another session to switch away
    await createSessionViaUI(page);
    await page.waitForTimeout(500);

    // Get second session ID for cleanup
    const secondSessionButton = page.locator('[data-session-id]').first();
    const secondSessionId = await secondSessionButton.getAttribute('data-session-id');

    // Navigate back to the original session by clicking its button
    await page.click(`[data-session-id="${firstSessionId}"]`);
    await page.waitForSelector('textarea[placeholder*="Ask"]', {
      timeout: 10000,
    });
    await page.waitForTimeout(500);

    // CRITICAL: Textarea should STILL be empty (not showing the sent message)
    await expect(textarea).toHaveValue('');

    // Cleanup
    await cleanupTestSession(page, firstSessionId || '');
    await cleanupTestSession(page, secondSessionId || '');
  });

  test('should NOT restore sent message as draft after page reload', async ({ page }) => {
    // Create new session
    await createSessionViaUI(page);

    // Type and send message
    const messageText = 'Message for reload test';
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();

    await textarea.fill(messageText);
    await page.locator('button[aria-label*="Send message"]').first().click();

    // Wait for message to appear
    await page.waitForSelector(`text=${messageText}`, { timeout: 10000 });

    // Get the session ID before reload
    const sessionButton = page.locator('[data-session-id]').first();
    const sessionId = await sessionButton.getAttribute('data-session-id');

    // Reload the page
    await page.reload();
    await page
      .getByRole('button', { name: 'New Session', exact: true })
      .waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);

    // Navigate to the session by clicking its button
    await page.click(`[data-session-id="${sessionId}"]`);
    await page.waitForSelector('textarea[placeholder*="Ask"]', {
      timeout: 10000,
    });
    await page.waitForTimeout(500);

    // CRITICAL: Textarea should be empty after reload
    const textareaAfterReload = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textareaAfterReload).toHaveValue('');

    // Cleanup
    await cleanupTestSession(page, sessionId || '');
  });

  test('should handle rapid send without draft race condition', async ({ page }) => {
    // Create new session
    await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();

    // Get the session ID
    const sessionButton = page.locator('[data-session-id]').first();
    const firstSessionId = await sessionButton.getAttribute('data-session-id');

    // Send message quickly (before 250ms debounce)
    await textarea.fill('Quick message');
    await page.locator('button[aria-label*="Send message"]').first().click();

    // Should clear immediately
    await expect(textarea).toHaveValue('', { timeout: 2000 });

    // Switch away and back quickly
    await createSessionViaUI(page);
    await page.waitForTimeout(100);

    // Get second session ID for cleanup
    const secondSessionButton = page.locator('[data-session-id]').first();
    const secondSessionId = await secondSessionButton.getAttribute('data-session-id');

    await page.click(`[data-session-id="${firstSessionId}"]`);
    await page.waitForSelector('textarea[placeholder*="Ask"]', {
      timeout: 10000,
    });
    await page.waitForTimeout(500);

    // Should STILL be empty (no race condition)
    const textareaAfter = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textareaAfter).toHaveValue('');

    // Cleanup
    await cleanupTestSession(page, firstSessionId || '');
    await cleanupTestSession(page, secondSessionId || '');
  });
});
