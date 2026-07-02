/**
 * Session Archive Test Helpers
 *
 * Shared helper functions for session archive E2E tests.
 */

import type { Page } from '@playwright/test';
import {
  createSessionViaUI,
  waitForWebSocketConnected,
  waitForAssistantResponse,
} from './wait-helpers';

/**
 * Dev proxy mode detection - when using devproxy, API responses are instant
 * so we can use much shorter timeouts
 */
const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

/**
 * Open the Session options dropdown menu
 */
export async function openSessionOptionsMenu(page: Page): Promise<void> {
  // Wait for the chat header to be fully loaded
  await page.waitForTimeout(500);

  // Dismiss any toast notifications that might be blocking the button
  const dismissButtons = page.locator('button[aria-label="Dismiss notification"]');
  const dismissCount = await dismissButtons.count();
  for (let i = 0; i < dismissCount; i++) {
    try {
      await dismissButtons.nth(i).click({ timeout: 1000 });
    } catch {
      // Ignore if button already dismissed
    }
  }
  await page.waitForTimeout(300);

  // Click the session options button (gear icon in chat header)
  const optionsButton = page.getByTitle('Session options');
  await optionsButton.waitFor({ state: 'visible', timeout: 10000 });
  await optionsButton.click();

  // Wait for menu to appear
  await page.waitForTimeout(500);
}

/**
 * Click Archive Session in the dropdown menu
 */
export async function clickArchiveSession(page: Page): Promise<void> {
  const archiveItem = page.locator('text=Archive Session').first();
  await archiveItem.waitFor({ state: 'visible', timeout: 3000 });
  await archiveItem.click();
}

/**
 * Create a session with a message to have content.
 * Works in both real API and devproxy (mock) modes - devproxy automatically
 * returns mock responses, so we just wait for any assistant message.
 */
export async function createSessionWithMessage(page: Page): Promise<string> {
  // Create new session
  const sessionId = await createSessionViaUI(page);

  // Send a simple message
  const textarea = page.locator('textarea[placeholder*="Ask"]').first();
  await textarea.fill('Hello, say "test message acknowledged"');
  await page.keyboard.press('Meta+Enter');

  // Wait for response
  await waitForAssistantResponse(page);

  return sessionId;
}

/**
 * Archive a given session
 */
export async function archiveSession(page: Page, sessionId: string): Promise<void> {
  // Navigate to the session
  await page.goto(`/${sessionId}`);
  await waitForWebSocketConnected(page);

  // Archive the session
  await openSessionOptionsMenu(page);
  await clickArchiveSession(page);

  // Wait for archive to complete
  await page.waitForTimeout(IS_MOCK ? 100 : 1500);
}

/**
 * Navigate to home page and wait for WebSocket connection.
 * Clicks "Chats" in NavRail to ensure the session list is visible.
 */
export async function goToHomePage(page: Page): Promise<void> {
  await page.goto('/');
  await waitForWebSocketConnected(page);

  // Click Chats in NavRail to show session list
  const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
  if (await chatsButton.isVisible().catch(() => false)) {
    await chatsButton.click();
    await page.waitForTimeout(300);
  }
}

/**
 * Click the "Show archived" button to show archived sessions
 */
export async function showArchivedSessions(page: Page): Promise<void> {
  const showArchivedButton = page.locator('button:has-text("Show archived")');
  if ((await showArchivedButton.count()) > 0) {
    await showArchivedButton.click();
    await page.waitForTimeout(500);
  }
}

/**
 * Click on a session in the sidebar to select it
 * Useful after archiving when the session view might have changed
 * Navigates home first to ensure the Chats panel is in a clean state,
 * then shows archived sessions if needed.
 */
export async function selectSessionInSidebar(page: Page, sessionId: string): Promise<void> {
  // Navigate home to get into a known state with the Chats panel open.
  // After archiving, the app redirects to the home page. Navigating home first
  // ensures the Chats panel is in a clean state before selecting the session.
  await goToHomePage(page);

  // Check if session is visible (archived sessions are hidden when showArchived=false)
  const sessionButton = page.locator(`[data-session-id="${sessionId}"]`);
  const isVisible = await sessionButton.isVisible().catch(() => false);

  // If not visible, enable the "Show archived" toggle so archived sessions appear
  if (!isVisible) {
    await showArchivedSessions(page);
    await page.waitForTimeout(500);
  }

  // Wait for the session to appear in the sidebar
  await sessionButton.waitFor({ state: 'visible', timeout: 10000 });
  await sessionButton.click();

  // Wait for the session to load
  await page.waitForTimeout(500);
}
