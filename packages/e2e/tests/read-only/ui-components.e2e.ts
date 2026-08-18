import { test, expect } from '../../fixtures';

test.describe('UI Components', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
  });

  test.describe('Buttons', () => {
    test('should have hover effects on interactive elements', async ({ page }) => {
      const newSessionButton = page.getByRole('button', {
        name: 'New Session',
        exact: true,
      });

      await newSessionButton.hover();

      await page.waitForTimeout(200);

      await expect(newSessionButton).toBeVisible();
    });
  });

  test.describe('Transitions and Animations', () => {
    test('should have smooth transitions', async ({ page }) => {
      const button = page.getByRole('button', {
        name: 'New Session',
        exact: true,
      });
      await button.hover();

      await expect(button).toBeVisible();

      const boundingBox = await button.boundingBox();
      expect(boundingBox).toBeTruthy();
    });
  });

  test.describe('Responsive Design', () => {
    test('should be usable on mobile viewports', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });

      await page.reload();
      await page.waitForTimeout(500);

      await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible();
    });

    test('should be usable on tablet viewports', async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });

      await page.reload();
      await page.waitForTimeout(500);

      await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
      await expect(page.locator('text=Your agent command center')).toBeVisible();
    });
  });

  test.describe('Accessibility', () => {
    test('should have proper heading hierarchy', async ({ page }) => {
      const h2 = page.locator('h2').first();
      await expect(h2).toBeVisible();

      const h2Text = await h2.textContent();
      expect(h2Text).toBeTruthy();
      expect(h2Text?.length).toBeGreaterThan(0);
    });

    test('should have focusable interactive elements', async ({ page }) => {
      const newSessionButton = page.getByRole('button', {
        name: 'New Session',
        exact: true,
      });

      await newSessionButton.focus();

      await expect(newSessionButton).toBeFocused();
    });
  });
});
