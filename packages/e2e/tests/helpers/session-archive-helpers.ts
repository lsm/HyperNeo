import type { Page } from '@playwright/test';
import {
  createSessionViaUI,
  waitForWebSocketConnected,
  waitForAssistantResponse,
} from './wait-helpers';

const IS_MOCK = process.env.HYPERNEO_USE_DEV_PROXY === '1';

export async function openSessionOptionsMenu(page: Page): Promise<void> {
  await page.waitForTimeout(500);

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

  const optionsButton = page.getByTitle('Session options');
  await optionsButton.waitFor({ state: 'visible', timeout: 10000 });
  await optionsButton.click();

  await page.waitForTimeout(500);
}

export async function clickArchiveSession(page: Page): Promise<void> {
  const archiveItem = page.locator('text=Archive Session').first();
  await archiveItem.waitFor({ state: 'visible', timeout: 3000 });
  await archiveItem.click();
}

export async function createSessionWithMessage(page: Page): Promise<string> {
  const sessionId = await createSessionViaUI(page);

  const textarea = page.locator('textarea[placeholder*="Ask"]').first();
  await textarea.fill('Hello, say "test message acknowledged"');
  await page.keyboard.press('Meta+Enter');

  await waitForAssistantResponse(page);

  return sessionId;
}

export async function archiveSession(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/${sessionId}`);
  await waitForWebSocketConnected(page);

  await openSessionOptionsMenu(page);
  await clickArchiveSession(page);

  await page.waitForTimeout(IS_MOCK ? 100 : 1500);
}

export async function goToHomePage(page: Page): Promise<void> {
  await page.goto('/');
  await waitForWebSocketConnected(page);

  const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
  if (await chatsButton.isVisible().catch(() => false)) {
    await chatsButton.click();
    await page.waitForTimeout(300);
  }
}

export async function showArchivedSessions(page: Page): Promise<void> {
  const showArchivedButton = page.locator('button:has-text("Show archived")');
  if ((await showArchivedButton.count()) > 0) {
    await showArchivedButton.click();
    await page.waitForTimeout(500);
  }
}

export async function selectSessionInSidebar(page: Page, sessionId: string): Promise<void> {
  await goToHomePage(page);

  const sessionButton = page.locator(`[data-session-id="${sessionId}"]`);
  const isVisible = await sessionButton.isVisible().catch(() => false);

  if (!isVisible) {
    await showArchivedSessions(page);
    await page.waitForTimeout(500);
  }

  await sessionButton.waitFor({ state: 'visible', timeout: 10000 });
  await sessionButton.click();

  await page.waitForTimeout(500);
}
