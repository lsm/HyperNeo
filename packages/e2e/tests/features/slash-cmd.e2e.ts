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

  test('should show autocomplete dropdown when typing /', async ({ page }) => {
    await typeInMessageInput(page, '/');

    const dropdown = getAutocompleteDropdown(page);
    await expect(dropdown).toBeVisible({ timeout: 3000 });

    await expect(page.locator('text=Slash Commands')).toBeVisible();
  });

  test('should show navigation hints in dropdown footer', async ({ page }) => {
    await typeInMessageInput(page, '/');

    await expect(page.locator('text=navigate')).toBeVisible();
    await expect(page.locator('text=select')).toBeVisible();
    await expect(page.locator('text=close')).toBeVisible();
  });

  test('should filter commands as user types', async ({ page }) => {
    await typeInMessageInput(page, '/me');

    const dropdown = getAutocompleteDropdown(page);
    await expect(dropdown).toBeVisible();

    await expect(page.locator('button:has-text("merge-session")')).toBeVisible();
  });

  test('should hide autocomplete when input is empty', async ({ page }) => {
    await typeInMessageInput(page, '/');

    await expect(getAutocompleteDropdown(page)).toBeVisible();

    await typeInMessageInput(page, '');

    await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });
  });

  test('should hide autocomplete for non-slash input', async ({ page }) => {
    await typeInMessageInput(page, 'Hello world');

    await expect(getAutocompleteDropdown(page)).toBeHidden();
  });
});

test.describe('Slash Command Autocomplete - Navigation', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

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

    await expect(getAutocompleteDropdown(page)).toBeVisible();

    const firstCommand = page.locator('button[class*="bg-blue-500"]').first();
    await expect(firstCommand).toBeVisible();

    await page.keyboard.press('ArrowDown');

    await page.waitForTimeout(100);
  });

  test('should navigate commands with ArrowUp key', async ({ page }) => {
    await typeInMessageInput(page, '/');

    await expect(getAutocompleteDropdown(page)).toBeVisible();

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');

    await page.waitForTimeout(100);
  });

  test('should select command with Enter key', async ({ page }) => {
    const textarea = getMessageInput(page);
    await textarea.fill('/');

    await expect(getAutocompleteDropdown(page)).toBeVisible();

    await page.keyboard.press('Enter');

    await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });

    const inputValue = await textarea.inputValue();
    expect(inputValue).toMatch(/^\/[\w-]+ $/);
  });

  test('should close autocomplete with Escape key', async ({ page }) => {
    await typeInMessageInput(page, '/');

    await expect(getAutocompleteDropdown(page)).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });

    const inputValue = await getMessageInput(page).inputValue();
    expect(inputValue).toBe('/');
  });
});

test.describe('Slash Command Autocomplete - Command Selection', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

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

    await expect(getAutocompleteDropdown(page)).toBeVisible();

    await page.keyboard.press('Enter');

    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('/merge-session ');
  });

  test('should select command by clicking', async ({ page }) => {
    const textarea = getMessageInput(page);
    await textarea.fill('/');

    await expect(getAutocompleteDropdown(page)).toBeVisible();

    const mergeCommand = page.locator('button:has-text("merge-session")').first();
    await mergeCommand.click();

    await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });

    const inputValue = await textarea.inputValue();
    expect(inputValue).toBe('/merge-session ');
  });

  test('should close dropdown when clicking outside', async ({ page }) => {
    await typeInMessageInput(page, '/');

    await expect(getAutocompleteDropdown(page)).toBeVisible();

    await page.getByRole('heading', { level: 2 }).last().click({ force: true });

    await page.waitForTimeout(500);
    await expect(getAutocompleteDropdown(page)).toBeHidden({ timeout: 2000 });
  });
});

test.describe('Slash Command Autocomplete - Built-in Commands', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    sessionId = await createSessionViaUI(page);

    await waitForSlashCommandsLoaded(page);

    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    await textarea.fill('hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

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

    await expect(page.getByRole('button', { name: 'help', exact: true })).toBeVisible();
  });

  test('should show /clear command', async ({ page }) => {
    await typeInMessageInput(page, '/cl');

    await expect(page.locator('button:has-text("clear")')).toBeVisible();
  });

  test('should show /init command', async ({ page }) => {
    await typeInMessageInput(page, '/ini');

    await expect(page.locator('button:has-text("init")')).toBeVisible();
  });

  test('should show multiple commands matching filter', async ({ page }) => {
    await typeInMessageInput(page, '/c');

    await expect(getAutocompleteDropdown(page)).toBeVisible();

    await expect(page.locator('button:has-text("clear")')).toBeVisible();
  });
});

test.describe('Slash Command Autocomplete - Edge Cases', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

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
    await typeInMessageInput(page, 'Hello /world');

    await page.waitForTimeout(500);
    await expect(getAutocompleteDropdown(page)).toBeHidden();
  });

  test('should show autocomplete for / with leading whitespace', async ({ page }) => {
    await typeInMessageInput(page, '  /');

    await expect(getAutocompleteDropdown(page)).toBeVisible({ timeout: 3000 });
  });

  test('should handle no matching commands', async ({ page }) => {
    await typeInMessageInput(page, '/xyzzyqwerty');

    await page.waitForTimeout(500);
    await expect(getAutocompleteDropdown(page)).toBeHidden();
  });

  test('should handle rapid typing', async ({ page }) => {
    const textarea = getMessageInput(page);

    await textarea.pressSequentially('/mer', { delay: 50 });

    await expect(page.locator('button:has-text("merge-session")')).toBeVisible({
      timeout: 3000,
    });
  });

  test('should handle command selection followed by more typing', async ({ page }) => {
    const textarea = getMessageInput(page);
    await textarea.fill('/mer');

    await expect(getAutocompleteDropdown(page)).toBeVisible();
    await page.keyboard.press('Enter');

    let inputValue = await textarea.inputValue();
    expect(inputValue).toBe('/merge-session ');

    await textarea.press('End');
    await textarea.type('with some additional context');

    inputValue = await textarea.inputValue();
    expect(inputValue).toBe('/merge-session with some additional context');
  });
});

test.describe('Slash Command Autocomplete - SDK Commands from system:init', () => {
  let sessionId: string | null = null;

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

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
    const textarea = getMessageInput(page);
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    await textarea.fill('hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

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

    await typeInMessageInput(page, '/');
    const dropdown = getAutocompleteDropdown(page);
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    const commandButtons = page.locator(
      '[data-testid="command-autocomplete"] button, text=Slash Commands ~ button'
    );
    await expect(page.getByRole('button', { name: 'help', exact: true })).toBeVisible({
      timeout: 5000,
    });
  });

  test('should restore SDK commands after state.session event with empty commandsData', async ({
    page,
  }) => {
    const textarea = getMessageInput(page);
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    await textarea.fill('hello');
    await page.keyboard.press('Enter');

    await waitForAssistantResponse(page);

    await textarea.fill('what is 2+2');
    await page.keyboard.press('Enter');
    await waitForAssistantResponse(page);

    await typeInMessageInput(page, '/h');
    await expect(page.getByRole('button', { name: 'help', exact: true })).toBeVisible({
      timeout: 5000,
    });
  });
});
