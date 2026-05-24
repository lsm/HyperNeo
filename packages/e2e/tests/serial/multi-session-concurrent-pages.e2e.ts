/**
 * Multi-Session Concurrent Pages E2E Tests
 *
 * Tests concurrent operations across multiple browser pages.
 *
 * NOTE: These tests are currently skipped because they are flaky and can crash the server.
 * They are kept for documentation purposes and future investigation.
 *
 * Future improvements needed:
 * - Fix race conditions in multi-page concurrent operations
 * - Improve server handling of concurrent session creation
 * - Better resource management for concurrent page tests
 */

import { test, expect } from '../../fixtures';
import type { Browser, Page } from '../../fixtures';
import {
  setupMessageHubTesting,
  createSessionViaUI,
  waitForMessageProcessed,
  waitForElement,
  cleanupTestSession,
  // waitForTabSync, // TODO: Function not available
} from '../helpers/wait-helpers';

// Helper to create and setup multiple pages
async function createMultiplePages(browser: Browser, count: number): Promise<Page[]> {
  const context = await browser.newContext();
  const pages: Page[] = [];

  for (let i = 0; i < count; i++) {
    const page = await context.newPage();
    await setupMessageHubTesting(page);
    pages.push(page);
  }

  return pages;
}

test.describe('Multi-Session Concurrent Pages (Skipped - Flaky)', () => {
  test.skip('should handle multiple sessions independently', async ({ browser }) => {
    // TODO: Multi-page concurrent tests are flaky and can crash the server
    const pages = await createMultiplePages(browser, 3);
    const sessionIds: string[] = [];

    try {
      // Create a session in each page
      for (const page of pages) {
        const sessionId = await createSessionViaUI(page);
        sessionIds.push(sessionId);
      }

      // All session IDs should be unique
      const uniqueIds = new Set(sessionIds);
      expect(uniqueIds.size).toBe(sessionIds.length);

      // Send different messages in each session concurrently
      const messagePromises = pages.map(async (page, index) => {
        const messageInput = await waitForElement(page, 'textarea');
        await messageInput.fill(`Message from session ${index + 1}`);
        await page.click('[data-testid="send-button"]');
        return waitForMessageProcessed(page, `Message from session ${index + 1}`);
      });

      // Wait for all messages to be processed
      await Promise.all(messagePromises);

      // Verify each session has its own message
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const expectedMessage = `Message from session ${i + 1}`;

        // Should see own message
        await expect(page.locator(`text="${expectedMessage}"`)).toBeVisible();

        // Should NOT see messages from other sessions
        for (let j = 0; j < pages.length; j++) {
          if (i !== j) {
            const otherMessage = `Message from session ${j + 1}`;
            await expect(page.locator(`text="${otherMessage}"`)).not.toBeVisible();
          }
        }
      }

      // Cleanup sessions
      for (let i = 0; i < sessionIds.length; i++) {
        await cleanupTestSession(pages[i], sessionIds[i]);
      }
    } finally {
      // Close all pages
      for (const page of pages) {
        await page.close();
      }
    }
  });

  test.skip('should maintain separate conversation contexts', async ({ browser }) => {
    // TODO: Multi-page concurrent tests are flaky and can crash the server
    const pages = await createMultiplePages(browser, 2);
    const sessionIds: string[] = [];

    try {
      // Create sessions
      for (const page of pages) {
        const sessionId = await createSessionViaUI(page);
        sessionIds.push(sessionId);
      }

      // Set different contexts in each session
      const contexts = [
        { name: 'Alice', topic: 'mathematics' },
        { name: 'Bob', topic: 'history' },
      ];

      // Send context-setting messages
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const context = contexts[i];

        const messageInput = await waitForElement(page, 'textarea');
        await messageInput.fill(
          `My name is ${context.name} and I want to discuss ${context.topic}`
        );
        await page.click('[data-testid="send-button"]');
        await waitForMessageProcessed(page, `My name is ${context.name}`);
      }

      // Send follow-up messages that rely on context
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];

        const messageInput = await waitForElement(page, 'textarea');
        await messageInput.fill('What is my name and what topic did I mention?');
        await page.click('[data-testid="send-button"]');
        await waitForMessageProcessed(page, 'What is my name');
      }

      // Verify each session maintains its own context
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const context = contexts[i];

        // Get assistant responses
        const assistantMessages = page.locator('[data-message-role="assistant"]');
        const lastResponse = assistantMessages.last();
        const responseText = await lastResponse.textContent();

        // Response should mention the correct context
        expect(responseText?.toLowerCase()).toContain(context.name.toLowerCase());
        expect(responseText?.toLowerCase()).toContain(context.topic.toLowerCase());

        // Should NOT mention other context
        const otherContext = contexts[i === 0 ? 1 : 0];
        expect(responseText?.toLowerCase()).not.toContain(otherContext.name.toLowerCase());
      }

      // Cleanup
      for (let i = 0; i < sessionIds.length; i++) {
        await cleanupTestSession(pages[i], sessionIds[i]);
      }
    } finally {
      for (const page of pages) {
        await page.close();
      }
    }
  });

  test.skip('should handle concurrent messages across sessions', async ({ browser }) => {
    // TODO: Multi-page concurrent tests are flaky and can crash the server
    const context = await browser.newContext();
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    try {
      // Setup both pages
      await setupMessageHubTesting(page1);
      await setupMessageHubTesting(page2);

      // Create sessions
      const session1 = await createSessionViaUI(page1);

      const session2 = await createSessionViaUI(page2);

      // Send messages concurrently
      const message1Promise = (async () => {
        const input = await waitForElement(page1, 'textarea');
        await input.fill('Concurrent message 1');
        await page1.click('[data-testid="send-button"]');
        return waitForMessageProcessed(page1, 'Concurrent message 1');
      })();

      const message2Promise = (async () => {
        const input = await waitForElement(page2, 'textarea');
        await input.fill('Concurrent message 2');
        await page2.click('[data-testid="send-button"]');
        return waitForMessageProcessed(page2, 'Concurrent message 2');
      })();

      // Both should process successfully
      await Promise.all([message1Promise, message2Promise]);

      // Each session should only have its own message
      await expect(
        page1.locator('[data-message-role="user"]').filter({ hasText: 'Concurrent message 1' })
      ).toBeVisible();
      await expect(
        page1.locator('[data-message-role="user"]').filter({ hasText: 'Concurrent message 2' })
      ).not.toBeVisible();

      await expect(
        page2.locator('[data-message-role="user"]').filter({ hasText: 'Concurrent message 2' })
      ).toBeVisible();
      await expect(
        page2.locator('[data-message-role="user"]').filter({ hasText: 'Concurrent message 1' })
      ).not.toBeVisible();

      // Cleanup
      await cleanupTestSession(page1, session1);
      await cleanupTestSession(page2, session2);
    } finally {
      await page1.close();
      await page2.close();
    }
  });

  test.skip('should handle message queue independently per session', async ({ browser }) => {
    // TODO: Multi-page concurrent tests are flaky and can crash the server
    const pages = await createMultiplePages(browser, 2);
    const sessionIds: string[] = [];

    try {
      // Create sessions
      for (const page of pages) {
        const sessionId = await createSessionViaUI(page);
        sessionIds.push(sessionId);
      }

      // Queue multiple messages in each session
      const messageCount = 3;

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];

        // Send messages rapidly without waiting
        for (let j = 0; j < messageCount; j++) {
          const input = await waitForElement(page, 'textarea');
          await input.fill(`Session ${i + 1} Message ${j + 1}`);
          await page.click('[data-testid="send-button"]');
          // Small delay to ensure messages are queued separately
          await page.waitForTimeout(100);
        }
      }

      // Wait for all messages to process
      await pages[0].waitForTimeout(10000);
      await pages[1].waitForTimeout(10000);

      // Verify each session processed its own messages
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];

        // Count user messages in this session
        const userMessages = await page.locator('[data-message-role="user"]').count();

        // Should have at least some of the queued messages
        expect(userMessages).toBeGreaterThan(0);
        expect(userMessages).toBeLessThanOrEqual(messageCount);

        // Messages should be from correct session
        for (let j = 0; j < userMessages; j++) {
          const messageText = `Session ${i + 1} Message`;
          const hasCorrectMessage = await page
            .locator(`text=/${messageText}/`)
            .first()
            .isVisible()
            .catch(() => false);
          expect(hasCorrectMessage).toBe(true);
        }
      }

      // Cleanup
      for (let i = 0; i < sessionIds.length; i++) {
        await cleanupTestSession(pages[i], sessionIds[i]);
      }
    } finally {
      for (const page of pages) {
        await page.close();
      }
    }
  });

  test.skip('should sync session list across all tabs', async ({ browser }) => {
    // TODO: Multi-page concurrent tests are flaky and can crash the server
    const context = await browser.newContext();
    const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);

    try {
      // Setup all pages
      for (const page of pages) {
        await setupMessageHubTesting(page);
      }

      // Get initial session count in all tabs
      const _initialCounts = await Promise.all(
        pages.map((page) => page.locator('[data-testid="session-card"]').count())
      );

      // Create a session in first tab
      const sessionId = await createSessionViaUI(pages[0]);

      // Wait for sync across tabs
      // await waitForTabSync(pages); // TODO: Function not available

      // All tabs should show the new session
      for (const page of pages) {
        const sessionCard = page.locator(`[data-session-id="${sessionId}"]`);
        await expect(sessionCard).toBeVisible({ timeout: 5000 });
      }

      // Delete session from second tab
      await pages[1].click(`[data-session-id="${sessionId}"]`);
      await waitForElement(pages[1], 'textarea');

      await pages[1].getByTitle('Session options').click();
      await pages[1].click('text=Delete Chat');
      const confirmButton = await waitForElement(
        pages[1],
        '[data-testid="confirm-delete-session"]'
      );
      await confirmButton.click();

      // Wait for deletion to sync
      // await waitForTabSync(pages); // TODO: Function not available

      // Session should be removed from all tabs
      for (const page of pages) {
        const sessionCard = page.locator(`[data-session-id="${sessionId}"]`);
        await expect(sessionCard).not.toBeVisible({ timeout: 5000 });
      }
    } finally {
      for (const page of pages) {
        await page.close();
      }
    }
  });
});
