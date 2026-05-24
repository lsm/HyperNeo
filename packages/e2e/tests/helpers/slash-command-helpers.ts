/**
 * Slash Command Autocomplete Test Helpers
 *
 * Shared helper functions for slash command autocomplete E2E tests.
 */

import type { Page } from '@playwright/test';
import { createSessionViaUI, waitForWebSocketConnected } from './wait-helpers';

/**
 * Wait for slash commands to be loaded for a session.
 * After session creation, commands are fetched as part of session state.
 * We verify by typing "/" and checking if the autocomplete dropdown appears.
 */
export async function waitForSlashCommandsLoaded(page: Page): Promise<void> {
  const textarea = page.locator('textarea[placeholder*="Ask"]').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });

  // Type "/" to trigger autocomplete
  await textarea.fill('/');

  // Wait for the dropdown to appear (indicates commands are loaded)
  await page.locator('text=Slash Commands').first().waitFor({ state: 'visible', timeout: 10000 });

  // Clear the input
  await textarea.fill('');

  // Small wait for cleanup
  await page.waitForTimeout(300);
}

/**
 * Type in the message input textarea
 */
export async function typeInMessageInput(page: Page, text: string): Promise<void> {
  const textarea = page.locator('textarea[placeholder*="Ask"]').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });
  await textarea.fill(text);
}

/**
 * Get the message input textarea
 */
export function getMessageInput(page: Page) {
  return page.locator('textarea[placeholder*="Ask"]').first();
}

/**
 * Get the command autocomplete dropdown
 */
export function getAutocompleteDropdown(page: Page) {
  return page.locator('text=Slash Commands').locator('..');
}

/**
 * Setup: Go to home page, create session, wait for commands to load
 */
export async function setupSlashCommandSession(page: Page): Promise<string> {
  await page.goto('/');
  await waitForWebSocketConnected(page);

  // Create a new session
  const sessionId = await createSessionViaUI(page);

  // Wait for commands to load
  await waitForSlashCommandsLoaded(page);

  return sessionId;
}
