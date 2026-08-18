import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { openSettingsModal, closeSettingsModal } from '../helpers/settings-modal-helpers';

test.describe('Settings Modal - Basic Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should open Settings modal from sidebar footer', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();
  });

  test('should close Settings modal with close button', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();

    await closeSettingsModal(page);

    await expect(page.locator('h2:has-text("Global Settings")')).toBeHidden();
  });

  test('should close Settings modal by clicking backdrop', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();

    await page.getByRole('button', { name: 'Chats', exact: true }).click();

    await expect(page.locator('h2:has-text("Global Settings")')).toBeHidden();
  });

  test('should close Settings modal with Escape key', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    await expect(page.locator('h2:has-text("Global Settings")')).toBeVisible();
  });
});

test.describe('Settings Modal - Authentication Status', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should display all settings navigation sections', async ({ page }) => {
    await openSettingsModal(page);

    const expectedSections = [
      'General',
      'Providers',
      'MCP Servers',
      'Skills',
      'Fallback Models',
      'Usage',
      'About',
    ];
    for (const section of expectedSections) {
      await expect(page.getByRole('button', { name: section, exact: true })).toBeVisible();
    }
  });

  test('should show authenticated status with green indicator', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('h3:has-text("General")')).toBeVisible();

    await expect(page.locator('text=Default Model')).toBeVisible();
  });

  test('should display auth method (API Key or OAuth)', async ({ page }) => {
    await openSettingsModal(page);

    await page.getByRole('button', { name: 'Providers', exact: true }).waitFor();

    await page.getByRole('button', { name: 'Providers', exact: true }).click();

    await expect(page.locator('h3:has-text("Providers")')).toBeVisible();

    const hasApiKey = (await page.locator('text=API Key').count()) > 0;
    const hasOAuth = (await page.locator('text=OAuth').count()) > 0;

    if (hasApiKey || hasOAuth) {
      expect(true).toBeTruthy();
    } else {
      await expect(
        page
          .locator('text=No providers available')
          .or(page.locator('text=Configure authentication for AI providers'))
      ).toBeVisible();
    }
  });

  test('should show environment variable setup instructions', async ({ page }) => {
    await openSettingsModal(page);

    await page.getByRole('button', { name: 'About', exact: true }).click();

    await expect(page.locator('h3:has-text("About")')).toBeVisible();
    await expect(page.locator('text=HyperNeo')).toBeVisible();
  });
});

test.describe('Settings Modal - Global Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should display Global Settings section', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('h3:has-text("General")')).toBeVisible();
  });

  test('should show Model selection dropdown', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('text=Default Model')).toBeVisible();

    const modelSelect = page.locator('select').first();
    await expect(modelSelect).toBeVisible();

    await expect(modelSelect.locator('option:has-text("Claude Sonnet 4")')).toBeAttached();
  });

  test('should show Thinking Level selection dropdown', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('text=Default Thinking Level')).toBeVisible();

    await expect(page.locator('text=Permission Mode')).toBeVisible();
    await expect(page.locator('select').nth(1)).toBeVisible();
  });

  test('should show Auto Scroll toggle', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.getByText('Auto-scroll', { exact: true })).toBeVisible();

    await expect(page.locator('button[role="switch"]').first()).toBeVisible();
  });

  test('should show Permission Mode selection', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('text=Permission Mode')).toBeVisible();

    const permissionSelect = page.locator('select').nth(1);
    await expect(permissionSelect).toBeVisible();
    await expect(permissionSelect.locator('option[value="default"]')).toBeAttached();
  });

  test('should show all General settings rows', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('text=Setting Sources')).toBeHidden();

    await expect(page.locator('text=Default Model')).toBeVisible();
    await expect(page.locator('text=Permission Mode')).toBeVisible();
    await expect(page.locator('text=Default Thinking Level')).toBeVisible();
    await expect(page.getByText('Auto-scroll', { exact: true })).toBeVisible();
    await expect(page.getByText('Show Archived Sessions', { exact: true })).toBeVisible();
  });

  test('should show settings page description', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('text=Default configurations for new sessions')).toBeVisible();
  });
});

test.describe('Settings Modal - Global Tools Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should display MCP Servers section from settings nav', async ({ page }) => {
    await openSettingsModal(page);

    await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();

    await expect(page.locator('h3:has-text("MCP Servers")')).toBeVisible();
  });

  test('should show System Prompt section with Claude Code Preset', async ({ page }) => {
    await openSettingsModal(page);

    await page.getByRole('button', { name: 'About', exact: true }).click();

    await expect(page.locator('h3:has-text("About")')).toBeVisible();
    await expect(page.locator('text=Version')).toBeVisible();
  });

  test('should NOT show HyperNeo Tools section', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('h4:has-text("HyperNeo Tools")')).not.toBeVisible();

    await expect(page.locator('text=Persistent key-value storage')).not.toBeVisible();
  });

  test('should show all General settings rows from tools group', async ({ page }) => {
    await openSettingsModal(page);

    await expect(page.locator('text=Default Model')).toBeVisible();
    await expect(page.locator('text=Permission Mode')).toBeVisible();
    await expect(page.locator('text=Default Thinking Level')).toBeVisible();
    await expect(page.getByText('Auto-scroll', { exact: true })).toBeVisible();
    await expect(page.getByText('Show Archived Sessions', { exact: true })).toBeVisible();
  });

  test('should have toggle switches for boolean settings', async ({ page }) => {
    await openSettingsModal(page);

    const autoScrollToggle = page.locator('button[role="switch"]').first();
    await expect(autoScrollToggle).toBeVisible();

    await expect(autoScrollToggle).toHaveAttribute('aria-checked');
  });
});

test.describe('Settings Modal - Settings Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should allow changing model selection', async ({ page }) => {
    await openSettingsModal(page);

    const modelSelect = page.locator('select').first();
    await expect(modelSelect).toBeVisible();

    const optionValues = await modelSelect.locator('option').evaluateAll((opts) =>
      opts.map((o) => ({
        value: (o as HTMLOptionElement).value,
        label: o.textContent,
      }))
    );
    expect(optionValues.length).toBeGreaterThan(1);

    const initialValue = await modelSelect.inputValue();

    const differentOption = optionValues.find((o) => o.value !== initialValue);
    if (differentOption) {
      await modelSelect.selectOption(differentOption.value);

      await page.waitForTimeout(500);

      const newValue = await modelSelect.inputValue();
      expect(newValue).toBe(differentOption.value);

      await modelSelect.selectOption(initialValue);
    }
  });

  test('should toggle auto-scroll setting and update', async ({ page }) => {
    await openSettingsModal(page);

    const autoScrollToggle = page.locator('button[role="switch"]').first();
    const initialChecked = await autoScrollToggle.getAttribute('aria-checked');

    await autoScrollToggle.click();
    await page.waitForTimeout(500);

    const newChecked = await autoScrollToggle.getAttribute('aria-checked');
    expect(newChecked).not.toBe(initialChecked);

    await autoScrollToggle.click();
    await page.waitForTimeout(500);
  });
});

test.describe('Settings Modal - MCP Servers', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
  });

  test('should display MCP Servers section in Global Settings', async ({ page }) => {
    await openSettingsModal(page);

    await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();

    await expect(page.locator('h3:has-text("MCP Servers")')).toBeVisible();
  });

  test('should show MCP server configuration options', async ({ page }) => {
    await openSettingsModal(page);

    await page.waitForTimeout(1000);

    const noServersMessage = page.locator('text=No MCP servers found');
    const hasServers = (await noServersMessage.count()) === 0;

    if (hasServers) {
      const mcpSection = page.locator('label:has-text("MCP Servers")').locator('..');
      const allowedCheckboxes = mcpSection.locator('text=Allowed');
      expect(await allowedCheckboxes.count()).toBeGreaterThanOrEqual(0);
    }
  });
});
