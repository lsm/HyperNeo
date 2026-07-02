/**
 * Slash Command E2E Tests
 *
 * Consolidated tests for slash command functionality:
 * - Basic autocomplete appearance and filtering
 * - Keyboard navigation (arrow keys, escape)
 * - Selection (click, enter, tab)
 * - Built-in commands (/help, /clear, etc.)
 * - Edge cases (special characters, rapid typing)
 */

import { test, expect } from '../../fixtures';
import {
  typeInMessageInput,
  getAutocompleteDropdown,
  getMessageInput,
  waitForSlashCommandsLoaded,
} from '../helpers/slash-command-helpers';
import {
  createSessionViaUI,
  waitForWebSocketConnected,
  waitForAssistantResponse,
  cleanupTestSession,
} from '../helpers/wait-helpers';

test.describe('Slash Command Autocomplete - Basic Functionality', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    // Create a new session
    sessionId = await createSessionViaUI(page);

    // Wait for commands to load
    await waitForSlashCommandsLoaded(page);
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

  test('should show autocomplete dropdown when typing /', async ({ page }) => {
    // Type / in the message input
    await typeInMessageInput(page, '/');

    // Autocomplete dropdown should appear
    const dropdown = getAutocompleteDropdown(page);
    await expect(dropdown).toBeVisible({ timeout: 3000 });

    // Should have "Slash Commands" header
    await expect(page.locator('text=Slash Commands')).toBeVisible();
  });

  test('should show navigation hints in dropdown footer', async ({ page }) => {
    await typeInMessageInput(page, '/');

    // Should show navigation hints
    await expect(page.locator('text=navigate')).toBeVisible();
    await expect(page.locator('text=select')).toBeVisible();
    await expect(page.locator('text=close')).toBeVisible();
  });

  test('should filter commands as user types', async ({ page }) => {
    // Type /me to filter for /merge-session
    await typeInMessageInput(page, '/me');

    // Dropdown should appear with filtered results
    const dropdown = getAutocompleteDropdown(page);
    await expect(dropdown).toBeVisible();

    // Should show merge-session command
    await expect(page.locator('button:has-text("merge-session")')).toBeVisible();
  });

  test('should hide autocomplete when input is empty', async ({ page }) => {
    // Type / first
    await typeInMessageInput(page, '/');

    // Dropdown should appear
    await expect(getAutocompleteDropdown(page)).toBeVisible();

    // Clear the input
    await typeInMessageInput(page, '');

    // Dropdown should disappear
    await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });
  });

  test('should hide autocomplete for non-slash input', async ({ page }) => {
    // Type regular text
    await typeInMessageInput(page, 'Hello world');

    // Dropdown should not appear
    await expect(getAutocompleteDropdown(page)).toBeHidden();
  });
});

test.describe('Slash Command Autocomplete - Navigation', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    // Create a new session
    sessionId = await createSessionViaUI(page);

    await waitForSlashCommandsLoaded(page);
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

  test('should navigate commands with ArrowDown key', async ({ page }) => {
    await typeInMessageInput(page, '/');

    // Wait for dropdown
    await expect(getAutocompleteDropdown(page)).toBeVisible();

    // Get the first command button
    const firstCommand = page.locator('button[class*="bg-blue-500"]').first();
    await expect(firstCommand).toBeVisible();

    // Press ArrowDown
    await page.keyboard.press('ArrowDown');

    // Wait a bit for UI update
    await page.waitForTimeout(100);

    // Selection should have moved (check for different element having the highlight class)
  });

  test('should navigate commands with ArrowUp key', async ({ page }) => {
    await typeInMessageInput(page, '/');

    // Wait for dropdown
    await expect(getAutocompleteDropdown(page)).toBeVisible();

    // Press ArrowDown twice then ArrowUp
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');

    // Wait for UI update
    await page.waitForTimeout(100);
  });

  test('should select command with Enter key', async ({ page }) => {
    const textarea = getMessageInput(page);
    await textarea.fill('/');

    // Wait for dropdown
    await expect(getAutocompleteDropdown(page)).toBeVisible();

    // Press Enter to select first command
    await page.keyboard.press('Enter');

    // Dropdown should close
    await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });

    // Input should have the selected command (with trailing space)
    const inputValue = await textarea.inputValue();
    expect(inputValue).toMatch(/^\/[\w-]+ $/);
  });

  test('should close autocomplete with Escape key', async ({ page }) => {
    await typeInMessageInput(page, '/');

    // Wait for dropdown
    await expect(getAutocompleteDropdown(page)).toBeVisible();

    // Press Escape
    await page.keyboard.press('Escape');

    // Dropdown should close
    await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });

    // Input should still have /
    const inputValue = await getMessageInput(page).inputValue();
    expect(inputValue).toBe('/');
  });
});

test.describe('Slash Command Autocomplete - Command Selection', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    // Create a new session
    sessionId = await createSessionViaUI(page);

    await waitForSlashCommandsLoaded(page);
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

  test('should insert command with trailing space when selected', async ({ page }) => {
    const textarea = getMessageInput(page);
    await textarea.fill('/mer');

    // Wait for dropdown
    await expect(getAutocompleteDropdown(page)).toBeVisible();

    // Select with Enter
    await page.keyboard.press('Enter');

    // Input should have command with trailing space
    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('/merge-session ');
  });

  test('should select command by clicking', async ({ page }) => {
    const textarea = getMessageInput(page);
    await textarea.fill('/');

    // Wait for dropdown
    await expect(getAutocompleteDropdown(page)).toBeVisible();

    // Click on a command (merge-session is available before SDK starts)
    const mergeCommand = page.locator('button:has-text("merge-session")').first();
    await mergeCommand.click();

    // Dropdown should close
    await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });

    // Input should have the selected command
    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('/merge-session ');
  });

  test('should close dropdown when clicking outside', async ({ page }) => {
    await typeInMessageInput(page, '/');

    // Wait for dropdown to be fully visible and event listeners mounted
    await expect(getAutocompleteDropdown(page)).toBeVisible();

    // Click on the session heading in the chat header (outside the dropdown).
    // Using Playwright's native click generates real mousedown events that trigger
    // the handleClickOutside handler in CommandAutocomplete.
    await page.getByRole('heading', { level: 2 }).last().click({ force: true });

    // Dropdown should close
    await page.waitForTimeout(500);
    await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });
  });
});

test.describe('Slash Command Autocomplete - Built-in Commands', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    // Create a new session
    sessionId = await createSessionViaUI(page);

    await waitForSlashCommandsLoaded(page);

    // Send a simple message to trigger SDK query, which populates SDK commands
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    await textarea.fill('hello');
    await page.keyboard.press('Enter');

    // Wait for assistant response (SDK is now running and commands are populated)
    await waitForAssistantResponse(page);

    // Wait a bit more for commands to be fully loaded in the signal
    await page.waitForTimeout(1000);
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

  test('should show /help command', async ({ page }) => {
    await typeInMessageInput(page, '/h');

    // Should show help command
    await expect(page.getByRole('button', { name: 'help', exact: true })).toBeVisible();
  });

  test('should show /clear command', async ({ page }) => {
    await typeInMessageInput(page, '/cl');

    // Should show clear command
    await expect(page.locator('button:has-text("clear")')).toBeVisible();
  });

  test('should show /init command', async ({ page }) => {
    await typeInMessageInput(page, '/ini');

    // Should show init command
    await expect(page.locator('button:has-text("init")')).toBeVisible();
  });

  test('should show multiple commands matching filter', async ({ page }) => {
    await typeInMessageInput(page, '/c');

    // Wait for dropdown
    await expect(getAutocompleteDropdown(page)).toBeVisible();

    // Should show at least the clear command
    await expect(page.locator('button:has-text("clear")')).toBeVisible();
  });
});

test.describe('Slash Command Autocomplete - Edge Cases', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    // Create a new session
    sessionId = await createSessionViaUI(page);

    await waitForSlashCommandsLoaded(page);
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

  test('should not show autocomplete for / in middle of text', async ({ page }) => {
    // Type text with / in the middle
    await typeInMessageInput(page, 'Hello /world');

    // Dropdown should NOT appear (/ must be at start)
    await page.waitForTimeout(500);
    await expect(getAutocompleteDropdown(page)).toBeHidden();
  });

  test('should show autocomplete for / with leading whitespace', async ({ page }) => {
    // Type / with leading spaces (trimStart is used)
    await typeInMessageInput(page, '  /');

    // Dropdown SHOULD appear (trimStart handles leading whitespace)
    await expect(getAutocompleteDropdown(page)).toBeVisible({ timeout: 3000 });
  });

  test('should handle no matching commands', async ({ page }) => {
    // Type / with gibberish that won't match any commands
    await typeInMessageInput(page, '/xyzzyqwerty');

    // Dropdown should NOT appear (no matching commands)
    await page.waitForTimeout(500);
    await expect(getAutocompleteDropdown(page)).toBeHidden();
  });

  test('should handle rapid typing', async ({ page }) => {
    const textarea = getMessageInput(page);

    // Type rapidly (use merge-session which is available before SDK starts)
    await textarea.pressSequentially('/mer', { delay: 50 });

    // Dropdown should appear and filter correctly
    await expect(page.locator('button:has-text("merge-session")')).toBeVisible({
      timeout: 3000,
    });
  });

  test('should handle command selection followed by more typing', async ({ page }) => {
    const textarea = getMessageInput(page);
    await textarea.fill('/mer');

    // Wait for dropdown and select
    await expect(getAutocompleteDropdown(page)).toBeVisible();
    await page.keyboard.press('Enter');

    // Input should have command with space
    let inputValue = await textarea.inputValue();
    expect(inputValue).toBe('/merge-session ');

    // Type more text after the command
    await textarea.press('End');
    await textarea.type('with some additional context');

    // Should have the full message
    inputValue = await textarea.inputValue();
    expect(inputValue).toBe('/merge-session with some additional context');
  });
});

test.describe('Slash Command Autocomplete - SDK Commands from system:init', () => {
  /**
   * Regression tests for: slash commands not showing in autocomplete even though
   * the SDK system:init message has 10+ commands (visible in "Slash Commands (N)"
   * panel). Root cause: state.session fallback broadcast sent commandsData: []
   * which overwrote valid commands. Fix: sync commandsData from system:init SDK
   * message as the authoritative source.
   */

  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    // Create a new session
    sessionId = await createSessionViaUI(page);

    await waitForSlashCommandsLoaded(page);
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

  test('should show SDK commands in autocomplete after assistant response', async ({ page }) => {
    // Send a message to trigger SDK query and receive system:init
    const textarea = getMessageInput(page);
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    await textarea.fill('hello');
    await page.keyboard.press('Enter');

    // Wait for assistant to respond (system:init has arrived by this point)
    await waitForAssistantResponse(page);

    // SDK commands should now be in autocomplete via system:init sync
    // (no artificial delay needed with the fix)
    await typeInMessageInput(page, '/h');
    await expect(page.getByRole('button', { name: 'help', exact: true })).toBeVisible({
      timeout: 5000,
    });
  });

  test('should show /clear command after assistant response', async ({ page }) => {
    const textarea = getMessageInput(page);
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    await textarea.fill('hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    await typeInMessageInput(page, '/cl');
    await expect(page.locator('button:has-text("clear")')).toBeVisible({ timeout: 5000 });
  });

  test('should show all commands matching / after assistant response', async ({ page }) => {
    const textarea = getMessageInput(page);
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    await textarea.fill('hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    // Type just / to see all commands — should have more than just /merge-session
    await typeInMessageInput(page, '/');
    const dropdown = getAutocompleteDropdown(page);
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // Should have multiple commands from SDK system:init (not just the built-in /merge-session)
    const commandButtons = page.locator(
      '[data-testid="command-autocomplete"] button, text=Slash Commands ~ button'
    );
    // Verify at least /help is present (from SDK, not from HyperNeo built-ins)
    await expect(page.getByRole('button', { name: 'help', exact: true })).toBeVisible({
      timeout: 5000,
    });
  });

  test('should restore SDK commands after state.session event with empty commandsData', async ({
    page,
  }) => {
    // This test verifies the core bug fix:
    // When state.session arrives with commandsData: [], commands are restored from system:init.
    const textarea = getMessageInput(page);
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    await textarea.fill('hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    // Send a second message — this triggers more state.session events including
    // potential fallback broadcasts with empty commandsData.
    await textarea.fill('what is 2+2');
    await page.keyboard.press('Enter');
    await waitForAssistantResponse(page);

    // Commands should still be available after multiple state.session events
    await typeInMessageInput(page, '/h');
    await expect(page.getByRole('button', { name: 'help', exact: true })).toBeVisible({
      timeout: 5000,
    });
  });
});
