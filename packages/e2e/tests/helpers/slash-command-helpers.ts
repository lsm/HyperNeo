import type { Page } from '@playwright/test';
import { createSessionViaUI, waitForWebSocketConnected } from './wait-helpers';

export async function waitForSlashCommandsLoaded(page: Page): Promise<void> {
  const textarea = page.locator('textarea[placeholder*="Ask"]').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });

  await textarea.fill('/');

  await page.locator('text=Slash Commands').first().waitFor({ state: 'visible', timeout: 10000 });

  await textarea.fill('');

  await page.waitForTimeout(300);
}

export async function typeInMessageInput(page: Page, text: string): Promise<void> {
  const textarea = page.locator('textarea[placeholder*="Ask"]').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });
  await textarea.fill(text);
}

export function getMessageInput(page: Page) {
  return page.locator('textarea[placeholder*="Ask"]').first();
}

export function getAutocompleteDropdown(page: Page) {
  return page.locator('text=Slash Commands').locator('..');
}

export async function setupSlashCommandSession(page: Page): Promise<string> {
  await page.goto('/');
  await waitForWebSocketConnected(page);

  const sessionId = await createSessionViaUI(page);

  await waitForSlashCommandsLoaded(page);

  return sessionId;
}
