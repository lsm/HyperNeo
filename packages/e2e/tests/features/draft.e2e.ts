import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';

test.describe('Draft Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: 'New Session', exact: true })
      .waitFor({ timeout: 10000 });
  });

  test.skip('should save draft text while typing', async ({ page }) => {
    await createSessionViaUI(page);

    const draftText = 'This is a draft message';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(draftText);

    await page.waitForTimeout(500);

    const currentUrl = page.url();

    await createSessionViaUI(page);
    await page.waitForTimeout(500);

    await page.goto(currentUrl);
    await page.waitForSelector('textarea[placeholder*="Ask"]', {
      timeout: 10000,
    });
    await page.waitForTimeout(500);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toHaveValue(draftText);
  });

  test('should clear draft after sending message', async ({ page }) => {
    await createSessionViaUI(page);

    const messageText = 'Test message for draft clearing';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(messageText);
    await page.locator('button[aria-label*="Send message"]').first().click();

    await page.waitForSelector(`text=${messageText}`, { timeout: 5000 });

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toHaveValue('');

    await createSessionViaUI(page);
    await page.waitForTimeout(500);

    const sessionButtons = await page
      .locator('button')
      .filter({ hasText: messageText.substring(0, 20) })
      .all();
    if (sessionButtons.length > 0) {
      await sessionButtons[0].click();
    }

    await page.waitForTimeout(500);

    await expect(textarea).toHaveValue('');
  });

  test.skip('should not restore sent message as draft after page reload', async ({ page }) => {
    await createSessionViaUI(page);

    const messageText = 'Message that should not reappear';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(messageText);
    await page.locator('button[aria-label*="Send message"]').first().click();

    await page.waitForSelector(`text=${messageText}`, { timeout: 5000 });

    await page.reload();
    await page
      .getByRole('button', { name: 'New Session', exact: true })
      .waitFor({ timeout: 10000 });

    const sessionButtons = await page
      .locator('button')
      .filter({ hasText: messageText.substring(0, 20) })
      .all();
    if (sessionButtons.length > 0) {
      await sessionButtons[0].click();
    }

    await page.waitForTimeout(500);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toHaveValue('');
  });

  test('should clear draft when user manually deletes all text', async ({ page }) => {
    await createSessionViaUI(page);

    const draftText = 'Draft to be deleted';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(draftText);

    await page.waitForTimeout(500);

    await page.locator('textarea[placeholder*="Ask"]').first().fill('');

    await page.waitForTimeout(200);

    await createSessionViaUI(page);
    await page.waitForTimeout(500);

    const sessionButtons = await page
      .locator('button')
      .filter({ hasText: /^\s*0\s*$/ })
      .all();
    if (sessionButtons.length > 0) {
      await sessionButtons[0].click();
    }

    await page.waitForTimeout(500);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toHaveValue('');
  });

  test('should handle rapid typing and sending without draft interference', async ({ page }) => {
    await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();

    await textarea.fill('Quick message 1');
    await page.locator('button[aria-label*="Send message"]').first().click();

    await expect(textarea).toHaveValue('');

    await page.waitForSelector('text=Quick message 1', { timeout: 5000 });

    await textarea.fill('Quick message 2');
    await page.locator('button[aria-label*="Send message"]').first().click();

    await expect(textarea).toHaveValue('');

    await createSessionViaUI(page);
    await page.waitForTimeout(500);

    const sessionButtons = await page.locator('button').filter({ hasText: 'Quick message' }).all();
    if (sessionButtons.length > 0) {
      await sessionButtons[0].click();
    }

    await page.waitForTimeout(500);

    await expect(textarea).toHaveValue('');
  });

  test.skip('should preserve draft when switching sessions without sending', async ({ page }) => {
    await createSessionViaUI(page);

    const draft1 = 'Draft for session 1';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(draft1);
    await page.waitForTimeout(500);

    await createSessionViaUI(page);

    const draft2 = 'Draft for session 2';
    await page.locator('textarea[placeholder*="Ask"]').first().fill(draft2);
    await page.waitForTimeout(500);

    const sessionButtons = await page
      .locator('button')
      .filter({ hasText: /^\s*0\s*$/ })
      .all();
    if (sessionButtons.length >= 2) {
      await sessionButtons[1].click();
    }

    await page.waitForTimeout(500);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toHaveValue(draft1);

    if (sessionButtons.length >= 2) {
      await sessionButtons[0].click();
    }

    await page.waitForTimeout(500);

    await expect(textarea).toHaveValue(draft2);
  });
});

test.describe('Draft Clearing Bug Fix', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: 'New Session', exact: true })
      .waitFor({ timeout: 10000 });
  });

  test('should NOT restore sent message as draft after session switch', async ({ page }) => {
    await createSessionViaUI(page);

    const messageText = 'This message should not reappear';
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();

    await textarea.fill(messageText);
    await page.locator('button[aria-label*="Send message"]').first().click();

    await expect(textarea).toHaveValue('', { timeout: 2000 });

    await page.waitForSelector(`text=${messageText}`, { timeout: 10000 });

    const firstSessionButton = page.locator('[data-session-id]').first();
    const firstSessionId = await firstSessionButton.getAttribute('data-session-id');

    await createSessionViaUI(page);
    await page.waitForTimeout(500);

    const secondSessionButton = page.locator('[data-session-id]').first();
    const secondSessionId = await secondSessionButton.getAttribute('data-session-id');

    await page.click(`[data-session-id="${firstSessionId}"]`);
    await page.waitForSelector('textarea[placeholder*="Ask"]', {
      timeout: 10000,
    });
    await page.waitForTimeout(500);

    await expect(textarea).toHaveValue('');

    await cleanupTestSession(page, firstSessionId || '');
    await cleanupTestSession(page, secondSessionId || '');
  });

  test('should NOT restore sent message as draft after page reload', async ({ page }) => {
    await createSessionViaUI(page);

    const messageText = 'Message for reload test';
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();

    await textarea.fill(messageText);
    await page.locator('button[aria-label*="Send message"]').first().click();

    await page.waitForSelector(`text=${messageText}`, { timeout: 10000 });

    const sessionButton = page.locator('[data-session-id]').first();
    const sessionId = await sessionButton.getAttribute('data-session-id');

    await page.reload();
    await page
      .getByRole('button', { name: 'New Session', exact: true })
      .waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);

    await page.click(`[data-session-id="${sessionId}"]`);
    await page.waitForSelector('textarea[placeholder*="Ask"]', {
      timeout: 10000,
    });
    await page.waitForTimeout(500);

    const textareaAfterReload = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textareaAfterReload).toHaveValue('');

    await cleanupTestSession(page, sessionId || '');
  });

  test('should handle rapid send without draft race condition', async ({ page }) => {
    await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();

    const sessionButton = page.locator('[data-session-id]').first();
    const firstSessionId = await sessionButton.getAttribute('data-session-id');

    await textarea.fill('Quick message');
    await page.locator('button[aria-label*="Send message"]').first().click();

    await expect(textarea).toHaveValue('', { timeout: 2000 });

    await createSessionViaUI(page);
    await page.waitForTimeout(100);

    const secondSessionButton = page.locator('[data-session-id]').first();
    const secondSessionId = await secondSessionButton.getAttribute('data-session-id');

    await page.click(`[data-session-id="${firstSessionId}"]`);
    await page.waitForSelector('textarea[placeholder*="Ask"]', {
      timeout: 10000,
    });
    await page.waitForTimeout(500);

    const textareaAfter = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textareaAfter).toHaveValue('');

    await cleanupTestSession(page, firstSessionId || '');
    await cleanupTestSession(page, secondSessionId || '');
  });
});
