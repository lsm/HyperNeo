import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';

test.describe
  .serial('Session List Ordering', () => {
    const sessionIds: string[] = [];

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
    });

    test.afterEach(async ({ page }) => {
      for (const sessionId of sessionIds) {
        try {
          await cleanupTestSession(page, sessionId);
        } catch (error) {
          console.warn(`Failed to cleanup session ${sessionId}:`, error);
        }
      }
      sessionIds.length = 0;
    });

    test('should show newly created session at top of session list', async ({ page }) => {
      const sessionItems = page.locator('button[data-session-id]');
      const initialCount = await sessionItems.count();

      const firstSessionId = await createSessionViaUI(page);
      sessionIds.push(firstSessionId);

      await page.goto('/');
      await page.waitForTimeout(1000);

      await page.waitForFunction(
        (initial) => {
          const items = document.querySelectorAll('button[data-session-id]');
          return items.length > initial;
        },
        initialCount,
        { timeout: 5000 }
      );

      const firstSessionInList = await sessionItems.first().getAttribute('data-session-id');
      expect(firstSessionInList).toBe(firstSessionId);

      const countBeforeSecond = await sessionItems.count();
      const secondSessionId = await createSessionViaUI(page);
      sessionIds.push(secondSessionId);

      await page.goto('/');
      await page.waitForTimeout(1000);

      await page.waitForFunction(
        (beforeCount) => {
          const items = document.querySelectorAll('button[data-session-id]');
          return items.length > beforeCount;
        },
        countBeforeSecond,
        { timeout: 5000 }
      );

      const firstListItemId = await sessionItems.first().getAttribute('data-session-id');
      const secondListItemId = await sessionItems.nth(1).getAttribute('data-session-id');

      expect(firstListItemId).toBe(secondSessionId);
      expect(secondListItemId).toBe(firstSessionId);
    });

    test('should maintain correct order after creating multiple sessions', async ({ page }) => {
      const createdSessionIds: string[] = [];
      const initialCount = await page.locator('button[data-session-id]').count();

      for (let i = 0; i < 3; i++) {
        const sessionId = await createSessionViaUI(page);
        createdSessionIds.push(sessionId);
        sessionIds.push(sessionId);

        await page.goto('/');
        await page.waitForTimeout(1000);

        await page.waitForFunction(
          (initial) => {
            const items = document.querySelectorAll('button[data-session-id]');
            return items.length > initial;
          },
          initialCount + i,
          { timeout: 5000 }
        );
      }

      const sessionItems = page.locator('button[data-session-id]');

      const firstThreeIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const sessionId = await sessionItems.nth(i).getAttribute('data-session-id');
        if (sessionId) firstThreeIds.push(sessionId);
      }

      const expectedOrder = [...createdSessionIds].reverse();

      expect(firstThreeIds).toEqual(expectedOrder);
    });
  });
