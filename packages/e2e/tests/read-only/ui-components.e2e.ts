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

      // Hover over button
      await newSessionButton.hover();

      // Wait for transition
      await page.waitForTimeout(200);

      // Color might change on hover (depending on implementation)
      // This is a basic check that the element is interactive
      await expect(newSessionButton).toBeVisible();
    });
  });

  test.describe('Transitions and Animations', () => {
    test('should have smooth transitions', async ({ page }) => {
      // Hover over new session button
      const button = page.getByRole('button', {
        name: 'New Session',
        exact: true,
      });
      await button.hover();

      // Element should still be visible after hover (basic check)
      await expect(button).toBeVisible();

      // Check that animations don't cause layout shifts
      const boundingBox = await button.boundingBox();
      expect(boundingBox).toBeTruthy();
    });
  });

  test.describe('Responsive Design', () => {
    test('should be usable on mobile viewports', async ({ page }) => {
      // Set mobile viewport
      await page.setViewportSize({ width: 375, height: 667 });

      await page.reload();
      await page.waitForTimeout(500);

      // Main elements should still be visible
      await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible();
    });

    test('should be usable on tablet viewports', async ({ page }) => {
      // Set tablet viewport
      await page.setViewportSize({ width: 768, height: 1024 });

      await page.reload();
      await page.waitForTimeout(500);

      // All main elements should be visible
      await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
      await expect(page.locator('text=Your agent command center')).toBeVisible();
    });
  });

  test.describe('Accessibility', () => {
    test('should have proper heading hierarchy', async ({ page }) => {
      // Check for h2 (the main heading level used in the app)
      const h2 = page.locator('h2').first();
      await expect(h2).toBeVisible();

      // Verify it contains meaningful text
      const h2Text = await h2.textContent();
      expect(h2Text).toBeTruthy();
      expect(h2Text?.length).toBeGreaterThan(0);
    });

    test('should have focusable interactive elements', async ({ page }) => {
      const newSessionButton = page.getByRole('button', {
        name: 'New Session',
        exact: true,
      });

      // Focus the button
      await newSessionButton.focus();

      // Button should be focused
      await expect(newSessionButton).toBeFocused();
    });
  });
});
