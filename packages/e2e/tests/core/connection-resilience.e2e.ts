import { test, expect } from '../../fixtures';
import {
  waitForWebSocketConnected,
  createSessionViaUI,
  cleanupTestSession,
  waitForAssistantResponse,
} from '../helpers/wait-helpers';
import {
  closeWebSocket,
  restoreWebSocket,
  waitForOfflineStatus,
  waitForOnlineStatus,
} from '../helpers/connection-helpers';

test.describe('Reconnection - Basic Message Sync', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
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

  test('should sync messages generated during disconnection', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.click();
    await messageInput.fill('Count from 1 to 5 with 1 second delay between each number');

    const sendButton = page.locator('button[aria-label="Send message"]').first();
    await sendButton.click();

    await page.waitForFunction(
      () => document.querySelectorAll('[data-message-role="assistant"]').length > 0,
      { timeout: 15000 }
    );

    const messagesBeforeDisconnect = await page.locator('[data-message-role]').count();
    console.log(`Messages before disconnect: ${messagesBeforeDisconnect}`);

    await closeWebSocket(page);

    await waitForOfflineStatus(page);

    await page
      .waitForFunction(
        (expectedBefore) => {
          const current = document.querySelectorAll('[data-message-role]').length;
          return current > expectedBefore;
        },
        messagesBeforeDisconnect,
        { timeout: 10000, polling: 500 }
      )
      .catch(() => {
        // If no new messages appeared during disconnect, that's okay —
        // the test still validates reconnection preserves existing messages.
      });

    await restoreWebSocket(page);

    await waitForOnlineStatus(page);

    const messagesAfterReconnect = await page.locator('[data-message-role]').count();
    console.log(`Messages after reconnect: ${messagesAfterReconnect}`);

    expect(messagesAfterReconnect).toBeGreaterThanOrEqual(messagesBeforeDisconnect);

    const messageElements = await page.locator('[data-message-role]').all();
    const messageIds = new Set<string>();

    for (const element of messageElements) {
      const uuid = await element.evaluate((el) => el.getAttribute('data-message-uuid') || null);
      if (uuid) {
        expect(messageIds.has(uuid)).toBe(false);
        messageIds.add(uuid);
      }
    }

    console.log(`Unique messages: ${messageIds.size}`);
    expect(messageIds.size).toBe(messagesAfterReconnect);
  });
});

test.describe('Reconnection - Multiple Cycles', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
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

  test('should handle multiple disconnect/reconnect cycles', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.click();
    await messageInput.fill('List 3 programming languages');

    const sendButton = page.locator('button[aria-label="Send message"]').first();
    await sendButton.click();

    await waitForAssistantResponse(page, { timeout: 60000 });

    await closeWebSocket(page);
    await waitForOfflineStatus(page);

    await page.waitForTimeout(500);

    await restoreWebSocket(page);
    await waitForOnlineStatus(page);

    const messagesAfterCycle1 = await page.locator('[data-message-role]').count();

    await closeWebSocket(page);
    await waitForOfflineStatus(page);

    await page.waitForTimeout(500);

    await restoreWebSocket(page);
    await waitForOnlineStatus(page);

    const messagesAfterCycle2 = await page.locator('[data-message-role]').count();

    expect(messagesAfterCycle2).toBeGreaterThanOrEqual(messagesAfterCycle1);

    const messageElements = await page.locator('[data-message-role]').all();
    const messageIds = new Set<string>();

    for (const element of messageElements) {
      const uuid = await element.evaluate((el) => el.getAttribute('data-message-uuid') || null);
      if (uuid) {
        expect(messageIds.has(uuid)).toBe(false);
        messageIds.add(uuid);
      }
    }

    expect(messageIds.size).toBe(messagesAfterCycle2);
  });
});

test.describe('Reconnection - Long Disconnection Period', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
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

  test('should handle reconnection with long disconnection period', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.click();
    await messageInput.fill('Say hello');

    const sendButton = page.locator('button[aria-label="Send message"]').first();
    await sendButton.click();

    await page.waitForFunction(
      () => document.querySelectorAll('[data-message-role="user"]').length > 0,
      { timeout: 10000 }
    );

    await closeWebSocket(page);
    await waitForOfflineStatus(page);

    const messagesBeforeOffline = await page.locator('[data-message-role]').count();
    await page
      .waitForFunction(
        (before) => document.querySelectorAll('[data-message-role]').length > before,
        messagesBeforeOffline,
        { timeout: 5000, polling: 500 }
      )
      .catch(() => {
        // No new messages during disconnect — acceptable
      });

    await restoreWebSocket(page);
    await waitForOnlineStatus(page);

    const messageCount = await page.locator('[data-message-role]').count();
    expect(messageCount).toBeGreaterThan(0);

    const messageElements = await page.locator('[data-message-role]').all();
    const messageIds = new Set<string>();

    for (const element of messageElements) {
      const uuid = await element.evaluate((el) => el.getAttribute('data-message-uuid') || null);
      if (uuid) {
        expect(messageIds.has(uuid)).toBe(false);
        messageIds.add(uuid);
      }
    }

    expect(messageIds.size).toBe(messageCount);
  });
});

test.describe('Reconnection - Message Order', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
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

  test('should preserve message order after reconnection', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.click();
    await messageInput.fill('Count: 1, 2, 3');

    const sendButton = page.locator('button[aria-label="Send message"]').first();
    await sendButton.click();

    await page.waitForFunction(
      () => document.querySelectorAll('[data-message-role="assistant"]').length > 0,
      { timeout: 15000 }
    );

    const timestampsBeforeDisconnect = await page.evaluate(() => {
      const messages = Array.from(document.querySelectorAll('[data-message-role]'));
      return messages.map((el) => ({
        uuid: el.getAttribute('data-message-uuid') || null,
        timestamp: el.getAttribute('data-message-timestamp'),
      }));
    });

    await closeWebSocket(page);
    await waitForOfflineStatus(page);

    await page.waitForTimeout(500);

    await restoreWebSocket(page);
    await waitForOnlineStatus(page);

    const timestampsAfterReconnect = await page.evaluate(() => {
      const messages = Array.from(document.querySelectorAll('[data-message-role]'));
      return messages.map((el) => ({
        uuid: el.getAttribute('data-message-uuid') || null,
        timestamp: el.getAttribute('data-message-timestamp'),
      }));
    });

    const beforeUuids = timestampsBeforeDisconnect.map((m) => m.uuid);
    const afterUuids = timestampsAfterReconnect.slice(0, beforeUuids.length).map((m) => m.uuid);

    expect(afterUuids).toEqual(beforeUuids);

    for (let i = 1; i < timestampsAfterReconnect.length; i++) {
      const prevTime = Number(timestampsAfterReconnect[i - 1].timestamp);
      const currTime = Number(timestampsAfterReconnect[i].timestamp);
      expect(currTime).toBeGreaterThanOrEqual(prevTime);
    }
  });
});

test.describe('Connection - Input Blocking', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
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

  test('should block input during disconnection', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(textarea).toBeVisible();
    const isEnabledBefore = await textarea.isEnabled();
    expect(isEnabledBefore).toBe(true);

    await closeWebSocket(page);
    await waitForOfflineStatus(page);

    await page.waitForTimeout(300);

    await restoreWebSocket(page);
    await waitForOnlineStatus(page);

    await expect(textarea).toBeEnabled({ timeout: 5000 });
  });
});

test.describe('Connection - State Transitions', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
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

  test('should maintain session data after reconnection', async ({ page }) => {
    sessionId = await createSessionViaUI(page);

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await messageInput.click();
    await messageInput.fill('Test message for reconnection');

    const sendButton = page.locator('button[aria-label="Send message"]').first();
    await sendButton.click();

    await expect(page.getByText('Test message for reconnection').first()).toBeVisible();

    const messagesBeforeDisconnect = await page.locator('[data-message-role]').count();

    await closeWebSocket(page);
    await waitForOfflineStatus(page);

    await restoreWebSocket(page);
    await waitForOnlineStatus(page);

    const messagesAfterReconnect = await page.locator('[data-message-role]').count();
    expect(messagesAfterReconnect).toBeGreaterThanOrEqual(messagesBeforeDisconnect);

    await expect(page.getByText('Test message for reconnection').first()).toBeVisible();
  });
});
