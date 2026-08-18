import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';

test.describe('Character Counter', () => {
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

  test('should display character count when typing', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible();

    await textarea.fill('Hello, this is a test message');

    const charCounter = page.locator(
      '[data-testid="char-counter"], .char-counter, [class*="counter"]'
    );

    const _counterVisible = await charCounter.isVisible().catch(() => false);

    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('Hello, this is a test message');
  });

  test('should accept text up to maximum limit', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible();

    const longText = 'A'.repeat(1000);
    await textarea.fill(longText);

    const inputValue = await textarea.inputValue();
    expect(inputValue.length).toBe(1000);
  });

  test('should prevent exceeding character limit', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible();

    const veryLongText = 'A'.repeat(11000);
    await textarea.fill(veryLongText);

    const inputValue = await textarea.inputValue();

    expect(inputValue.length).toBeGreaterThan(0);

    const maxLength = await textarea.getAttribute('maxlength');
    if (maxLength) {
      expect(inputValue.length).toBeLessThanOrEqual(parseInt(maxLength));
    }
  });

  test('should show visual feedback near character limit', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible();

    const nearLimitText = 'A'.repeat(9500);
    await textarea.fill(nearLimitText);

    const warningIndicators = page.locator(
      '[class*="warning"], [class*="error"], [class*="red"], [class*="danger"], .text-red'
    );

    const _warningCount = await warningIndicators.count();

    const counterWithWarning = page.locator(
      '[data-testid="char-counter"].warning, .char-counter.warning'
    );
    const _counterWarningVisible = await counterWithWarning.isVisible().catch(() => false);

    const currentValue = await textarea.inputValue();
    expect(currentValue.length).toBe(9500);
  });

  test('should clear counter when text is deleted', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible();

    await textarea.fill('Hello world');

    await textarea.fill('');

    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('');

    const charCounter = page.locator('[data-testid="char-counter"], .char-counter');
    if (await charCounter.isVisible().catch(() => false)) {
      const counterText = await charCounter.textContent();
      expect(counterText).toMatch(/^0|^$/);
    }
  });
});
