import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';

test.describe
  .serial('Session List Ordering', () => {
    const sessionIds: string[] = [];

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
    });

    test.afterEach(async ({ page }) => {
      // Cleanup all sessions created during the test
      for (const sessionId of sessionIds) {
        try {
          await cleanupTestSession(page, sessionId);
        } catch (error) {
          console.warn(`Failed to cleanup session ${sessionId}:`, error);
        }
      }
      sessionIds.length = 0; // Clear array
    });

    test('should show newly created session at top of session list', async ({ page }) => {
      // Get initial session count
      const sessionItems = page.locator('button[data-session-id]');
      const initialCount = await sessionItems.count();

      // Create first session
      const firstSessionId = await createSessionViaUI(page);
      sessionIds.push(firstSessionId);

      // Go back to home and wait for sidebar to update
      await page.goto('/');
      await page.waitForTimeout(1000);

      // Wait for session count to increase
      await page.waitForFunction(
        (initial) => {
          const items = document.querySelectorAll('button[data-session-id]');
          return items.length > initial;
        },
        initialCount,
        { timeout: 5000 }
      );

      // Get the first session ID from the sidebar (should be the one we just created)
      const firstSessionInList = await sessionItems.first().getAttribute('data-session-id');
      expect(firstSessionInList).toBe(firstSessionId);

      // Create second session
      const countBeforeSecond = await sessionItems.count();
      const secondSessionId = await createSessionViaUI(page);
      sessionIds.push(secondSessionId);

      // Go back to home and wait for sidebar to update
      await page.goto('/');
      await page.waitForTimeout(1000);

      // Wait for session count to increase
      await page.waitForFunction(
        (beforeCount) => {
          const items = document.querySelectorAll('button[data-session-id]');
          return items.length > beforeCount;
        },
        countBeforeSecond,
        { timeout: 5000 }
      );

      // Get the first two session IDs from the sidebar
      const firstListItemId = await sessionItems.first().getAttribute('data-session-id');
      const secondListItemId = await sessionItems.nth(1).getAttribute('data-session-id');

      // The most recently created session should be at the top
      expect(firstListItemId).toBe(secondSessionId);
      // The first created session should be second
      expect(secondListItemId).toBe(firstSessionId);
    });

    test('should maintain correct order after creating multiple sessions', async ({ page }) => {
      const createdSessionIds: string[] = [];
      const initialCount = await page.locator('button[data-session-id]').count();

      // Create 3 sessions in sequence
      for (let i = 0; i < 3; i++) {
        const sessionId = await createSessionViaUI(page);
        createdSessionIds.push(sessionId);
        sessionIds.push(sessionId);

        // Go back to home and wait for sidebar to update
        await page.goto('/');
        await page.waitForTimeout(1000);

        // Wait for session count to increase
        await page.waitForFunction(
          (initial) => {
            const items = document.querySelectorAll('button[data-session-id]');
            return items.length > initial;
          },
          initialCount + i,
          { timeout: 5000 }
        );
      }

      // Get all session items from the sidebar
      const sessionItems = page.locator('button[data-session-id]');

      // Get the first 3 session IDs from the sidebar (newest first)
      const firstThreeIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const sessionId = await sessionItems.nth(i).getAttribute('data-session-id');
        if (sessionId) firstThreeIds.push(sessionId);
      }

      // The created sessions should be in reverse order (newest first)
      // Reverse the createdSessionIds array
      const expectedOrder = [...createdSessionIds].reverse();

      // The first 3 items in the sidebar should match our created sessions in reverse order
      expect(firstThreeIds).toEqual(expectedOrder);
    });
  });
